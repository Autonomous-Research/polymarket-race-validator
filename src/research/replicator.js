'use strict';

const { buildMarketRecords } = require('./analyze');
const { EXCLUDED_MARKET_TYPES, baseStrategy, findSignal } = require('./backtest');
const { CLOB_API, getJson, iso, pct, sum } = require('./common');
const { collectTapeWindow } = require('./tape');

const DEFAULT_PAPER_CONFIG = {
    mode: 'PAPER_ONLY',
    bankrollUsdc: 10_000,
    maxOrderUsdc: 100,
    maxOrderBankrollPct: 0.5,
    maxEventBankrollPct: 1,
    maxPortfolioBankrollPct: 5,
    signalMaxAgeSeconds: 600,
    targetCopyLagSeconds: 60,
    maxAdverseMove: 0.05,
    executionMode: 'MARKETABLE_LIMIT_FOK',
    requirePostOnly: false,
    cancelAfterSeconds: 30
};

function buildReplicatorConfig(wallet, overrides = {}) {
    const strategy = baseStrategy();
    const strategyOverrides = overrides.strategy || {};
    return {
        generatedAt: new Date().toISOString(),
        targetWallet: wallet,
        ...DEFAULT_PAPER_CONFIG,
        ...overrides,
        strategy: {
            signalSource: strategy.signalSource,
            thresholdUsdc: strategy.thresholdUsdc,
            concentration: strategy.concentration,
            allowedDisciplines: strategy.disciplines,
            excludedMarketTypes: strategy.excludedMarketTypes,
            minPrice: strategy.minPrice,
            maxPrice: strategy.maxPrice,
            minimumTakerBurst60Share: 0.8,
            avoidCorrelatedEventExposure: strategy.avoidCorrelatedEventExposure,
            ...strategyOverrides
        },
        mode: 'PAPER_ONLY'
    };
}

function bestPrice(levels, side) {
    const prices = (levels || []).map((level) => Number(level.price)).filter(Number.isFinite);
    if (!prices.length) return null;
    return side === 'bid' ? Math.max(...prices) : Math.min(...prices);
}

function roundToTick(value, tickSize) {
    const decimals = String(tickSize).includes('.') ? String(tickSize).split('.')[1].length : 0;
    return Number((Math.floor((value + 1e-12) / tickSize) * tickSize).toFixed(decimals));
}

function postOnlyLimit(triggerPrice, book, maxAdverseMove = DEFAULT_PAPER_CONFIG.maxAdverseMove) {
    const tickSize = Number(book.tick_size || book.tickSize || 0.01);
    const bestBid = bestPrice(book.bids, 'bid');
    const bestAsk = bestPrice(book.asks, 'ask');
    if (bestAsk === null) return { eligible: false, reason: 'NO_ASK', bestBid, bestAsk, tickSize };
    if (bestAsk > triggerPrice + maxAdverseMove) {
        return { eligible: false, reason: 'PRICE_RAN_AWAY', bestBid, bestAsk, tickSize };
    }
    const belowAsk = bestAsk - tickSize;
    const improveBid = bestBid === null ? triggerPrice : bestBid + tickSize;
    const limitPrice = roundToTick(Math.min(triggerPrice, belowAsk, improveBid), tickSize);
    if (!(limitPrice > 0 && limitPrice < bestAsk)) {
        return { eligible: false, reason: 'NO_POST_ONLY_PRICE', bestBid, bestAsk, tickSize };
    }
    return { eligible: true, limitPrice, bestBid, bestAsk, tickSize };
}

function marketableLimit(
    triggerPrice,
    book,
    maxAdverseMove = DEFAULT_PAPER_CONFIG.maxAdverseMove,
    requiredNotionalUsdc = 0
) {
    const tickSize = Number(book.tick_size || book.tickSize || 0.01);
    const bestBid = bestPrice(book.bids, 'bid');
    const bestAsk = bestPrice(book.asks, 'ask');
    if (bestAsk === null) return { eligible: false, reason: 'NO_ASK', bestBid, bestAsk, tickSize };
    if (bestAsk > triggerPrice + maxAdverseMove) {
        return { eligible: false, reason: 'PRICE_RAN_AWAY', bestBid, bestAsk, tickSize };
    }
    const availableAskShares = sum((book.asks || []).filter((level) =>
        Number(level.price) <= bestAsk + 1e-12), (level) => Number(level.size || 0));
    const availableAskNotionalUsdc = availableAskShares * bestAsk;
    if (requiredNotionalUsdc > 0 && availableAskNotionalUsdc < requiredNotionalUsdc) {
        return {
            eligible: false,
            reason: 'INSUFFICIENT_ASK_DEPTH',
            bestBid,
            bestAsk,
            tickSize,
            availableAskShares,
            availableAskNotionalUsdc
        };
    }
    return {
        eligible: true,
        limitPrice: bestAsk,
        bestBid,
        bestAsk,
        tickSize,
        availableAskShares,
        availableAskNotionalUsdc
    };
}

