'use strict';

const path = require('node:path');
const {
    BLOCKSCOUT_API,
    getJson,
    mapLimit,
    readJson,
    sleep,
    writeJson
} = require('./common');

const ORDER_FIELDS = [
    'salt', 'maker', 'signer', 'tokenId', 'makerAmount', 'takerAmount',
    'side', 'signatureType', 'timestamp', 'metadata', 'builder', 'signature'
];
const SIDE = { 0: 'BUY', 1: 'SELL' };

function lower(value) {
    return String(value || '').toLowerCase();
}

function numeric(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function units(value) {
    const parsed = numeric(value);
    return parsed === null ? null : parsed / 1e6;
}

function orderFromArray(values) {
    if (!Array.isArray(values) || values.length < ORDER_FIELDS.length) return null;
    const order = Object.fromEntries(ORDER_FIELDS.map((field, index) => [field, values[index]]));
    order.sideCode = numeric(order.side);
    order.side = SIDE[order.sideCode] || `UNKNOWN_${order.sideCode}`;
    order.signatureType = numeric(order.signatureType);
    order.timestampMs = numeric(order.timestamp);
    order.makerAmountUnits = units(order.makerAmount);
    order.takerAmountUnits = units(order.takerAmount);
    delete order.signature;
    return order;
}

function orderPrice(order) {
    if (!order || !order.makerAmountUnits || !order.takerAmountUnits) return null;
    return order.side === 'BUY'
        ? order.makerAmountUnits / order.takerAmountUnits
        : order.takerAmountUnits / order.makerAmountUnits;
}

function targetPriceFromMaker(takerOrder, makerOrder) {
    const makerPrice = orderPrice(makerOrder);
    if (makerPrice === null) return null;
    const sameToken = String(takerOrder.tokenId) === String(makerOrder.tokenId);
    if (takerOrder.side === 'BUY' && makerOrder.side === 'SELL' && sameToken) return makerPrice;
    if (takerOrder.side === 'BUY' && makerOrder.side === 'BUY' && !sameToken) return 1 - makerPrice;
    if (takerOrder.side === 'SELL' && makerOrder.side === 'BUY' && sameToken) return makerPrice;
    if (takerOrder.side === 'SELL' && makerOrder.side === 'SELL' && !sameToken) return 1 - makerPrice;
    return null;
}

function targetFillFromMaker(takerOrder, makerOrder, makerFillRaw) {
    const fillUnits = units(makerFillRaw);
    const targetPrice = targetPriceFromMaker(takerOrder, makerOrder);
    if (fillUnits === null || targetPrice === null) return null;
    const sameToken = String(takerOrder.tokenId) === String(makerOrder.tokenId);
    let targetShares;
    if (takerOrder.side === 'BUY' && makerOrder.side === 'SELL' && sameToken) {
        targetShares = fillUnits;
    } else if (takerOrder.side === 'BUY' && makerOrder.side === 'BUY' && !sameToken) {
        targetShares = fillUnits / orderPrice(makerOrder);
    } else if (takerOrder.side === 'SELL' && makerOrder.side === 'BUY' && sameToken) {
        targetShares = fillUnits / orderPrice(makerOrder);
    } else if (takerOrder.side === 'SELL' && makerOrder.side === 'SELL' && !sameToken) {
        targetShares = fillUnits;
    } else {
        return null;
    }
    return {
        targetPrice,
        targetShares,
        targetNotionalUsdc: targetShares * targetPrice,
        matchType: takerOrder.side === makerOrder.side
            ? (takerOrder.side === 'BUY' ? 'MINT' : 'MERGE')
            : 'COMPLEMENTARY'
    };
}

function orderAgeSeconds(blockTimestamp, timestampMs) {
    if (!timestampMs) return null;
    const orderSeconds = timestampMs > 1e11 ? timestampMs / 1000 : timestampMs;
    return new Date(blockTimestamp).getTime() / 1000 - orderSeconds;
}

function parameterMap(transaction) {
    return new Map((transaction.decoded_input?.parameters || []).map((parameter) => [
        parameter.name,
        parameter.value
    ]));
}

function quantile(values, probability) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * probability;
    const low = Math.floor(position);
    const fraction = position - low;
    return sorted[low + 1] === undefined
        ? sorted[low]
        : sorted[low] + fraction * (sorted[low + 1] - sorted[low]);
}

