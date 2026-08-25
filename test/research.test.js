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
