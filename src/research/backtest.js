'use strict';

const { mean, median, pct, quantile, sum } = require('./common');

const REPLICATION_DISCIPLINES = [
    'Tennis',
    'Soccer',
    'Dota 2',
    'Counter-Strike',
    'League of Legends',
    'Valorant'
];
const EXCLUDED_MARKET_TYPES = ['single-game/map', 'short-horizon binary'];

function inferredFeeRate(market) {
    const rates = market._trades
        .filter((trade) => trade.liquidityRole === 'TAKER' && trade.quoteNotional > 0)
        .map((trade) => trade.observedFeeUsdc /
            (Number(trade.size) * Number(trade.price) * (1 - Number(trade.price))))
        .filter((rate) => Number.isFinite(rate) && rate > 0 && rate < 0.2);
    return rates.length ? median(rates) : 0.03;
}

function findSignal(market, strategy) {
    const grossBuys = new Map();
    const netBuys = new Map();
    const lastBuyPrice = new Map();
    let eligibleGrossBuyUsdc = 0;

    for (const trade of market._trades) {
        if (strategy.signalSource === 'taker' && trade.liquidityRole !== 'TAKER') continue;
        if (strategy.minSingleFillUsdc && trade.quoteNotional < strategy.minSingleFillUsdc) continue;

        const direction = trade.side === 'BUY' ? 1 : -1;
        netBuys.set(trade.outcome, (netBuys.get(trade.outcome) || 0) + direction * trade.quoteNotional);
        if (trade.side !== 'BUY') continue;

        eligibleGrossBuyUsdc += trade.quoteNotional;
        grossBuys.set(trade.outcome, (grossBuys.get(trade.outcome) || 0) + trade.quoteNotional);
        lastBuyPrice.set(trade.outcome, Number(trade.price));
        if (eligibleGrossBuyUsdc < strategy.thresholdUsdc) continue;

        const positiveNet = [...netBuys.entries()]
            .filter(([, notional]) => notional > 0)
            .sort((a, b) => b[1] - a[1]);
        if (!positiveNet.length) continue;
        const [outcome, outcomeNetUsdc] = positiveNet[0];
        const positiveTotal = sum(positiveNet, ([, notional]) => notional);
        const concentration = outcomeNetUsdc / positiveTotal;
        if (concentration < strategy.concentration) continue;

        return {
            timestamp: trade.timestamp,
            outcome,
            concentration,
            targetGrossBuyUsdc: eligibleGrossBuyUsdc,
            targetOutcomeGrossBuyUsdc: grossBuys.get(outcome) || 0,
            targetOutcomeNetBuyUsdc: outcomeNetUsdc,
            triggerPrice: lastBuyPrice.get(outcome),
            triggerHash: trade.transactionHash
        };
    }
    return null;
}

function marketIsEligible(market, strategy) {
    if (!market.resolvedWinner) return false;
    if (!strategy.disciplines.includes(market.discipline)) return false;
    if ((strategy.excludedMarketTypes || []).includes(market.marketType)) return false;
    if (strategy.requireTargetStartedPregame) {
        if (!market.gameStartTimestamp) return false;
        if (market.firstTradeTimestamp >= market.gameStartTimestamp) return false;
    }
    return true;
}

function findExecution(market, signal, strategy) {
    const earliest = signal.timestamp + strategy.lagSeconds;
    const latest = earliest + strategy.maxWaitSeconds;
    const candidates = market._trades.filter((trade) =>
        trade.timestamp >= earliest
        && trade.timestamp <= latest
        && trade.side === 'BUY'
        && trade.outcome === signal.outcome);
    if (!candidates.length) return null;

    if (strategy.executionMode === 'post-only-price-revisit') {
        const revisit = candidates.find((trade) => Number(trade.price) <= signal.triggerPrice);
        if (!revisit) return null;
        return {
            trade: revisit,
            executionPrice: signal.triggerPrice,
            feeRate: 0,
            fillEvidence: 'A later target BUY printed at or below the trigger price; queue position is unknown.'
        };
    }

    const trade = candidates[0];
    const executionPrice = Math.min(0.99, Number(trade.price) + strategy.slippageCents / 100);
    return {
        trade,
        executionPrice,
        feeRate: inferredFeeRate(market),
        fillEvidence: 'Next observed target BUY after the lag, plus modeled slippage and taker fee.'
    };
}

