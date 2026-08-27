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
const esportsState = require('../research/djdjdjekekek/esports_state_analysis.json');
const dotaIndependent = require('../research/djdjdjekekek/dota_independent_backtest.json');
const prospectiveAudit = require('../research/djdjdjekekek/prospective/prospective_audit.json');
const liveProbeValidation = require('../research/djdjdjekekek/prospective/live_probe_validation.json');
const sportsReaction = require('../research/djdjdjekekek/prospective/esports_reaction_analysis.json');
const cs2Case = require('../research/djdjdjekekek/prospective/cs2_case_audit.json');
const figureManifest = require('../research/djdjdjekekek/figures/manifest.json');
const { renderHtml } = require('../src/research/plain_english_essay');
const { clusterMakerBuys } = require('../src/research/cs2_case_audit');
const { parseTriggerTransaction } = require('../src/research/trigger_transactions');
const {
    frozenCutoff,
    onchainRejections,
    signalRejections
} = require('../src/research/prospective_audit');
const {
    analyzeSportsReactions,
    BookStore,
    DEFAULT_CONFIG,
    PaperEngine,
    discoverMarketsForGameId,
    normalizeSportsMessage,
    paperQuote,
    replay,
    scoreDeployedStateModel,
    summarizeCapture
} = require('../src/research/live_edge_probe');
const {
    activeEventKeys,
    buildReplicatorConfig,
    capacityCappedNotional,
    decodedSweepEligibility,
    feeAdjustedPrice,
    isCompactFreshSweep,
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

test('maker BUY clustering separates outcomes, gaps, and liquidity roles', () => {
    const market = {
        conditionId: 'condition',
        eventKey: 'event',
        title: 'Counter-Strike: A vs B',
        discipline: 'Counter-Strike',
        marketType: 'series winner',
        resolvedWinner: 'A',
        _trades: [
            trade({ timestamp: 1, transactionHash: '0x1', liquidityRole: 'MAKER', size: 100, price: 0.4, quoteNotional: 40 }),
            trade({ timestamp: 3, transactionHash: '0x2', liquidityRole: 'MAKER', size: 50, price: 0.5, quoteNotional: 25 }),
            trade({ timestamp: 4, transactionHash: '0x3', liquidityRole: 'TAKER', size: 1000, price: 0.5, quoteNotional: 500 }),
            trade({ timestamp: 4, transactionHash: '0x4', liquidityRole: 'MAKER', outcome: 'B', size: 100, price: 0.6, quoteNotional: 60 }),
            trade({ timestamp: 10, transactionHash: '0x5', liquidityRole: 'MAKER', size: 25, price: 0.4, quoteNotional: 10 })
        ]
    };
    const clusters = clusterMakerBuys(market, 5);
    assert.strictEqual(clusters.length, 3);
    assert.deepStrictEqual(clusters.map((row) => [row.outcome, row.makerFills]), [
        ['A', 2], ['B', 1], ['A', 1]
    ]);
    assert.strictEqual(clusters[0].makerBuyQuoteUsdc, 65);
    assert.strictEqual(clusters[0].won, true);
    assert.strictEqual(clusters[1].won, false);
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
    assert.strictEqual(config.bookSweepBuffer, 0.01);
    assert.strictEqual(config.absoluteMaxPrice, 0.90);
    assert.strictEqual(config.maxDisplayedDepthParticipationPct, 10);
    assert.strictEqual(config.minCapacityOrderUsdc, 25);
    assert.strictEqual(config.targetCopyLagSeconds, 1);
    assert.strictEqual(config.signalMaxAgeSeconds, 30);
    assert.strictEqual(config.strategy.minimumOnchainUniqueMakers, 18);
    assert.strictEqual(config.strategy.requireExploratoryCompactFresh, false);
});

test('paper monitor requires decoded atomic breadth and shadow-tags compact fresh sweeps', () => {
    const config = buildReplicatorConfig('0x0000000000000000000000000000000000000001');
    const decoded = {
        takerIsTarget: true,
        taker: { side: 'BUY', tokenMatchesSignal: true },
        sweep: { uniqueMakers: 18, uniquePriceLevels: 3, restingAgeMedianSeconds: 299 }
    };
    assert.strictEqual(decodedSweepEligibility(decoded, config), null);
    assert.strictEqual(isCompactFreshSweep(decoded, config), true);
    assert.strictEqual(decodedSweepEligibility({
        ...decoded,
        sweep: { ...decoded.sweep, uniqueMakers: 17 }
    }, config), 'MAKER_BREADTH_BELOW_THRESHOLD');
    assert.strictEqual(isCompactFreshSweep({
        ...decoded,
        sweep: { ...decoded.sweep, restingAgeMedianSeconds: null }
    }, config), false);
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

test('esports mechanism artifacts preserve the independent failure and evidence limits', () => {
    assert.strictEqual(edgeAnalysis.esportsMoatAudit.verdict, 'not_verified_as_unique_moat');
    assert.ok(esportsState.independentStateModel.chronologicalTest.rocAuc > 0.8);
    assert.strictEqual(esportsState.independentStateModel.trainingData.walletOutcomesUsed, false);
    assert.strictEqual(dotaIndependent.window.chosenBeforeMarketOutcomesWereInspected, true);
    assert.strictEqual(dotaIndependent.primary.bets, 9);
    assert.ok(dotaIndependent.primary.roiPct < 0);
    assert.strictEqual(prospectiveAudit.coverage.frozenBreadthEligibleSignals, 0);
    assert.strictEqual(prospectiveAudit.status, 'insufficient_new_evidence');
    assert.strictEqual(liveProbeValidation.mode, 'PAPER_ONLY');
    assert.strictEqual(liveProbeValidation.dynamicGameJoin.dynamicAssetsObserved, 14);
    assert.strictEqual(liveProbeValidation.dynamicGameJoin.observationCoveragePct, 100);
});

test('capacity and mechanism artifacts retain their scope and negative validation', () => {
    const capacity = edgeAnalysis.historicalTapeCapacity;
    const live = edgeAnalysis.liveLiquidityCapacity;
    const closing = edgeAnalysis.closingLineAudit;
    const compact = edgeAnalysis.compactFreshMechanism;
    assert.strictEqual(capacity.scenarioCount, 4_800);
    assert.strictEqual(capacity.grid.length, 4_800);
    assert.ok(live.coverage.eligibleTokenSides > 100);
    const liveHundred = live.summary.find((row) =>
        row.segment === 'all' && row.bufferCents === 1 && row.stakeUsdc === 100
    );
    const liveTenThousand = live.summary.find((row) =>
        row.segment === 'all' && row.bufferCents === 1 && row.stakeUsdc === 10_000
    );
    assert.ok(liveHundred.fillRatePct > liveTenThousand.fillRatePct);
    assert.strictEqual(compact.selection.selectedMaximumPriceLevels, 3);
    assert.strictEqual(compact.selection.selectedMaximumMedianMakerAgeSeconds, 300);
    assert.strictEqual(compact.heldOut.bets, 7);
    assert.strictEqual(compact.heldOut.wins, 6);
    assert.match(compact.warning, /post|after inspecting/i);
    assert.ok(closing.breadthPregame.medianClosingLineValueCents < 0);
    assert.strictEqual(closing.breadthPregame.positiveClosingLineEvents, 4);
    assert.ok(closing.tests.breadthPositiveClvSignTest.oneSidedPValueForPositiveClv > 0.5);
});

test('copy execution audit spans same-second through five minutes and solves break-even cost', () => {
    const blind = edgeAnalysis.blindCopyCounterfactual;
    const atomic = edgeAnalysis.atomicBreadthEdge;
    const lags = new Set(blind.executionSensitivity.map((row) => row.lagSeconds));
    const costs = new Set(blind.executionSensitivity.map((row) => row.slippageCents));
    assert.deepStrictEqual(
        [...lags], [0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300]
    );
    assert.deepStrictEqual(
        [...costs], [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 7.5, 10, 12.5, 15, 17.5, 20, 25, 30]
    );
    assert.strictEqual(blind.executionSensitivity.length, 255);
    assert.strictEqual(atomic.executionSensitivity.length, 255);
    const blindOneSecond = blind.executionBreakEven.find((row) => row.lagSeconds === 1);
    const breadthOneSecond = atomic.executionBreakEven.find((row) => row.lagSeconds === 1);
    assert.ok(blindOneSecond.allMaxAdverseCents > 1);
    assert.ok(blindOneSecond.allMaxAdverseCents < 2);
    assert.ok(breadthOneSecond.heldOutMaxAdverseCents > 15);
    assert.match(atomic.executionTimingLimits.subsecondScenario, /cannot be distinguished/);
    assert.deepStrictEqual(edgeAnalysis.copyParameterAtlas.scenarioCounts, {
        latencyByAdversePricePerStrategy: 255,
        latencyByAdversePriceBothStrategies: 510,
        feeByAdversePricePerStrategy: 102,
        breadthByAdversePrice: 442,
        breadthByLatency: 390
    });
});

test('plain-English essay renders the key claim, caveat, and every chart', () => {
    const html = renderHtml(deepAnalysis, edgeAnalysis);
    assert.deepStrictEqual(figureManifest.rendering, {
        preferredFormat: 'svg',
        pngDpi: 300
    });
    assert.match(html, /Inside the whale's alpha/);
    assert.match(html, /-6\.15%/);
    assert.match(html, /\+41\.94%/);
    assert.match(html, /\+27\.32%/);
    assert.match(html, /1\.53 cents/);
    assert.match(html, /His alpha, literally/);
    assert.match(html, /1,444-cell parameter atlas/);
    assert.match(html, /6,244 execution-and-capacity scenarios/);
    assert.match(html, /compact and fresh/);
    assert.match(html, /median closing-line value was <strong>-0\.67 cents/);
    assert.match(html, /only 38\.1% had \$100 of optimistic one-second all-print capacity/);
    assert.match(html, /will not “just arm the wallet”/);
    assert.match(html, /0\.1-second bot and a 0\.5-second bot cannot be separated honestly/);
    assert.match(html, /p=0\.046/);
    assert.match(html, /not verified as the wallet's exclusive source of alpha/i);
    assert.match(html, /ROC-AUC 0\.851/);
    assert.match(html, /pre-wallet Dota state model returned -6\.87%/);
    assert.match(html, /receiving a book in 88 ms is not knowing fair value/);
    assert.match(html, /public scoreboard was a delayed confirmation/);
    assert.match(html, /The wallet-linked CS2 case reveals the mechanism/);
    assert.match(html, /M80 9-6, round 16, bomb planted/);
    assert.match(html, /Every tested counterparty cutoff from 10 through 30 was negative/);
    assert.match(html, /zero that reached 18 makers/);
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
        'copy_break_even_frontier',
        'copy_latency_curves',
        'copy_cost_curves',
        'fee_cost_surface',
        'execution_print_coverage',
        'breadth_threshold_cost_surface',
        'breadth_threshold_latency_surface',
        'maker_breadth_distribution',
        'breadth_notional_scatter',
        'alpha_equity_drawdown',
        'alpha_subgroup_robustness',
        'alpha_daily_pnl',
        'alpha_leave_one_discipline_out',
        'live_fok_capacity_surface',
        'live_depth_survival',
        'historical_capacity_surface',
        'historical_size_projection',
        'capacity_reality_gap',
        'closing_line_validation',
        'compact_fresh_mechanism',
        'public_follower_lead_lag',
        'esports_moat_audit',
        'dota_live_telemetry_case',
        'dota_state_model_validation',
        'dota_independent_falsification',
        'prospective_signal_audit',
        'live_probe_latency',
        'esports_public_feed_reaction',
        'cs2_wallet_state_cases'
    ]) {
        assert.match(html, new RegExp(`figures/${figure}\\.svg`));
    }
    assert.doesNotMatch(html, /<img src="figures\/[^"']+\.png"/);
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
    assert.strictEqual(accepted.limitPrice, 0.49);
    assert.strictEqual(accepted.eligibleAskLevels, 1);

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
    assert.strictEqual(shallow.estimatedFillFractionPct, 96);
});

test('marketable FOK quote walks multiple levels and capacity sizing limits participation', () => {
    const quote = marketableLimit(0.44, {
        tick_size: '0.01',
        bids: [{ price: '0.47', size: '100' }],
        asks: [
            { price: '0.50', size: '100' },
            { price: '0.48', size: '50' },
            { price: '0.49', size: '100' }
        ]
    }, 0.05, 60, 0.02);
    assert.strictEqual(quote.eligible, true);
    assert.strictEqual(quote.limitPrice, 0.49);
    assert.strictEqual(quote.eligibleAskLevels, 2);
    assert.ok(quote.estimatedVwap > 0.48 && quote.estimatedVwap < 0.49);
    assert.strictEqual(quote.worstFillPrice, 0.49);

    const config = buildReplicatorConfig('0x0000000000000000000000000000000000000001');
    assert.strictEqual(capacityCappedNotional(50, 1_000, config), 50);
    assert.strictEqual(capacityCappedNotional(100, 333.33, config), 33.33);
    assert.strictEqual(capacityCappedNotional(100, 200, config), 0);
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

test('prospective audit applies frozen universe and breadth rules without outcome leakage', () => {
    const strategy = baseStrategy();
    const signal = { triggerPrice: 0.55 };
    assert.deepStrictEqual(signalRejections({
        discipline: 'Dota 2',
        marketType: 'series winner'
    }, signal, strategy), []);
    assert.deepStrictEqual(signalRejections({
        discipline: 'MLB',
        marketType: 'match winner'
    }, signal, strategy), ['DISCIPLINE_EXCLUDED:MLB']);
    assert.deepStrictEqual(onchainRejections({
        takerIsTarget: true,
        taker: { side: 'BUY', tokenMatchesSignal: true },
        sweep: { uniqueMakers: 17 }
    }), ['MAKER_BREADTH_BELOW_18']);
    assert.strictEqual(frozenCutoff({
        trades: [{ timestamp: 10 }],
        activity: [{ timestamp: 12 }]
    }), 12);
});

test('sports websocket normalizer supports the observed nested gameId payload', () => {
    const event = normalizeSportsMessage({
        gameId: 90121928,
        leagueAbbreviation: 'bol1',
        homeTeam: 'Club Blooming',
        awayTeam: 'CDT Real Oruro',
        status: 'InProgress',
        eventState: { score: '0-0', elapsed: '34', period: '1H' }
    }, 1_000);
    assert.strictEqual(event.gameId, '90121928');
    assert.strictEqual(event.rawShape, 'nested_event_state');
    assert.strictEqual(event.live, true);
    assert.strictEqual(event.score, '0-0');
});

test('sports gameId discovery maps Gamma moneyline tokens for dynamic subscription', async () => {
    let query = null;
    const assets = await discoverMarketsForGameId('1650516', async (url, params) => {
        query = { url, params };
        return [{
            acceptingOrders: true,
            enableOrderBook: true,
            sportsMarketType: 'moneyline',
            gameId: 1650516,
            conditionId: 'condition',
            question: 'Marsborne vs Iowa Stormboars',
            clobTokenIds: '["yes-token","no-token"]',
            outcomes: '["Marsborne","Iowa Stormboars"]',
            volume24hr: 123,
            events: [{ slug: 'cs2-marsborne-iowa' }]
        }];
    });
    assert.strictEqual(query.params.game_id, '1650516');
    assert.ok(query.url.endsWith('/markets'));
    assert.deepStrictEqual(assets.map((asset) => asset.assetId), ['yes-token', 'no-token']);
    assert.deepStrictEqual(assets.map((asset) => asset.gameId), ['1650516', '1650516']);
});

test('live capture summary measures dynamic join through first book observation', () => {
    const summary = summarizeCapture([
        { type: 'capture_start', timestampMs: 1_000, assets: 2 },
        { type: 'sports_state', gameId: 'game', receivedAtMs: 2_000 },
        {
            type: 'sports_market_join', gameId: 'game', sportsReceivedAtMs: 2_000,
            completedAtMs: 2_050, queryLatencyMs: 50, discoveredAssets: 2,
            newAssetIds: ['yes', 'no'], marketMetadata: [{ question: 'A vs B' }]
        },
        {
            type: 'book', asset_id: 'yes', receivedAtMs: 2_090,
            bids: [], asks: []
        },
        {
            type: 'price_change', receivedAtMs: 2_100,
            price_changes: [{ asset_id: 'no', side: 'BUY', price: 0.4, size: 10 }]
        },
        { type: 'capture_end', timestampMs: 3_000 }
    ]);
    assert.strictEqual(summary.dynamicGameJoin.dynamicAssetsObserved, 2);
    assert.strictEqual(summary.dynamicGameJoin.observationCoveragePct, 100);
    assert.strictEqual(summary.dynamicGameJoin.queryLatencyMs.median, 50);
    assert.strictEqual(summary.dynamicGameJoin.sportsToFirstBookMs.median, 90);
});

test('CS2 reaction audit bounds a one-round move with the immediately preceding poll', () => {
    const summary = analyzeSportsReactions([
        {
            type: 'sports_market_join', gameId: 'game', marketMetadata: [{
                assetId: 'home-token', outcome: 'Home Team', question: 'Home Team vs Away Team'
            }, {
                assetId: 'away-token', outcome: 'Away Team', question: 'Home Team vs Away Team'
            }]
        },
        {
            type: 'book', asset_id: 'home-token', receivedAtMs: 1_500, timestampMs: 1_490,
            bids: [{ price: 0.40, size: 100 }], asks: [{ price: 0.42, size: 100 }]
        },
        {
            type: 'sports_state', league: 'cs2', gameId: 'game', receivedAtMs: 2_000,
            homeTeam: 'Home Team', awayTeam: 'Away Team', score: '0-0|0-0|Bo3'
        },
        {
            type: 'price_change', receivedAtMs: 20_000, timestampMs: 19_990,
            price_changes: [{
                asset_id: 'home-token', side: 'BUY', price: 0.42, size: 100
            }]
        },
        {
            type: 'sports_state', league: 'cs2', gameId: 'game', receivedAtMs: 22_000,
            homeTeam: 'Home Team', awayTeam: 'Away Team', score: '1-0|0-0|Bo3'
        }
    ]);
    assert.strictEqual(summary.coverage.directionalRoundTransitions, 1);
    assert.strictEqual(summary.headline.beneficialAtMinusOneSecond, 1);
    assert.strictEqual(
        summary.transitions[0].finalHalfCentBeneficialRegimeStartedRelativeToFeedMs, -2_000
    );
    assert.strictEqual(summary.headline.incrementalMeanMoveFromFeedToPlusOneCents, 0);
});

test('committed CS2 reaction evidence remains explicitly small and pre-feed', () => {
    assert.ok(sportsReaction.coverage.transitionsWithBaselineAndOneSecondQuote >= 5);
    assert.strictEqual(
        sportsReaction.finalHalfCentBeneficialRegime.startedBeforePublicUpdate,
        sportsReaction.finalHalfCentBeneficialRegime.observedAtPublicUpdate
    );
    assert.ok(sportsReaction.headline.beneficialAtMinusOneSecond >= 4);
    assert.match(sportsReaction.interpretation, /does not identify/i);
});

test('wallet-linked CS2 audit preserves state evidence and negative controls', () => {
    const { m80, g2M80, nemesis } = cs2Case.cases;
    assert.strictEqual(m80.firstFillBroadcastState.score, 'M80 9-6 Natus Vincere');
    assert.strictEqual(m80.firstFillBroadcastState.bomb, 'planted_by_M80');
    assert.strictEqual(m80.firstFillBroadcastState.m80PlayersAlive, 5);
    assert.strictEqual(m80.firstFillBroadcastState.natusVincerePlayersAlive, 3);
    assert.strictEqual(m80.passiveCluster.uniqueTakerCounterparties, 19);
    assert.ok(m80.passiveCluster.makerBuyQuoteUsdc > 49_000);
    assert.ok(m80.realizedPnlUsdc > 18_000);

    assert.strictEqual(g2M80.clusterStartBroadcastState.score, 'G2 12-11 M80');
    assert.strictEqual(g2M80.clusterStartBroadcastState.bomb, 'not_planted');
    assert.strictEqual(g2M80.passiveCluster.uniqueTakerCounterparties, 18);
    assert.ok(g2M80.realizedPnlUsdc < -83_000);

    assert.strictEqual(nemesis.resolvedFiftyFifty, true);
    assert.match(nemesis.marketRule, /resolve 50-50/);
    assert.ok(nemesis.realizedPnlUsdc < 0);

    assert.strictEqual(cs2Case.populationAudit.candidatesWithCompleteCounterpartyJoin, 11);
    assert.strictEqual(cs2Case.populationAudit.all.resolvedSignals, 9);
    assert.strictEqual(cs2Case.populationAudit.all.wins, 4);
    assert.ok(cs2Case.populationAudit.all.roiPct < -70);
    assert.ok(cs2Case.populationAudit.thresholdSensitivity.every((row) => row.roiPct < 0));
});

test('paper quote performs a capacity-capped FOK depth walk', () => {
    const books = new BookStore();
    books.apply({
        type: 'book', asset_id: 'yes', timestampMs: 1,
        bids: [{ price: '0.39', size: '100' }],
        asks: [{ price: '0.40', size: '100' }, { price: '0.41', size: '1000' }]
    });
    const quote = paperQuote(books.get('yes'), 0.60, {
        ...DEFAULT_CONFIG,
        maximumDisplayedDepthParticipationPct: 100
    });
    assert.strictEqual(quote.eligible, true);
    assert.strictEqual(quote.notionalUsdc, 50);
    assert.ok(quote.vwap > 0.40 && quote.vwap < 0.41);
    assert.ok(quote.probabilityEdge >= 0.05);
});

test('paper replay waits one second, never signs, and settles modeled PnL', () => {
    const summary = replay([
        {
            type: 'book', asset_id: 'yes', timestampMs: 0,
            bids: [{ price: 0.39, size: 100 }], asks: [{ price: 0.40, size: 2_000 }]
        },
        {
            type: 'fair_probability', assetId: 'yes', gameId: 'game',
            source: 'test', probability: 0.65, timestampMs: 1_000
        },
        {
            type: 'price_change', timestampMs: 2_100,
            price_changes: [{ asset_id: 'yes', side: 'SELL', price: 0.41, size: 2_000 }]
        },
        { type: 'settlement', assetId: 'yes', won: true, timestampMs: 3_000 }
    ]);
    assert.strictEqual(summary.mode, 'PAPER_ONLY');
    assert.strictEqual(summary.intents, 1);
    assert.strictEqual(summary.paperIntents[0].actualLatencyMs, 1_100);
    assert.ok(summary.profitUsdc > 0);
});

test('JavaScript Dota scorer reproduces the committed deployment model', () => {
    const probability = scoreDeployedStateModel(
        require('../research/djdjdjekekek/esports_state_analysis.json').independentStateModel,
        { targetGoldAdvantage: 13_433, targetXpAdvantage: 10_921, gameMinute: 61 }
    );
    assert.ok(probability > 0.65 && probability < 0.68);
});