function parseTriggerTransaction(transaction, tape) {
    const params = parameterMap(transaction);
    const takerOrder = orderFromArray(params.get('takerOrder'));
    const makerOrders = (params.get('makerOrders') || []).map(orderFromArray);
    const makerFillAmounts = params.get('makerFillAmounts') || [];
    if (transaction.method !== 'matchOrders' || !takerOrder || !makerOrders.length) {
        throw new Error(`Unsupported decoded call: ${transaction.method || 'unknown'}`);
    }
    if (makerOrders.length !== makerFillAmounts.length) {
        throw new Error('Decoded maker order and fill arrays have different lengths');
    }

    const targetWallet = lower(tape.targetWallet);
    const targetToken = tape.tokens.find((token) => token.outcome === tape.seedSignal.outcome)?.tokenId;
    const takerIsTarget = lower(takerOrder.maker) === targetWallet;
    const fills = makerOrders.map((order, index) => {
        const derived = targetFillFromMaker(takerOrder, order, makerFillAmounts[index]);
        return {
            maker: lower(order.maker),
            signer: lower(order.signer),
            tokenId: String(order.tokenId),
            side: order.side,
            signatureType: order.signatureType,
            orderTimestampMs: order.timestampMs,
            restingAgeSeconds: orderAgeSeconds(transaction.timestamp, order.timestampMs),
            orderPrice: orderPrice(order),
            makerFillAmountUnits: units(makerFillAmounts[index]),
            ...derived
        };
    });
    const validFills = fills.filter((fill) => Number.isFinite(fill.targetNotionalUsdc));
    if (validFills.length !== fills.length) {
        throw new Error('Unsupported maker/taker pairing in decoded matchOrders call');
    }
    const notional = validFills.reduce((total, fill) => total + fill.targetNotionalUsdc, 0);
    const shares = validFills.reduce((total, fill) => total + fill.targetShares, 0);
    const prices = validFills.map((fill) => fill.targetPrice);
    const makerWeights = new Map();
    for (const fill of validFills) {
        makerWeights.set(fill.maker, (makerWeights.get(fill.maker) || 0) + fill.targetNotionalUsdc);
    }
    const weights = [...makerWeights.values()];
    const matchedTargetNotionalUsdc = takerOrder.side === 'BUY'
        ? units(params.get('takerFillAmount'))
        : notional;
    const weightedTargetPrice = shares ? notional / shares : null;
    const uniquePriceLevels = [...new Set(prices.map((price) => price.toFixed(6)))];
    const restingAges = fills.map((fill) => fill.restingAgeSeconds).filter(Number.isFinite);

    return {
        transactionHash: transaction.hash,
        conditionId: tape.conditionId,
        eventKey: tape.eventKey,
        signalTimestamp: tape.seedSignal.timestamp,
        signalOutcome: tape.seedSignal.outcome,
        publicTriggerPrice: tape.seedSignal.triggerPrice,
        targetTokenId: targetToken ? String(targetToken) : null,
        sourceUrl: `${BLOCKSCOUT_API}/transactions/${transaction.hash}`,
        blockNumber: transaction.block_number,
        blockTimestamp: transaction.timestamp,
        status: transaction.status,
        exchange: lower(transaction.to?.hash),
        operator: lower(transaction.from?.hash),
        method: transaction.method,
        gasUsed: numeric(transaction.gas_used),
        takerIsTarget,
        taker: {
            maker: lower(takerOrder.maker),
            signer: lower(takerOrder.signer),
            tokenId: String(takerOrder.tokenId),
            tokenMatchesSignal: String(takerOrder.tokenId) === String(targetToken),
            side: takerOrder.side,
            signatureType: takerOrder.signatureType,
            orderTimestampMs: takerOrder.timestampMs,
            orderAgeSeconds: orderAgeSeconds(transaction.timestamp, takerOrder.timestampMs),
            limitPrice: orderPrice(takerOrder),
            fillMakerAmountUnits: units(params.get('takerFillAmount')),
            feeUnits: units(params.get('takerFeeAmount'))
        },
        sweep: {
            makerOrderCount: fills.length,
            uniqueMakers: makerWeights.size,
            uniqueSigners: new Set(fills.map((fill) => fill.signer)).size,
            uniquePriceLevels: uniquePriceLevels.length,
            minimumTargetPrice: prices.length ? Math.min(...prices) : null,
            maximumTargetPrice: prices.length ? Math.max(...prices) : null,
            priceRangeCents: prices.length ? (Math.max(...prices) - Math.min(...prices)) * 100 : null,
            weightedTargetPrice,
            priceImprovementVsLimitCents: weightedTargetPrice === null
                ? null
                : (orderPrice(takerOrder) - weightedTargetPrice) * 100,
            publicPriceDifferenceCents: weightedTargetPrice === null
                ? null
                : (weightedTargetPrice - Number(tape.seedSignal.triggerPrice)) * 100,
            targetShares: shares,
            targetNotionalUsdc: notional,
            takerFillNotionalUsdc: matchedTargetNotionalUsdc,
            notionalReconciliationPct: matchedTargetNotionalUsdc
                ? (notional - matchedTargetNotionalUsdc) / matchedTargetNotionalUsdc * 100
                : null,
            largestMakerNotionalShare: notional ? Math.max(...weights) / notional : null,
            makerNotionalHhi: notional
                ? weights.reduce((total, value) => total + (value / notional) ** 2, 0)
                : null,
            restingAgeMinSeconds: quantile(restingAges, 0),
            restingAgeMedianSeconds: quantile(restingAges, 0.5),
            restingAgeP90Seconds: quantile(restingAges, 0.9),
            restingAgeMaxSeconds: quantile(restingAges, 1),
            matchTypes: [...new Set(validFills.map((fill) => fill.matchType))],
            fills
        }
    };
}

