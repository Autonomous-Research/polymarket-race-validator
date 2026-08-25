'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildMarketRecords,
    canonicalEventKey,
    classifyDiscipline,
    classifyMarketType
} = require('../src/research/analyze');
const {
    baseStrategy,
    enforceExposureRules,
    findSignal,
    marketIsEligible,
    simulateMarket
} = require('../src/research/backtest');
const { aggregateCounterparties, PUSD } = require('../src/research/onchain');
const deepAnalysis = require('../research/djdjdjekekek/deep_analysis.json');
const edgeAnalysis = require('../research/djdjdjekekek/edge_analysis.json');
const { renderHtml } = require('../src/research/plain_english_essay');
const { parseTriggerTransaction } = require('../src/research/trigger_transactions');
const {
    activeEventKeys,
    buildReplicatorConfig,
    feeAdjustedPrice,
    marketableLimit,
    postOnlyLimit,
    publicSignalFeatures,
    scoreEdgeModel
} = require('../src/research/replicator');

function trade(overrides = {}) {
    return {
        timestamp: 100,
        transactionHash: `0x${String(overrides.timestamp || 100).padStart(64, '0')}`,
        side: 'BUY',
        outcome: 'A',
        size: 62_500,
        price: 0.4,
        quoteNotional: 25_000,
        observedFeeUsdc: 750,
        liquidityRole: 'TAKER',
        ...overrides
    };
}

test('discipline and market type distinguish maps from series', () => {
    assert.strictEqual(classifyDiscipline({ title: 'Dota 2: A vs B', slug: 'dota2-a-b' }), 'Dota 2');
    assert.strictEqual(classifyDiscipline({ title: 'Bitcoin Up or Down', slug: 'btc-updown-5m-1' }), 'Crypto 5m');
    assert.strictEqual(classifyMarketType({ title: 'Counter-Strike: A vs B - Map 2 Winner' }), 'single-game/map');
    assert.strictEqual(classifyMarketType({ title: 'Dota 2: A vs B - Game 1 Winner' }), 'single-game/map');
    assert.strictEqual(classifyMarketType({ title: 'Counter-Strike: A vs B (BO1)' }), 'single-game/map');
    assert.strictEqual(classifyMarketType({ title: 'Dota 2: A vs B (BO3)' }), 'series winner');
});

test('canonical event key joins series and map conditions', () => {
    const series = canonicalEventKey({
        title: 'Dota 2: Team A vs Team B (BO3) - Playoffs',
        gameStartTime: '2026-08-23T02:10:00Z'
    });
    const map = canonicalEventKey({
        title: 'Dota 2: Team B vs Team A - Map 1 Winner',
        gameStartTime: '2026-08-23T02:10:00Z'
    });
    assert.strictEqual(series, map);
});

test('findSignal uses only fills observed by the trigger timestamp', () => {
    const market = {
        _trades: [
            trade({ timestamp: 1, outcome: 'A', quoteNotional: 10_000, price: 0.4 }),
            trade({ timestamp: 2, outcome: 'B', quoteNotional: 10_000, price: 0.55 }),
            trade({ timestamp: 3, outcome: 'A', quoteNotional: 10_000, price: 0.41 }),
            trade({ timestamp: 4, outcome: 'A', quoteNotional: 15_000, price: 0.42 }),
            trade({ timestamp: 5, outcome: 'B', quoteNotional: 1_000_000, price: 0.9 })
        ]
    };
    const signal = findSignal(market, baseStrategy({ thresholdUsdc: 25_000, concentration: 0.7 }));
    assert.strictEqual(signal.timestamp, 4);
    assert.strictEqual(signal.outcome, 'A');
    assert.strictEqual(signal.triggerPrice, 0.42);
    assert.ok(signal.concentration > 0.77 && signal.concentration < 0.78);
});