function simulateMarket(market, strategy) {
    if (!marketIsEligible(market, strategy)) return null;
    const signal = findSignal(market, strategy);
    if (!signal || !Number.isFinite(signal.triggerPrice)) return null;
    if (signal.triggerPrice < strategy.minPrice || signal.triggerPrice > strategy.maxPrice) return null;

    const execution = findExecution(market, signal, strategy);
    if (!execution) return null;
    if (strategy.pregameOnly && market.gameStartTimestamp && execution.trade.timestamp >= market.gameStartTimestamp) return null;
    if (execution.executionPrice < strategy.minPrice || execution.executionPrice > strategy.maxPrice) return null;

    const allInPrice = execution.executionPrice
        + execution.feeRate * execution.executionPrice * (1 - execution.executionPrice);
    const shares = strategy.stakeUsdc / allInPrice;
    const won = signal.outcome === market.resolvedWinner;
    const profitUsdc = (won ? shares : 0) - strategy.stakeUsdc;

    return {
        conditionId: market.conditionId,
        eventKey: market.eventKey || null,
        title: market.title,
        discipline: market.discipline,
        marketType: market.marketType,
        signalTimestamp: signal.timestamp,
        executionTimestamp: execution.trade.timestamp,
        lagToExecutionSeconds: execution.trade.timestamp - signal.timestamp,
        timing: market.gameStartTimestamp && execution.trade.timestamp >= market.gameStartTimestamp ? 'in-play' : 'pregame',
        outcome: signal.outcome,
        winner: market.resolvedWinner,
        won,
        concentration: signal.concentration,
        targetGrossBuyUsdc: signal.targetGrossBuyUsdc,
        targetOutcomeGrossBuyUsdc: signal.targetOutcomeGrossBuyUsdc,
        targetOutcomeNetBuyUsdc: signal.targetOutcomeNetBuyUsdc,
        triggerPrice: signal.triggerPrice,
        observedPrice: Number(execution.trade.price),
        executionPrice: execution.executionPrice,
        allInPrice,
        feeRate: execution.feeRate,
        fillEvidence: execution.fillEvidence,
        stakeUsdc: strategy.stakeUsdc,
        profitUsdc,
        triggerHash: signal.triggerHash,
        executionHash: execution.trade.transactionHash
    };
}

function enforceExposureRules(results, strategy) {
    const ordered = results.slice().sort((a, b) => a.signalTimestamp - b.signalTimestamp);
    if (!strategy.avoidCorrelatedEventExposure) return ordered;
    const seen = new Set();
    return ordered.filter((result) => {
        if (!result.eventKey) return true;
        if (seen.has(result.eventKey)) return false;
        seen.add(result.eventKey);
        return true;
    });
}

function summarize(results) {
    if (!results.length) {
        return {
            bets: 0,
            wins: 0,
            winRatePct: 0,
            stakeUsdc: 0,
            profitUsdc: 0,
            roiPct: 0,
            profitFactor: 0,
            maxDrawdownUsdc: 0,
            medianEntryPrice: 0,
            medianLagToExecutionSeconds: 0,
            inPlayPct: 0
        };
    }
    const ordered = results.slice().sort((a, b) => a.executionTimestamp - b.executionTimestamp);
    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const result of ordered) {
        cumulative += result.profitUsdc;
        peak = Math.max(peak, cumulative);
        maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    }
    const stake = sum(results, (result) => result.stakeUsdc);
    const profit = sum(results, (result) => result.profitUsdc);
    const grossProfit = sum(results.filter((result) => result.profitUsdc > 0), (result) => result.profitUsdc);
    const grossLoss = Math.abs(sum(results.filter((result) => result.profitUsdc < 0), (result) => result.profitUsdc));
    return {
        bets: results.length,
        wins: results.filter((result) => result.won).length,
        winRatePct: pct(results.filter((result) => result.won).length, results.length),
        stakeUsdc: stake,
        profitUsdc: profit,
        roiPct: pct(profit, stake),
        profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0,
        maxDrawdownUsdc: maxDrawdown,
        medianEntryPrice: median(results.map((result) => result.executionPrice)),
        medianLagToExecutionSeconds: median(results.map((result) => result.lagToExecutionSeconds)),
        inPlayPct: pct(results.filter((result) => result.timing === 'in-play').length, results.length),
        avgTargetGrossBuyUsdc: mean(results.map((result) => result.targetGrossBuyUsdc))
    };
}