function median(values) {
    const ordered = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!ordered.length) return NaN;
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function targetSignalFeatures(market, signal, snapshot) {
    const observed = market._trades.filter((trade) => trade.timestamp <= signal.timestamp);
    const sameBuys = observed.filter((trade) => trade.outcome === signal.outcome && trade.side === 'BUY');
    const takerBuys = sameBuys.filter((trade) => trade.liquidityRole === 'TAKER');
    const makerBuys = sameBuys.filter((trade) => trade.liquidityRole === 'MAKER');
    const takerGross = sum(takerBuys, (trade) => trade.quoteNotional);
    const makerGross = sum(makerBuys, (trade) => trade.quoteNotional);
    const triggerFill = sum(observed.filter((trade) =>
        trade.transactionHash === signal.triggerHash
        && trade.outcome === signal.outcome
        && trade.side === 'BUY'), (trade) => trade.quoteNotional);
    const burst60 = sum(takerBuys.filter((trade) =>
        trade.timestamp >= signal.timestamp - 60), (trade) => trade.quoteNotional);
    const firstTradeTimestamp = observed.length
        ? Math.min(...observed.map((trade) => trade.timestamp))
        : signal.timestamp;
    const deposits = (snapshot.activity || []).filter((row) =>
        row.type === 'DEPOSIT' && Number(row.timestamp) <= signal.timestamp);
    const latestDeposit = deposits.sort((a, b) => b.timestamp - a.timestamp)[0];
    return {
        triggerPrice: signal.triggerPrice,
        concentration: signal.concentration,
        triggerFillShare: takerGross ? triggerFill / takerGross : 0,
        takerBurst60Share: takerGross ? burst60 / takerGross : 0,
        makerShareBeforeSignal: takerGross + makerGross ? makerGross / (takerGross + makerGross) : 0,
        signalAgeSeconds: signal.timestamp - firstTradeTimestamp,
        preMomentum300: NaN,
        externalFlow300: NaN,
        pregame: Number(Boolean(market.gameStartTimestamp && signal.timestamp < market.gameStartTimestamp)),
        depositLagSeconds: latestDeposit ? signal.timestamp - Number(latestDeposit.timestamp) : NaN,
        discipline: market.discipline,
        marketType: market.marketType
    };
}

function publicSignalFeatures(rows, market, signal, targetWallet) {
    const tokens = market.metadata?.tokens || [];
    const outcomeIndex = tokens.findIndex((token) => token.outcome === signal.outcome);
    if (outcomeIndex < 0) return { preMomentum300: NaN, externalFlow300: NaN };
    const tokenIndexes = new Map(tokens.map((token, index) => [String(token.token_id), index]));
    const target = targetWallet.toLowerCase();
    const normalized = rows.map((row) => {
        const rowOutcome = tokenIndexes.get(String(row.asset));
        if (rowOutcome === undefined || String(row.proxyWallet || '').toLowerCase() === target) return null;
        const aligned = rowOutcome === outcomeIndex ? 1 : -1;
        return {
            timestamp: Number(row.timestamp),
            price: aligned === 1 ? Number(row.price) : 1 - Number(row.price),
            direction: (row.side === 'SELL' ? -1 : 1) * aligned,
            shares: Number(row.size || 0)
        };
    }).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);

    function markAt(timestamp) {
        const eligible = normalized.filter((row) => row.timestamp <= timestamp);
        if (!eligible.length) return NaN;
        const lastTimestamp = eligible.at(-1).timestamp;
        return median(eligible.filter((row) => row.timestamp === lastTimestamp).map((row) => row.price));
    }

    const flow = normalized.filter((row) =>
        row.timestamp >= signal.timestamp - 300 && row.timestamp < signal.timestamp);
    const gross = sum(flow, (row) => row.shares);
    const net = sum(flow, (row) => row.direction * row.shares);
    const latest = markAt(signal.timestamp - 1);
    const earlier = markAt(signal.timestamp - 300);
    return {
        preMomentum300: Number.isFinite(latest) && Number.isFinite(earlier) ? latest - earlier : NaN,
        externalFlow300: gross ? net / gross : NaN
    };
}