test('simulation waits for lag and charges modeled taker execution', () => {
    const market = {
        conditionId: 'condition',
        title: 'Tennis: A vs B',
        discipline: 'Tennis',
        marketType: 'match winner',
        eventKey: 'event',
        resolvedWinner: 'A',
        firstTradeTimestamp: 100,
        gameStartTimestamp: 1_000,
        _trades: [
            trade({ timestamp: 100, quoteNotional: 25_000, price: 0.4 }),
            trade({ timestamp: 150, quoteNotional: 1_000, price: 0.41 }),
            trade({
                timestamp: 165,
                quoteNotional: 1_000,
                size: 1_000 / 0.42,
                price: 0.42,
                observedFeeUsdc: (1_000 / 0.42) * 0.05 * 0.42 * 0.58
            })
        ]
    };
    const strategy = baseStrategy({ thresholdUsdc: 25_000, lagSeconds: 60 });
    const result = simulateMarket(market, strategy);
    assert.strictEqual(result.executionTimestamp, 165);
    assert.strictEqual(result.observedPrice, 0.42);
    assert.ok(Math.abs(result.executionPrice - 0.45) < 1e-12);
    assert.ok(result.feeRate > 0.049 && result.feeRate < 0.051);
});

test('backtest eligibility excludes single maps', () => {
    const market = {
        resolvedWinner: 'A',
        discipline: 'Dota 2',
        marketType: 'single-game/map',
        firstTradeTimestamp: 100,
        gameStartTimestamp: 1_000
    };
    assert.strictEqual(marketIsEligible(market, baseStrategy()), false);
});

test('exposure rule keeps only the first condition in a correlated event', () => {
    const results = [
        { conditionId: 'series', eventKey: 'event', signalTimestamp: 100 },
        { conditionId: 'map', eventKey: 'event', signalTimestamp: 110 },
        { conditionId: 'other', eventKey: 'other', signalTimestamp: 120 }
    ];
    const kept = enforceExposureRules(results, { avoidCorrelatedEventExposure: true });
    assert.deepStrictEqual(kept.map((row) => row.conditionId), ['series', 'other']);
});

test('activity size corrects maker sub-fill without changing transaction identity', () => {
    const snapshot = {
        trades: [{
            transactionHash: '0x1', conditionId: 'condition', side: 'BUY', outcome: 'A',
            size: 100, price: 0.36, timestamp: 100, title: 'Dota 2: A vs B (BO3)', slug: 'dota2-a-b'
        }],
        activity: [{
            type: 'TRADE', transactionHash: '0x1', conditionId: 'condition', side: 'BUY', outcome: 'A',
            asset: 'token', size: 12_000, price: 0.36, usdcSize: 4_320, timestamp: 100
        }],
        closedPositions: [],
        positions: []
    };
    const enrichment = {
        marketMetadata: [{
            conditionId: 'condition', question: 'Dota 2: A vs B (BO3)', tags: ['esports'], tokens: []
        }],
        takerTrades: [],
        makerRebates: []
    };
    const [market] = buildMarketRecords(snapshot, enrichment);
    assert.strictEqual(market.quoteNotionalUsdc, 4_320);
    assert.strictEqual(market._trades[0].publicTradeSize, 100);
    assert.strictEqual(market._trades[0].activityReportedSize, 12_000);
});

test('deposit aggregation excludes the backing vault transfer and keeps direct deposits', () => {
    const wallet = '0x0000000000000000000000000000000000000001';
    const source = '0x0000000000000000000000000000000000000002';
    const vault = '0x0000000000000000000000000000000000000003';
    const records = [{
        reportedUsdc: 100,
        transaction: { tokenTransfers: [
            { from: source, to: PUSD, token: 'USDC.E', tokenAddress: 'usdc', value: 100 },
            { from: PUSD, to: vault, token: 'USDC.E', tokenAddress: 'usdc', value: 100 }
        ] }
    }, {
        reportedUsdc: 50,
        transaction: { tokenTransfers: [
            { from: source, to: wallet, token: 'USDC.E', tokenAddress: 'usdc', value: 50 }
        ] }
    }];
    const [origin] = aggregateCounterparties(records, 'deposit', wallet);
    assert.strictEqual(origin.address, source);
    assert.strictEqual(origin.count, 2);
    assert.strictEqual(origin.usdc, 150);
});