async function collectTriggerTransactions(tapeData, progress = console.log, cachePath = null, overrides = {}) {
    const options = { concurrency: 2, requestDelayMs: 400, ...overrides };
    let cached = [];
    if (cachePath) {
        try {
            cached = (await readJson(cachePath)).transactions || [];
        } catch (_error) {
            cached = [];
        }
    }
    const cache = new Map(cached.filter((row) => !row.error).map((row) => [row.transactionHash, row]));
    let lastReported = 0;
    const transactions = await mapLimit(tapeData.tapes, options.concurrency, async (tape) => {
        const hash = tape.seedSignal?.triggerHash;
        if (!hash) return { conditionId: tape.conditionId, error: 'Missing trigger hash' };
        if (cache.has(hash)) return cache.get(hash);
        try {
            const transaction = await getJson(`${BLOCKSCOUT_API}/transactions/${hash}`);
            const parsed = parseTriggerTransaction(transaction, { ...tape, targetWallet: tapeData.targetWallet });
            await sleep(options.requestDelayMs);
            return parsed;
        } catch (error) {
            await sleep(options.requestDelayMs);
            return {
                transactionHash: hash,
                conditionId: tape.conditionId,
                eventKey: tape.eventKey,
                signalTimestamp: tape.seedSignal?.timestamp,
                error: error.message
            };
        }
    }, (completed, total) => {
        if (completed === total || completed - lastReported >= 10) {
            lastReported = completed;
            progress(`Trigger transactions: ${completed}/${total}`);
        }
    });
    const successful = transactions.filter((row) => !row.error);
    const output = {
        generatedAt: new Date().toISOString(),
        source: `${BLOCKSCOUT_API}/transactions/<triggerHash>`,
        contractReference: 'https://github.com/Polymarket/ctf-exchange-v2',
        targetWallet: tapeData.targetWallet,
        triggers: transactions.length,
        successful: successful.length,
        failed: transactions.length - successful.length,
        targetAsDecodedTaker: successful.filter((row) => row.takerIsTarget).length,
        options,
        transactions
    };
    if (cachePath) await writeJson(cachePath, output);
    return output;
}

async function main() {
    const root = path.resolve(__dirname, '../..');
    const tapePath = process.env.TAPE_PATH || path.join(root, 'research/djdjdjekekek/market_tape.json');
    const outputPath = process.env.TRIGGER_OUTPUT_PATH
        || path.join(root, 'research/djdjdjekekek/trigger_transactions.json');
    const tapeData = await readJson(tapePath);
    const output = await collectTriggerTransactions(tapeData, console.log, outputPath);
    console.log(`Decoded trigger transactions: ${output.successful}/${output.triggers} -> ${outputPath}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    collectTriggerTransactions,
    orderFromArray,
    orderPrice,
    parseTriggerTransaction,
    targetFillFromMaker,
    targetPriceFromMaker
};