function scoreEdgeModel(features, model) {
    let score = Number(model.intercept || 0);
    for (const feature of model.numeric || []) {
        let value = Number(features[feature.name]);
        if (!Number.isFinite(value)) value = Number(feature.imputeMedian);
        const scale = Number(feature.scale) || 1;
        score += ((value - Number(feature.mean)) / scale) * Number(feature.coefficient);
    }
    for (const feature of model.categorical || []) {
        const value = String(features[feature.name] ?? '');
        const match = feature.values.find((candidate) => candidate.value === value);
        score += Number(match?.coefficient ?? feature.unknownCoefficient ?? 0);
    }
    return 1 / (1 + Math.exp(-score));
}

function feeAdjustedPrice(price, feeRate = 0.03) {
    return price + feeRate * price * (1 - price);
}

function liveEligibility(market, signal, config, nowTimestamp) {
    if (!config.strategy.allowedDisciplines.includes(market.discipline)) return 'DISCIPLINE_EXCLUDED';
    if (config.strategy.excludedMarketTypes.includes(market.marketType)) return 'MARKET_TYPE_EXCLUDED';
    if (!signal) return 'NO_CONVICTION_SIGNAL';
    if (signal.triggerPrice < config.strategy.minPrice || signal.triggerPrice > config.strategy.maxPrice) return 'TRIGGER_PRICE_OUT_OF_RANGE';
    if (nowTimestamp < signal.timestamp + config.targetCopyLagSeconds) return 'COPY_LAG_NOT_ELAPSED';
    if (nowTimestamp - signal.timestamp > config.signalMaxAgeSeconds) return 'STALE_SIGNAL';
    if (market.metadata?.closed || !market.metadata?.acceptingOrders) return 'MARKET_NOT_ACCEPTING_ORDERS';
    if (market.resolvedWinner) return 'MARKET_RESOLVED';
    return null;
}

function activeEventKeys(markets, snapshot) {
    const activeConditions = new Set((snapshot.positions || [])
        .filter((position) => Number(position.size || 0) > 0)
        .map((position) => position.conditionId));
    return new Set(markets
        .filter((market) => activeConditions.has(market.conditionId) && market.eventKey)
        .map((market) => market.eventKey));
}

function candidateRows(snapshot, enrichment, config, nowTimestamp) {
    const markets = buildMarketRecords(snapshot, enrichment);
    const strategy = baseStrategy({
        thresholdUsdc: config.strategy.thresholdUsdc,
        concentration: config.strategy.concentration,
        disciplines: config.strategy.allowedDisciplines,
        excludedMarketTypes: config.strategy.excludedMarketTypes
    });
    const occupiedEvents = new Set([
        ...(config.openEventKeys || []),
        ...(config.strategy.avoidCorrelatedEventExposure ? activeEventKeys(markets, snapshot) : [])
    ]);
    return {
        markets,
        rows: markets.map((market) => {
            const signal = findSignal(market, strategy);
            let rejection = liveEligibility(market, signal, config, nowTimestamp);
            if (!rejection && market.eventKey && occupiedEvents.has(market.eventKey)) rejection = 'CORRELATED_EVENT_ALREADY_OPEN';
            const token = market.metadata?.tokens?.find((item) => item.outcome === signal?.outcome);
            if (!rejection && !token?.token_id) rejection = 'TOKEN_NOT_FOUND';
            return { market, signal, token, rejection };
        })
    };
}

function rejectionSummary(rows) {
    const counts = new Map();
    for (const row of rows) {
        const key = row.rejection || 'ELIGIBLE_BEFORE_BOOK';
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].map(([reason, markets]) => ({ reason, markets }))
        .sort((a, b) => b.markets - a.markets);
}

