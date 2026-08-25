'use strict';

const { findSignal } = require('./backtest');
const { DATA_API, GAMMA_API, getJson, mapLimit, uniqueBy } = require('./common');

const DEFAULT_TAPE_OPTIONS = {
    seedThresholdUsdc: 25_000,
    seedConcentration: 0.7,
    preWindowSeconds: 3_600,
    postWindowSeconds: 1_800,
    minimumCashUsdc: 1,
    concurrency: 8
};

function seedStrategy(options = {}) {
    return {
        signalSource: 'taker',
        thresholdUsdc: options.seedThresholdUsdc ?? DEFAULT_TAPE_OPTIONS.seedThresholdUsdc,
        concentration: options.seedConcentration ?? DEFAULT_TAPE_OPTIONS.seedConcentration,
        minSingleFillUsdc: 0
    };
}

async function collectTapeWindow(conditionId, start, end, minimumCashUsdc) {
    const limit = 10_000;
    const rows = await getJson(`${DATA_API}/trades`, {
        market: conditionId,
        takerOnly: true,
        start,
        end,
        limit,
        offset: 0,
        sortDirection: 'ASC',
        filterType: 'CASH',
        filterAmount: minimumCashUsdc
    });
    if (!Array.isArray(rows)) throw new Error('Market tape endpoint returned a non-array response');
    if (rows.length < limit || end - start <= 1) return rows;

    const middle = Math.floor((start + end) / 2);
    const [left, right] = await Promise.all([
        collectTapeWindow(conditionId, start, middle, minimumCashUsdc),
        collectTapeWindow(conditionId, middle + 1, end, minimumCashUsdc)
    ]);
    return uniqueBy([...left, ...right], (row) => [
        row.transactionHash,
        row.proxyWallet,
        row.asset,
        row.side,
        row.timestamp,
        row.price,
        row.size
    ].join('|'));
}

async function collectGammaResolution(conditionId) {
    const rows = await getJson(`${GAMMA_API}/markets`, {
        condition_ids: conditionId,
        closed: true,
        limit: 1
    });
    const market = Array.isArray(rows)
        ? rows.find((row) => row.conditionId === conditionId)
        : null;
    return market ? {
        marketId: market.id,
        closedTime: market.closedTime || null,
        endDate: market.endDate || null,
        updatedAt: market.updatedAt || null
    } : null;
}

function compactTapeRows(rows, market, targetWallet) {
    const tokens = market.metadata?.tokens || [];
    const tokenIndexes = new Map(tokens.map((token, index) => [String(token.token_id), index]));
    const outcomeIndexes = new Map(tokens.map((token, index) => [String(token.outcome), index]));
    const target = targetWallet.toLowerCase();
    const wallets = [];
    const walletIndexes = new Map();

    function walletIndex(address) {
        const normalized = String(address || '').toLowerCase();
        if (!walletIndexes.has(normalized)) {
            walletIndexes.set(normalized, wallets.length);
            wallets.push(normalized);
        }
        return walletIndexes.get(normalized);
    }

    const compact = rows.map((row) => {
        const outcomeIndex = tokenIndexes.get(String(row.asset))
            ?? outcomeIndexes.get(String(row.outcome));
        if (outcomeIndex === undefined) return null;
        return [
            Number(row.timestamp),
            outcomeIndex,
            row.side === 'SELL' ? -1 : 1,
            Number(row.price),
            Number(row.size),
            walletIndex(row.proxyWallet)
        ];
    }).filter((row) => row
        && Number.isFinite(row[0])
        && Number.isFinite(row[3])
        && Number.isFinite(row[4]))
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return {
        targetWalletIndex: walletIndexes.get(target) ?? null,
        wallets,
        rows: compact
    };
}