test('paper config cannot be switched to live and excludes known leaks', () => {
    const config = buildReplicatorConfig('0x0000000000000000000000000000000000000001', { mode: 'LIVE' });
    assert.strictEqual(config.mode, 'PAPER_ONLY');
    assert.strictEqual(config.strategy.thresholdUsdc, 25_000);
    assert.ok(config.strategy.excludedMarketTypes.includes('single-game/map'));
    assert.ok(!config.strategy.allowedDisciplines.includes('Crypto 5m'));
    assert.strictEqual(config.strategy.minimumTakerBurst60Share, 0.8);
    assert.strictEqual(config.executionMode, 'MARKETABLE_LIMIT_FOK');
    assert.strictEqual(config.requirePostOnly, false);
});

test('committed edge artifact preserves the blind-copy rejection and tight falsification', () => {
    const blind = edgeAnalysis.blindCopyCounterfactual;
    const mechanism = edgeAnalysis.mechanismAudit;
    assert.ok(blind.all.roiPct < 0);
    assert.ok(blind.later.roiPct < 0);
    assert.ok(mechanism.calibration.burst60.calibrationGapPctPoints > 0);
    assert.ok(mechanism.calibration.slower.calibrationGapPctPoints < 0);
    assert.ok(mechanism.compositionControls.broadCmh.twoSidedPValue < 0.05);
    assert.ok(mechanism.compositionControls.finePermutation.oneSidedPValue > 0.05);
});

test('decoded trigger transaction separates maker breadth from public trade count', () => {
    const target = '0x0000000000000000000000000000000000000001';
    const tokenA = '101';
    const tokenB = '202';
    const order = (maker, tokenId, makerAmount, takerAmount, side) => [
        '1', maker, maker, tokenId, String(makerAmount), String(takerAmount),
        String(side), '0', '1780000000000', `0x${'0'.repeat(64)}`,
        `0x${'0'.repeat(64)}`, '0x00'
    ];
    const transaction = {
        hash: `0x${'1'.repeat(64)}`,
        method: 'matchOrders',
        timestamp: '2026-05-27T10:13:25.000000Z',
        block_number: 1,
        gas_used: '100000',
        status: 'ok',
        from: { hash: '0x0000000000000000000000000000000000000009' },
        to: { hash: '0xE111180000d2663C0091e4f400237545B87B996B' },
        decoded_input: { parameters: [
            { name: 'conditionId', value: `0x${'2'.repeat(64)}` },
            { name: 'takerOrder', value: order(target, tokenA, 40e6, 100e6, 0) },
            { name: 'makerOrders', value: [
                order('0x0000000000000000000000000000000000000002', tokenA, 100e6, 50e6, 1),
                order('0x0000000000000000000000000000000000000003', tokenB, 60e6, 100e6, 0)
            ] },
            { name: 'takerFillAmount', value: String(13e6) },
            { name: 'makerFillAmounts', value: [String(10e6), String(12e6)] },
            { name: 'takerFeeAmount', value: '0' },
            { name: 'makerFeeAmounts', value: ['0', '0'] }
        ] }
    };
    const tape = {
        targetWallet: target,
        conditionId: `0x${'2'.repeat(64)}`,
        eventKey: 'event',
        tokens: [{ tokenId: tokenA, outcome: 'A' }, { tokenId: tokenB, outcome: 'B' }],
        seedSignal: { timestamp: 1_780_000_005, outcome: 'A', triggerPrice: 13 / 30 }
    };
    const parsed = parseTriggerTransaction(transaction, tape);
    assert.strictEqual(parsed.takerIsTarget, true);
    assert.strictEqual(parsed.sweep.makerOrderCount, 2);
    assert.strictEqual(parsed.sweep.uniqueMakers, 2);
    assert.deepStrictEqual(new Set(parsed.sweep.matchTypes), new Set(['COMPLEMENTARY', 'MINT']));
    assert.ok(Math.abs(parsed.sweep.targetShares - 30) < 1e-9);
    assert.ok(Math.abs(parsed.sweep.targetNotionalUsdc - 13) < 1e-9);
    assert.ok(Math.abs(parsed.sweep.notionalReconciliationPct) < 1e-9);

    const unsupported = JSON.parse(JSON.stringify(transaction));
    unsupported.decoded_input.parameters.find(
        (parameter) => parameter.name === 'makerOrders'
    ).value[0] = order(
        '0x0000000000000000000000000000000000000002', tokenB, 100e6, 50e6, 1
    );
    assert.throws(
        () => parseTriggerTransaction(unsupported, tape),
        /Unsupported maker\/taker pairing/
    );
});