async function generatePaperIntents(snapshot, enrichment, options = {}) {
    const nowTimestamp = Number(options.nowTimestamp || Math.floor(Date.now() / 1000));
    const edgeModel = options.model || null;
    const config = buildReplicatorConfig(snapshot.wallet, {
        ...options.config,
        strategy: {
            ...(options.config?.strategy || {}),
            minimumTakerBurst60Share: Number(
                edgeModel?.decision?.minimumTakerBurst60Share ?? 0.8
            )
        },
        edgeModel: edgeModel ? {
            version: edgeModel.version,
            trainedThrough: edgeModel.training?.lastSignal,
            minimumPredictedEdge: edgeModel.decision?.minimumPredictedEdge
        } : null
    });
    const { rows } = candidateRows(snapshot, enrichment, config, nowTimestamp);
    const eligible = rows.filter((row) => !row.rejection)
        .sort((a, b) => b.signal.targetOutcomeNetBuyUsdc - a.signal.targetOutcomeNetBuyUsdc);
    const orderUsdc = Math.min(
        config.maxOrderUsdc,
        config.bankrollUsdc * config.maxOrderBankrollPct / 100,
        config.bankrollUsdc * config.maxEventBankrollPct / 100
    );
    const maxPortfolioUsdc = config.bankrollUsdc * config.maxPortfolioBankrollPct / 100;
    const maxIntents = Math.floor(maxPortfolioUsdc / orderUsdc);
    const selected = [];
    const deferred = [];
    const selectedEvents = new Set(config.openEventKeys || []);
    for (const row of eligible) {
        if (selected.length >= maxIntents) {
            deferred.push({ ...row, rejection: 'PORTFOLIO_CAP' });
            continue;
        }
        if (row.market.eventKey && selectedEvents.has(row.market.eventKey)) {
            deferred.push({ ...row, rejection: 'CORRELATED_EVENT_ALREADY_SELECTED' });
            continue;
        }
        selected.push(row);
        if (row.market.eventKey) selectedEvents.add(row.market.eventKey);
    }

    const evaluated = await Promise.all(selected.map(async (row) => {
        try {
            if (!edgeModel) return { ...row, rejection: 'EDGE_MODEL_NOT_LOADED' };
            const targetFeatures = targetSignalFeatures(row.market, row.signal, snapshot);
            if (targetFeatures.takerBurst60Share < config.strategy.minimumTakerBurst60Share) {
                return { ...row, rejection: 'TAKER_BURST_TOO_SLOW', model: { features: targetFeatures } };
            }
            const [book, publicRows] = await Promise.all([
                getJson(`${CLOB_API}/book`, { token_id: row.token.token_id }),
                collectTapeWindow(
                    row.market.conditionId,
                    row.signal.timestamp - 3_600,
                    row.signal.timestamp,
                    1
                ).catch(() => [])
            ]);
            const limit = marketableLimit(
                row.signal.triggerPrice,
                book,
                config.maxAdverseMove,
                orderUsdc
            );
            if (!limit.eligible) return { ...row, rejection: limit.reason, book: limit };
            const modelFeatures = {
                ...targetFeatures,
                ...publicSignalFeatures(publicRows, row.market, row.signal, snapshot.wallet)
            };
            const predictedWinProbability = scoreEdgeModel(modelFeatures, edgeModel);
            const feeRate = Number(edgeModel.decision?.feeRate ?? 0.03);
            const allInPrice = feeAdjustedPrice(limit.limitPrice, feeRate);
            const predictedEdge = predictedWinProbability - allInPrice;
            const minimumPredictedEdge = Number(edgeModel.decision?.minimumPredictedEdge ?? 0.05);
            if (predictedEdge < minimumPredictedEdge) {
                return {
                    ...row,
                    rejection: 'MODEL_EDGE_TOO_LOW',
                    book: limit,
                    model: { features: modelFeatures, predictedWinProbability, allInPrice, predictedEdge }
                };
            }
            return {
                ...row,
                book: limit,
                intent: {
                    mode: 'PAPER_ONLY',
                    action: 'PLACE_MARKETABLE_LIMIT_BUY',
                    timeInForce: 'FOK',
                    createdAt: new Date(nowTimestamp * 1000).toISOString(),
                    expiresAt: new Date((nowTimestamp + config.cancelAfterSeconds) * 1000).toISOString(),
                    conditionId: row.market.conditionId,
                    tokenId: row.token.token_id,
                    title: row.market.title,
                    eventKey: row.market.eventKey,
                    discipline: row.market.discipline,
                    marketType: row.market.marketType,
                    outcome: row.signal.outcome,
                    limitPrice: limit.limitPrice,
                    estimatedAllInPrice: allInPrice,
                    notionalUsdc: orderUsdc,
                    targetSignal: {
                        time: iso(row.signal.timestamp),
                        ageSeconds: nowTimestamp - row.signal.timestamp,
                        grossAggressiveBuyUsdc: row.signal.targetGrossBuyUsdc,
                        netOutcomeBuyUsdc: row.signal.targetOutcomeNetBuyUsdc,
                        concentrationPct: row.signal.concentration * 100,
                        triggerPrice: row.signal.triggerPrice,
                        transactionHash: row.signal.triggerHash
                    },
                    marketCheck: {
                        bestBid: limit.bestBid,
                        bestAsk: limit.bestAsk,
                        tickSize: limit.tickSize,
                        availableAskShares: limit.availableAskShares,
                        availableAskNotionalUsdc: limit.availableAskNotionalUsdc,
                        adverseMoveFromTrigger: limit.bestAsk - row.signal.triggerPrice
                    },
                    edgeModel: {
                        version: edgeModel.version,
                        features: modelFeatures,
                        predictedWinProbability,
                        predictedEdge,
                        minimumPredictedEdge
                    },
                    guards: [
                        'paper-only',
                        'marketable-limit-fok',
                        'five-cent-max-adverse-move',
                        'displayed-ask-depth',
                        'rapid-taker-burst',
                        'minimum-model-edge',
                        'one-condition-per-correlated-event'
                    ]
                }
            };
        } catch (error) {
            return { ...row, rejection: 'ORDER_BOOK_UNAVAILABLE', error: error.message };
        }
    }));
    const intents = evaluated.filter((row) => row.intent).map((row) => row.intent);
    const finalRows = [
        ...rows.filter((row) => row.rejection),
        ...deferred,
        ...evaluated.filter((row) => row.rejection)
    ];

    return {
        generatedAt: new Date(nowTimestamp * 1000).toISOString(),
        mode: 'PAPER_ONLY',
        targetWallet: snapshot.wallet,
        config,
        candidatesBeforeBook: eligible.length,
        intents,
        rejectionSummary: rejectionSummary(finalRows),
        risk: {
            proposedNotionalUsdc: sum(intents, (intent) => intent.notionalUsdc),
            proposedPortfolioPct: pct(sum(intents, (intent) => intent.notionalUsdc), config.bankrollUsdc),
            maxPortfolioBankrollPct: config.maxPortfolioBankrollPct,
            withinPortfolioCap: sum(intents, (intent) => intent.notionalUsdc)
                <= config.bankrollUsdc * config.maxPortfolioBankrollPct / 100
        },
        disclaimer: 'Research simulation only. No order is signed or submitted.'
    };
}