function evaluateStrategy(markets, strategy, splitTimestamp) {
    const rawResults = markets.map((market) => simulateMarket(market, strategy)).filter(Boolean);
    const results = enforceExposureRules(rawResults, strategy);
    const trainResults = results.filter((result) => result.executionTimestamp <= splitTimestamp);
    const testResults = results.filter((result) => result.executionTimestamp > splitTimestamp);
    return {
        strategy,
        train: summarize(trainResults),
        test: summarize(testResults),
        all: summarize(results),
        results
    };
}

function strategyName(strategy) {
    const source = strategy.signalSource === 'taker' ? 'taker' : 'all';
    const start = strategy.requireTargetStartedPregame ? 'started-pregame' : 'any-start';
    const universe = strategy.disciplines.join('|') === REPLICATION_DISCIPLINES.join('|')
        ? 'core'
        : `${strategy.disciplines.length}disc`;
    return [source, strategy.thresholdUsdc, Math.round(strategy.concentration * 100),
        strategy.minPrice, strategy.maxPrice, universe, start, strategy.executionMode].join('-');
}

function baseStrategy(overrides = {}) {
    return {
        signalSource: 'taker',
        thresholdUsdc: 25_000,
        concentration: 0.7,
        minSingleFillUsdc: 0,
        disciplines: REPLICATION_DISCIPLINES,
        excludedMarketTypes: EXCLUDED_MARKET_TYPES,
        minPrice: 0.3,
        maxPrice: 0.85,
        lagSeconds: 60,
        maxWaitSeconds: 600,
        slippageCents: 3,
        stakeUsdc: 100,
        executionMode: 'taker-chase',
        pregameOnly: false,
        requireTargetStartedPregame: false,
        avoidCorrelatedEventExposure: true,
        ...overrides
    };
}

function buildTrainingVariants(allDisciplines) {
    const broad = allDisciplines.filter((name) => !['Crypto 5m', 'Other sports', 'Basketball', 'MLB'].includes(name));
    const variants = [];
    for (const thresholdUsdc of [25_000, 50_000, 100_000, 250_000]) {
        for (const concentration of [0.6, 0.7, 0.8]) {
            for (const [minPrice, maxPrice] of [[0.05, 0.95], [0.3, 0.85], [0.35, 0.8]]) {
                for (const disciplines of [broad, REPLICATION_DISCIPLINES]) {
                    for (const requireTargetStartedPregame of [false, true]) {
                        variants.push(baseStrategy({
                            thresholdUsdc,
                            concentration,
                            minPrice,
                            maxPrice,
                            disciplines,
                            requireTargetStartedPregame,
                            executionMode: 'taker-chase'
                        }));
                    }
                }
            }
        }
    }
    return variants;
}