test('committed atomic breadth edge is development-selected and held-out positive', () => {
    const atomic = edgeAnalysis.atomicBreadthEdge;
    assert.strictEqual(atomic.thresholdSelection.selectedFromDevelopment, 18);
    assert.strictEqual(atomic.thresholdSelection.frozenAlgorithmThreshold, 18);
    assert.ok(atomic.chronology.validation.roiPct > 0);
    assert.ok(atomic.chronology.finalTest.roiPct > 0);
    assert.ok(atomic.chronology.heldOutAfterDevelopment.roiPct > 0);
    assert.ok(atomic.belowThreshold.roiPct < 0);
    assert.ok(atomic.thresholdSelection.marketNullSimulation.oneSidedPValue < 0.05);
});

test('copy execution audit spans same-second through five minutes and solves break-even cost', () => {
    const blind = edgeAnalysis.blindCopyCounterfactual;
    const atomic = edgeAnalysis.atomicBreadthEdge;
    const lags = new Set(blind.executionSensitivity.map((row) => row.lagSeconds));
    const costs = new Set(blind.executionSensitivity.map((row) => row.slippageCents));
    assert.deepStrictEqual([...lags], [0, 1, 2, 5, 10, 15, 30, 60, 120, 300]);
    assert.deepStrictEqual([...costs], [0, 0.5, 1, 2, 3, 5, 7, 10, 15, 20]);
    assert.strictEqual(blind.executionSensitivity.length, 100);
    assert.strictEqual(atomic.executionSensitivity.length, 100);
    const blindOneSecond = blind.executionBreakEven.find((row) => row.lagSeconds === 1);
    const breadthOneSecond = atomic.executionBreakEven.find((row) => row.lagSeconds === 1);
    assert.ok(blindOneSecond.allMaxAdverseCents > 1);
    assert.ok(blindOneSecond.allMaxAdverseCents < 2);
    assert.ok(breadthOneSecond.heldOutMaxAdverseCents > 15);
    assert.match(atomic.executionTimingLimits.subsecondScenario, /cannot be distinguished/);
});

test('plain-English essay renders the key claim, caveat, and every chart', () => {
    const html = renderHtml(deepAnalysis, edgeAnalysis);
    assert.match(html, /Copying the whale would have lost money/);
    assert.match(html, /-6\.15%/);
    assert.match(html, /\+41\.94%/);
    assert.match(html, /\+27\.32%/);
    assert.match(html, /1\.53 cents/);
    assert.match(html, /0\.1-second bot and a 0\.5-second bot cannot be separated honestly/);
    assert.match(html, /p=0\.046/);
    for (const figure of [
        'blind_copy_funnel',
        'strategy_equity',
        'urgency_calibration',
        'burst_threshold_sensitivity',
        'execution_sensitivity',
        'atomic_breadth_calibration',
        'breadth_chronology',
        'breadth_threshold_lock',
        'atomic_sweep_anatomy',
        'breadth_execution_sensitivity',
        'copy_execution_surface',
        'copy_break_even_frontier'
    ]) {
        assert.match(html, new RegExp(`figures/${figure}\\.png`));
    }
    assert.doesNotMatch(html, /\b(?:undefined|NaN)\b/);
});