function buildHistoricalAudit(analysis, edgeAnalysis = null, edgeModel = null) {
    if (edgeAnalysis) {
        return {
            methodology: edgeAnalysis.methodology,
            strategy: {
                signal: edgeAnalysis.methodology.signal,
                execution: edgeAnalysis.methodology.externalExecution,
                excludedMarketTypes: EXCLUDED_MARKET_TYPES,
                model: edgeModel ? {
                    version: edgeModel.version,
                    decision: edgeModel.decision,
                    training: edgeModel.training
                } : null
            },
            fixedExternalTapeBacktest: edgeAnalysis.fixedExternalTapeBacktest,
            universeSensitivity: edgeAnalysis.universeSensitivity,
            bo1ClassificationSensitivity: edgeAnalysis.bo1ClassificationSensitivity,
            subgroupChronology: edgeAnalysis.subgroupChronology,
            fixedTestBootstrap: edgeAnalysis.fixedTestBootstrap,
            fixedTestDayClusterBootstrap: edgeAnalysis.fixedTestDayClusterBootstrap,
            executionSelectionAudit: edgeAnalysis.executionSelectionAudit,
            walkForwardModel: edgeAnalysis.walkForwardModel,
            status: 'HISTORICAL_SIMULATION'
        };
    }
    const proposed = analysis.backtest.proposed.taker;
    return {
        methodology: analysis.backtest.methodology,
        strategy: proposed.strategy,
        train: proposed.train,
        test: proposed.test,
        all: proposed.all,
        signals: proposed.results.map((result) => ({
            ...result,
            signalTime: iso(result.signalTimestamp),
            executionTime: iso(result.executionTimestamp),
            status: 'HISTORICAL_SIMULATION'
        }))
    };
}

module.exports = {
    DEFAULT_PAPER_CONFIG,
    activeEventKeys,
    bestPrice,
    buildHistoricalAudit,
    buildReplicatorConfig,
    candidateRows,
    feeAdjustedPrice,
    generatePaperIntents,
    liveEligibility,
    marketableLimit,
    postOnlyLimit,
    publicSignalFeatures,
    roundToTick,
    scoreEdgeModel,
    targetSignalFeatures
};
