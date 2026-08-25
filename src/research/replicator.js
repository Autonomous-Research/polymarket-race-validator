'use strict';

const { buildMarketRecords } = require('./analyze');
const { baseStrategy, findSignal } = require('./backtest');
const { CLOB_API, getJson, iso, pct, sum } = require('./common');

const DEFAULT_PAPER_CONFIG = {
    mode: 'PAPER_ONLY',
    bankrollUsdc: 10_000,
    maxOrderUsdc: 100,
    maxOrderBankrollPct: 0.5,
    maxEventBankrollPct: 1,
    maxPortfolioBankrollPct: 5,
    signalMaxAgeSeconds: 600,
    targetCopyLagSeconds: 60,
    maxAdverseMove: 0.01,
    requirePostOnly: true,
    cancelAfterSeconds: 300
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
    const occupiedEvents = new Set(config.openEventKeys || []);
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
    const config = buildReplicatorConfig(snapshot.wallet, options.config);
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
            const book = await getJson(`${CLOB_API}/book`, { token_id: row.token.token_id });
            const limit = postOnlyLimit(row.signal.triggerPrice, book, config.maxAdverseMove);
            if (!limit.eligible) return { ...row, rejection: limit.reason, book: limit };
            return {
                ...row,
                book: limit,
                intent: {
                    mode: 'PAPER_ONLY',
                    action: 'PLACE_POST_ONLY_BUY',
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
                        adverseMoveFromTrigger: limit.bestAsk - row.signal.triggerPrice
                    },
                    guards: [
                        'paper-only',
                        'post-only',
                        'cancel-on-expiry',
                        'do-not-cross-best-ask',
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

function buildHistoricalAudit(analysis) {
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
    generatePaperIntents,
    liveEligibility,
    postOnlyLimit,
    roundToTick
};