test('active positions reserve their canonical event in the paper monitor', () => {
    const occupied = activeEventKeys([
        { conditionId: 'series', eventKey: 'shared-event' },
        { conditionId: 'other', eventKey: 'other-event' }
    ], {
        positions: [
            { conditionId: 'series', size: 25 },
            { conditionId: 'other', size: 0 }
        ]
    });
    assert.deepStrictEqual([...occupied], ['shared-event']);
});

test('marketable paper limit enforces the modeled adverse-move ceiling', () => {
    const accepted = marketableLimit(0.44, {
        tick_size: '0.01',
        bids: [{ price: '0.46', size: '100' }],
        asks: [{ price: '0.48', size: '100' }]
    });
    assert.strictEqual(accepted.eligible, true);
    assert.strictEqual(accepted.limitPrice, 0.48);

    const rejected = marketableLimit(0.44, {
        tick_size: '0.01',
        bids: [{ price: '0.48', size: '100' }],
        asks: [{ price: '0.50', size: '100' }]
    });
    assert.strictEqual(rejected.reason, 'PRICE_RAN_AWAY');

    const shallow = marketableLimit(0.44, {
        tick_size: '0.01',
        bids: [{ price: '0.46', size: '100' }],
        asks: [{ price: '0.48', size: '100' }]
    }, 0.05, 50);
    assert.strictEqual(shallow.reason, 'INSUFFICIENT_ASK_DEPTH');
    assert.strictEqual(shallow.availableAskNotionalUsdc, 48);
});

test('edge model scorer reproduces standardized numeric and categorical logit', () => {
    const probability = scoreEdgeModel({ x: 3, category: 'A' }, {
        intercept: -0.5,
        numeric: [{ name: 'x', imputeMedian: 1, mean: 1, scale: 2, coefficient: 1 }],
        categorical: [{
            name: 'category',
            values: [{ value: 'A', coefficient: 0.5 }],
            unknownCoefficient: 0
        }]
    });
    assert.ok(Math.abs(probability - (1 / (1 + Math.exp(-1)))) < 1e-12);
    assert.ok(feeAdjustedPrice(0.5, 0.03) > 0.5);
});

test('public signal features match target direction and exclude the target wallet', () => {
    const features = publicSignalFeatures([
        { timestamp: 600, asset: 'yes', side: 'BUY', price: 0.4, size: 10, proxyWallet: '0xpeer' },
        { timestamp: 800, asset: 'no', side: 'BUY', price: 0.55, size: 20, proxyWallet: '0xpeer' },
        { timestamp: 999, asset: 'yes', side: 'BUY', price: 0.5, size: 30, proxyWallet: '0xpeer' },
        { timestamp: 999, asset: 'yes', side: 'BUY', price: 0.9, size: 1_000, proxyWallet: '0xtarget' }
    ], {
        metadata: { tokens: [
            { token_id: 'yes', outcome: 'Yes' },
            { token_id: 'no', outcome: 'No' }
        ] }
    }, {
        timestamp: 1_000,
        outcome: 'Yes'
    }, '0xtarget');
    assert.ok(Math.abs(features.preMomentum300 - 0.1) < 1e-12);
    assert.ok(Math.abs(features.externalFlow300 - 0.2) < 1e-12);
});

test('post-only guard refuses a chased ask and otherwise stays below it', () => {
    const accepted = postOnlyLimit(0.44, {
        tick_size: '0.01',
        bids: [{ price: '0.40', size: '100' }],
        asks: [{ price: '0.45', size: '100' }]
    });
    assert.strictEqual(accepted.eligible, true);
    assert.strictEqual(accepted.limitPrice, 0.41);
    assert.ok(accepted.limitPrice < accepted.bestAsk);

    const rejected = postOnlyLimit(0.44, {
        tick_size: '0.01',
        bids: [{ price: '0.45', size: '100' }],
        asks: [{ price: '0.47', size: '100' }]
    }, 0.01);
    assert.strictEqual(rejected.reason, 'PRICE_RAN_AWAY');
});