async function collectMarketTapes(markets, targetWallet, progress = console.log, overrides = {}) {
    const options = { ...DEFAULT_TAPE_OPTIONS, ...overrides };
    const candidates = markets.map((market) => ({
        market,
        signal: findSignal(market, seedStrategy(options))
    })).filter(({ market, signal }) => signal && (market.metadata?.tokens || []).length >= 2);

    let lastReported = 0;
    const tapes = await mapLimit(candidates, options.concurrency, async ({ market, signal }) => {
        const start = Math.max(1, signal.timestamp - options.preWindowSeconds);
        const end = signal.timestamp + options.postWindowSeconds;
        try {
            const [rows, resolution] = await Promise.all([
                collectTapeWindow(
                    market.conditionId,
                    start,
                    end,
                    options.minimumCashUsdc
                ),
                collectGammaResolution(market.conditionId).catch(() => null)
            ]);
            const compact = compactTapeRows(rows, market, targetWallet);
            return {
                conditionId: market.conditionId,
                eventKey: market.eventKey || market.conditionId,
                seedSignal: {
                    timestamp: signal.timestamp,
                    outcome: signal.outcome,
                    concentration: signal.concentration,
                    targetGrossBuyUsdc: signal.targetGrossBuyUsdc,
                    targetOutcomeGrossBuyUsdc: signal.targetOutcomeGrossBuyUsdc,
                    targetOutcomeNetBuyUsdc: signal.targetOutcomeNetBuyUsdc,
                    triggerPrice: signal.triggerPrice,
                    triggerHash: signal.triggerHash
                },
                seedSignalTimestamp: signal.timestamp,
                windowStart: start,
                windowEnd: end,
                resolution,
                tokens: market.metadata.tokens.map((token) => ({
                    tokenId: String(token.token_id),
                    outcome: token.outcome
                })),
                targetWalletIndex: compact.targetWalletIndex,
                wallets: compact.wallets,
                rows: compact.rows
            };
        } catch (error) {
            return {
                conditionId: market.conditionId,
                eventKey: market.eventKey || market.conditionId,
                seedSignal: {
                    timestamp: signal.timestamp,
                    outcome: signal.outcome,
                    concentration: signal.concentration,
                    targetGrossBuyUsdc: signal.targetGrossBuyUsdc,
                    targetOutcomeGrossBuyUsdc: signal.targetOutcomeGrossBuyUsdc,
                    targetOutcomeNetBuyUsdc: signal.targetOutcomeNetBuyUsdc,
                    triggerPrice: signal.triggerPrice,
                    triggerHash: signal.triggerHash
                },
                seedSignalTimestamp: signal.timestamp,
                windowStart: start,
                windowEnd: end,
                resolution: null,
                tokens: market.metadata.tokens.map((token) => ({
                    tokenId: String(token.token_id),
                    outcome: token.outcome
                })),
                targetWalletIndex: null,
                wallets: [],
                rows: [],
                error: error.message
            };
        }
    }, (completed, total) => {
        if (completed === total || completed - lastReported >= 20) {
            lastReported = completed;
            progress(`Public taker tape: ${completed}/${total}`);
        }
    });

    return {
        generatedAt: new Date().toISOString(),
        source: `${DATA_API}/trades?takerOnly=true`,
        resolutionSource: `${GAMMA_API}/markets?condition_ids=<conditionId>&closed=true`,
        schema: '[timestamp, outcomeIndex, sideSign, price, shares, walletIndex]',
        targetWallet,
        options,
        candidates: tapes.length,
        successfulMarkets: tapes.filter((tape) => !tape.error && tape.rows.length).length,
        failedMarkets: tapes.filter((tape) => tape.error).length,
        marketsWithGammaClosedTime: tapes.filter((tape) => tape.resolution?.closedTime).length,
        rows: tapes.reduce((total, tape) => total + tape.rows.length, 0),
        tapes
    };
}

module.exports = {
    DEFAULT_TAPE_OPTIONS,
    collectMarketTapes,
    collectGammaResolution,
    collectTapeWindow,
    compactTapeRows,
    seedStrategy
};