function runBacktests(markets) {
    const eligible = markets.filter((market) => market.resolvedWinner && market.closedCostBasisUsdc > 0);
    const timestamps = eligible.map((market) => market.firstTradeTimestamp).sort((a, b) => a - b);
    const splitTimestamp = quantile(timestamps, 0.7);
    const allDisciplines = [...new Set(eligible.map((market) => market.discipline))];

    const evaluated = buildTrainingVariants(allDisciplines).map((strategy) => {
        const result = evaluateStrategy(eligible, strategy, splitTimestamp);
        const stabilityPenalty = Math.max(0, 20 - result.train.bets) * 2;
        const drawdownPenalty = pct(result.train.maxDrawdownUsdc, Math.max(1, result.train.stakeUsdc)) * 0.25;
        return {
            name: strategyName(strategy),
            score: result.train.roiPct - drawdownPenalty - stabilityPenalty,
            ...result
        };
    });
    const candidates = evaluated
        .filter((variant) => variant.train.bets >= 20 && variant.test.bets >= 8)
        .sort((a, b) => b.score - a.score);
    const selected = candidates[0] || evaluated.sort((a, b) => b.score - a.score)[0];

    const proposedTaker = evaluateStrategy(eligible, baseStrategy(), splitTimestamp);
    const proposedPassive = evaluateStrategy(eligible, baseStrategy({
        executionMode: 'post-only-price-revisit',
        slippageCents: 0
    }), splitTimestamp);
    const lagSensitivity = [15, 30, 60, 120, 300].flatMap((lagSeconds) => [
        evaluateStrategy(eligible, baseStrategy({ lagSeconds }), splitTimestamp),
        evaluateStrategy(eligible, baseStrategy({
            lagSeconds,
            executionMode: 'post-only-price-revisit',
            slippageCents: 0
        }), splitTimestamp)
    ].map((evaluation) => ({
        lagSeconds,
        executionMode: evaluation.strategy.executionMode,
        train: evaluation.train,
        test: evaluation.test,
        all: evaluation.all
    })));

    const baselines = [
        baseStrategy({
            signalSource: 'all',
            thresholdUsdc: 10_000,
            concentration: 0.6,
            disciplines: allDisciplines.filter((name) => name !== 'Crypto 5m'),
            excludedMarketTypes: [],
            minPrice: 0.05,
            maxPrice: 0.95,
            requireTargetStartedPregame: false,
            avoidCorrelatedEventExposure: false
        }),
        baseStrategy({
            thresholdUsdc: 25_000,
            concentration: 0.7,
            minSingleFillUsdc: 10_000,
            disciplines: allDisciplines.filter((name) => name !== 'Crypto 5m'),
            excludedMarketTypes: [],
            minPrice: 0.05,
            maxPrice: 0.95,
            requireTargetStartedPregame: false,
            avoidCorrelatedEventExposure: false
        })
    ].map((strategy, index) => ({
        name: index === 0 ? 'broad-all-fills' : 'large-taker-burst',
        ...evaluateStrategy(eligible, strategy, splitTimestamp)
    }));

    return {
        status: 'SUPERSEDED_BY_EXTERNAL_TAPE_BACKTEST',
        replacement: 'edge_analysis.json and replication_backtest.json',
        methodology: {
            splitTimestamp,
            splitDate: new Date(splitTimestamp * 1000).toISOString(),
            trainShare: 0.7,
            signal: 'Cumulative target taker BUY notional with net directional concentration; only information observable by the trigger time is used.',
            takerExecutionProxy: 'Next observed target BUY within ten minutes after lag, plus three cents and the observed fee curve.',
            passiveExecutionProxy: 'A later target BUY at or below the trigger price is treated as a price revisit. The limit is charged at its full trigger price, but queue fill is unproven.',
            stakeUsdc: 100,
            caveat: 'This legacy diagnostic is not replication evidence because target fills are not a historical order book. The external-tape backtest supersedes it.'
        },
        trainingSearch: {
            selected: {
                name: selected.name,
                score: selected.score,
                strategy: selected.strategy,
                train: selected.train,
                test: selected.test,
                all: selected.all,
                results: selected.results
            },
            leaderboard: candidates.slice(0, 25).map((variant) => ({
                name: variant.name,
                score: variant.score,
                strategy: variant.strategy,
                train: variant.train,
                test: variant.test,
                all: variant.all
            }))
        },
        proposed: {
            rationale: 'Fixed from the attribution findings: at least $25k of aggressive target flow, 70% net directional concentration, profitable disciplines, 0.30-0.85 prices, and no correlated map/game duplication. Pregame initiation explains target PnL but is deliberately not used because it degraded copy results.',
            taker: proposedTaker,
            passivePriceRevisit: proposedPassive
        },
        lagSensitivity,
        baselines
    };
}

module.exports = {
    EXCLUDED_MARKET_TYPES,
    REPLICATION_DISCIPLINES,
    baseStrategy,
    enforceExposureRules,
    evaluateStrategy,
    findSignal,
    inferredFeeRate,
    marketIsEligible,
    runBacktests,
    simulateMarket,
    summarize
};
