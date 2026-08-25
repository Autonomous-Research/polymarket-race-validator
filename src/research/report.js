'use strict';

const path = require('path');
const fs = require('fs/promises');

function money(value) {
    const amount = Number(value || 0);
    const sign = amount < 0 ? '-' : '';
    const absolute = Math.abs(amount);
    if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(2)}M`;
    if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(1)}K`;
    return `${sign}$${absolute.toFixed(2)}`;
}

function number(value, digits = 0) {
    return Number(value || 0).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
    });
}

function percent(value, digits = 1) {
    return `${Number(value || 0).toFixed(digits)}%`;
}

function signedPercent(value, digits = 1) {
    const numeric = Number(value || 0);
    return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(digits)}%`;
}

function signedPoints(value, digits = 1) {
    const numeric = Number(value || 0);
    return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(digits)} pp`;
}

function signedMoney(value) {
    const numeric = Number(value || 0);
    return `${numeric >= 0 ? '+' : ''}${money(numeric)}`;
}

function shortAddress(address) {
    return address ? `${address.slice(0, 8)}...${address.slice(-6)}` : 'n/a';
}

function isoShort(value) {
    return value ? String(value).replace('.000Z', 'Z') : 'n/a';
}

function rowByKey(rows, key) {
    return (rows || []).find((row) => row.key === key) || {};
}

function bootstrap(stats, key) {
    return stats.bootstrapRoi?.[key] || {};
}

function performanceRows(rows) {
    return (rows || []).map((row) =>
        `| ${row.key} | ${number(row.markets)} | ${money(row.costBasisUsdc)} | ${signedMoney(row.realizedPnlUsdc)} | ${signedPercent(row.roiPct, 2)} | ${percent(row.takerNotionalPct, 1)} |`
    ).join('\n');
}

function explorer(address) {
    return `https://polygon.blockscout.com/address/${address}`;
}

function txExplorer(hash) {
    return `https://polygon.blockscout.com/tx/${hash}`;
}

function onchainReport(analysis, onchain) {
    const wallet = onchain.wallet;
    const owner = onchain.owner;
    const chronology = onchain.control.chronology || {};
    const origins = onchain.flows.depositOrigins || [];
    const destinations = onchain.flows.withdrawalDestinations || [];
    const linked = new Map((onchain.linkedAddresses || []).map((item) => [item.address.toLowerCase(), item]));
    const directLink = onchain.identityLinks?.directOwnerTransactionsToDepositOrigins?.[0];
    const flow = onchain.flows.dataApi;
    const cash = analysis.cash;
    const originRows = origins.map((origin) => {
        const summary = linked.get(origin.address.toLowerCase()) || {};
        const relationship = origin.address.toLowerCase() === '0x8b2f31a32d033067538244e4a39b6c964bb7510e'
            ? 'Owner-funded EIP-7702 source account'
            : summary.explorerTransactionsCount > 100_000
                ? 'High-volume infrastructure; not identity evidence'
                : 'Unclassified dust/source';
        return `| [${shortAddress(origin.address)}](${explorer(origin.address)}) | ${number(origin.count)} | ${money(origin.usdc)} | ${percent(origin.usdc / flow.depositUsdc * 100, 2)} | ${number(summary.explorerTransactionsCount)} | ${relationship} |`;
    }).join('\n');
    const destinationRows = destinations.map((destination) => {
        const summary = linked.get(destination.address.toLowerCase()) || {};
        return `| [${shortAddress(destination.address)}](${explorer(destination.address)}) | ${number(destination.count)} | ${money(destination.usdc)} | ${number(summary.explorerTransactionsCount)} | ${summary.isContract ? 'Shared contract/infrastructure' : 'EOA, relationship unproven'} |`;
    }).join('\n');

    return `# Onchain Investigation: @djdjdjekekek

Generated ${analysis.generatedAt}. Polygon state was refreshed ${onchain.generatedAt}.

## Finding

The profile wallet is not an unidentified Safe. It is a Polymarket POLY_1271 Deposit Wallet controlled by the EOA [${wallet.owner}](${explorer(wallet.owner)}). The wallet's onchain \`owner()\`, its \`id()\`, and its sole initialization event all resolve to that same EOA. The owner then directly transacted with the EIP-7702 account that supplied ${money(origins[0]?.usdc)} of the target's funding.

This establishes an address-control graph. It does **not** identify a natural person, and the high-volume deposit and withdrawal routers are deliberately not attributed to the owner.

## Control Graph

| Role | Address | Evidence | Confidence |
| --- | --- | --- | --- |
| Public profile / funder | [${wallet.address}](${explorer(wallet.address)}) | Gamma profile, deployed bytecode, pUSD balances and all trading activity | Confirmed |
| Deposit-wallet implementation | [${wallet.implementation}](${explorer(wallet.implementation)}) | EIP-1967 implementation slot | Confirmed |
| Controller EOA | [${wallet.owner}](${explorer(wallet.owner)}) | \`owner()\`, \`id()\`, and \`OwnershipTransferred\` agree | Confirmed |
| Main funding source | [${origins[0]?.address}](${explorer(origins[0]?.address)}) | ${number(origins[0]?.count)} backing deposits; owner sent a direct transaction to it | Strong address link |
| Main cash-out route | [${destinations[0]?.address}](${explorer(destinations[0]?.address)}) | ${number(destinations[0]?.count)} withdrawals, but ${number(linked.get(destinations[0]?.address.toLowerCase())?.explorerTransactionsCount)} explorer-counted transactions | Infrastructure only |

The owner EOA is code-free, currently has nonce ${owner.transactionCount}, and holds ${number(owner.polBalance, 3)} POL. The main source is an EIP-7702 delegated account using \`Simple7702Account\`; its low explorer activity and the owner's [direct transaction](${directLink ? txExplorer(directLink.transactionHash) : explorer(wallet.owner)}) make this relationship materially stronger than simple transfer adjacency.

## Wallet Anatomy

| Check | Result |
| --- | --- |
| Wallet type | \`${wallet.walletType}\` |
| Signature type | \`${wallet.signatureType}\` (POLY_1271) |
| Relayer deployment check | \`WALLET=${wallet.relayerDeployment?.wallet}\`, \`SAFE=${wallet.relayerDeployment?.safe}\` |
| Runtime bytecode | ${number(wallet.codeBytes)} bytes; hash \`${wallet.codeHash}\` |
| Factory | [${wallet.factory}](${explorer(wallet.factory)}) |
| Current batch nonce | ${wallet.nonce} |
| Batch executions observed | ${number(onchain.control.batchExecutions)} |
| Session-signer events | ${number(onchain.control.sessionSignerEvents.length)} |
| Upgrade events | ${number(onchain.control.upgradeEvents.length)} |
| Paused | \`${wallet.paused}\` |

Polymarket's documentation defines signature type 3 as a deposit wallet whose owner or session signer authorizes orders through ERC-1271. The absence of session-signer events means the controller EOA is the only controller evidenced by this contract history; it does not prove that no offchain automation exists.

## Launch Timeline

| Event | UTC | Block / transaction |
| --- | --- | --- |
| Wallet initialized to owner | ${isoShort(chronology.initializedAt)} | ${chronology.initializedBlock || 'n/a'} |
| First \`BatchExecuted\` | ${isoShort(chronology.firstBatchAt)} | ${chronology.firstBatchBlock || 'n/a'} |
| First observed trade | ${isoShort(chronology.firstObservedTradeAt)} | [transaction](${chronology.firstObservedTradeHash ? txExplorer(chronology.firstObservedTradeHash) : explorer(wallet.address)}) |

Initialization to first observed trade took ${number(chronology.initializationToFirstTradeSeconds)} seconds (${(Number(chronology.initializationToFirstTradeSeconds || 0) / 60).toFixed(1)} minutes). That sequence, plus ${number(onchain.control.batchExecutions)} batches and rapid treasury transfers, is consistent with a purpose-built automated trading operation.

## Funding In

All ${number(flow.deposits)} reported deposits were decoded from their transaction receipts.

| Origin | Transfers | Amount | Share of deposits | Explorer tx count | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
${originRows}

The ${money(origins[1]?.usdc)} from \`${shortAddress(origins[1]?.address)}\` arrived as three direct USDC.e transfers. Its roughly ${number(linked.get(origins[1]?.address.toLowerCase())?.explorerTransactionsCount)} explorer transactions make it a router or service-like account, not a credible second owner wallet. A ${money(origins[2]?.usdc)} PUSD transfer is immaterial.

## Cash Out

| Destination | Transfers | Amount | Explorer tx count | Interpretation |
| --- | ---: | ---: | ---: | --- |
${destinationRows}

The main destination has hundreds of thousands of transactions and millions of token transfers. It is a shared cash-out contract. Following it as though it were the trader would be a false identity cluster.

## Cash Reconciliation

| Item | Amount |
| --- | ---: |
| Deposits | ${money(flow.depositUsdc)} |
| Withdrawals | ${money(flow.withdrawalUsdc)} |
| Net cash withdrawn | ${money(flow.netWithdrawnUsdc)} |
| Onchain pUSD + USDC.e + native USDC | ${money(cash.onchainStablecoinBalanceUsdc)} |
| Open position value | ${money(cash.currentPositionValueUsdc)} |
| Confirmed economic result | ${money(cash.confirmedEconomicProfitUsdc)} |
| Closed realized PnL | ${money(cash.closedRealizedPnlUsdc)} |
| Rebates and rewards | ${money(cash.rebatesAndRewardsUsdc)} |
| Closed PnL plus incentives | ${money(cash.closedPnlPlusIncentivesUsdc)} |
| Confirmed result minus that endpoint total | ${signedMoney(cash.confirmedAccountingDifferenceUsdc)} |
| Activity-ledger residual, not an onchain balance | ${money(cash.activityLedgerResidualUsdc)} |

The wallet was initialized immediately before its first deposit, currently has no open positions, and holds ${money(cash.onchainStablecoinBalanceUsdc)} across the three relevant stablecoins. Net withdrawals therefore provide the strongest economic result: ${money(cash.confirmedEconomicProfitUsdc)} was extracted above deposits. The activity rows leave a ${money(cash.activityLedgerResidualUsdc)} arithmetic residual even though RPC balances are zero, so that residual is retained as a data-quality diagnostic and is not counted as liquid value. Closed-position PnL plus incentives differs from the confirmed cash result by ${signedMoney(cash.confirmedAccountingDifferenceUsdc)}, consistent with endpoint accounting/timing differences.

## Treasury Automation

Deposits and buys have a ${Number(cash.depositBuyCorrelationDaily).toFixed(3)} daily correlation. The next buy follows a deposit after a median ${number(cash.depositToNextBuyLag.medianSeconds)} seconds; ${percent(cash.depositToNextBuyLag.withinOneMinutePct)} occur within one minute and ${percent(cash.depositToNextBuyLag.withinFiveMinutesPct)} within five. This is strong evidence of just-in-time funding and capital recycling.

## Confidence Boundaries

| Statement | Assessment |
| --- | --- |
| The profile wallet is a type-3 Deposit Wallet | Confirmed by relayer response, bytecode and implementation |
| \`${shortAddress(wallet.owner)}\` controls it | Confirmed by three independent contract fields/events |
| \`${shortAddress(origins[0]?.address)}\` is linked to the owner | Strong: direct owner transaction plus ${number(origins[0]?.count)} deposits |
| The large router addresses belong to the trader | Unsupported; their activity profiles indicate shared infrastructure |
| A real-world person can be named | Not established by public evidence |

## Sources

- [Polymarket trading overview and signature types](https://docs.polymarket.com/trading/overview)
- [Polymarket relayer deployment check](https://docs.polymarket.com/api-reference/relayer/check-if-a-wallet-is-deployed)
- [Wallet explorer](${explorer(wallet.address)})
- [Owner explorer](${explorer(wallet.owner)})
- [Main source explorer](${explorer(origins[0]?.address)})
- [Implementation explorer](${explorer(wallet.implementation)})
- Raw evidence: [onchain_evidence.json](./onchain_evidence.json) and [flow_transactions.json](./flow_transactions.json)
`;
}

function traderReport(analysis, stats, edge, peers) {
    const execution = analysis.execution;
    const cash = analysis.cash;
    const perf = analysis.performance;
    const timing = analysis.timing;
    const correlated = analysis.construction.correlatedEventSummary;
    const highTaker = bootstrap(stats, 'takerShareAtLeast50Pct');
    const lowTaker = bootstrap(stats, 'takerShareBelow50Pct');
    const mapBootstrap = bootstrap(stats, 'singleGameOrMap');
    const startPregame = rowByKey(timing.performance.byFirstEntry, 'started pregame');
    const startLive = rowByKey(timing.performance.byFirstEntry, 'started in-play');
    const majorityPregame = rowByKey(timing.performance.byNotionalMajority, 'majority pregame');
    const majorityLive = rowByKey(timing.performance.byNotionalMajority, 'majority in-play');
    const top = analysis.concentration.winners[0];
    const topLoss = analysis.concentration.losers[0];
    const vision = analysis.caseStudies.find((item) => item.title.includes('TEAM VISION vs Team Spirit (BO5)'));
    const fut = analysis.caseStudies.find((item) => item.title.includes('FURIA vs FUT Esports'));
    const yandexGame = analysis.caseStudies.find((item) => item.title.includes('Team Yandex vs Team Spirit - Game 2'));
    const logitTaker = stats.robustLogit.coefficients.find((item) => item.term === 'taker_share');
    const perTenPointOdds = Math.exp(Math.log(logitTaker.oddsRatio) * 0.1);
    const formatAudit = analysis.performance.formatAudit || {};
    const bo1 = formatAudit.bo1 || {};
    const series = formatAudit.multiMapSeries || rowByKey(perf.byMarketType, 'series winner');
    const singleMap = formatAudit.singleGameOrMap || rowByKey(perf.byMarketType, 'single-game/map');
    const fixed = edge.fixedExternalTapeBacktest;
    const model = edge.walkForwardModel;
    const peerAudit = peers.basket.chronologicalAudit;
    const blind = edge.blindCopyCounterfactual;
    const mechanism = edge.mechanismAudit;
    const calibration = mechanism.calibration;
    const clusteredCalibration = calibration.dayClusterBootstrap;
    const broadControl = mechanism.compositionControls.broadCmh;
    const fineControl = mechanism.compositionControls.finePermutation;
    const rapidPregame = mechanism.byTimingAndUrgency.find((row) =>
        row.key === 'pregame' && row.urgency === 'rapid');
    const rapidInPlay = mechanism.byTimingAndUrgency.find((row) =>
        row.key === 'in-play' && row.urgency === 'rapid');

    return `# Deep Trader Report: @djdjdjekekek

Generated ${analysis.generatedAt}. Coverage: ${isoShort(analysis.coverage.firstTrade)} through ${isoShort(analysis.coverage.lastTrade)}.

## Executive Finding

The candidate edge is **selective directional information expressed through compressed aggressive taker flow**, surrounded by an automated maker/inventory layer. Counting fills hid this: makers are ${percent(execution.makerFillPct)} of fills but only ${percent(execution.makerNotionalPct)} of dollars. Taker fills are just ${percent(100 - execution.makerFillPct)} of count yet carry ${percent(100 - execution.makerNotionalPct)} of quote notional.

The strongest split is not sport versus esports. It is **aggressive versus passive capital**:

| Market subset | Markets | Cost | PnL | ROI | Event-cluster 95% ROI interval |
| --- | ---: | ---: | ---: | ---: | ---: |
| Taker share >= 50% | ${number(highTaker.markets)} | ${money(highTaker.costBasisUsdc)} | ${signedMoney(highTaker.realizedPnlUsdc)} | ${signedPercent(highTaker.roiPct, 2)} | ${signedPercent(highTaker.ci95LowPct, 1)} to ${signedPercent(highTaker.ci95HighPct, 1)} |
| Taker share < 50% | ${number(lowTaker.markets)} | ${money(lowTaker.costBasisUsdc)} | ${signedMoney(lowTaker.realizedPnlUsdc)} | ${signedPercent(lowTaker.roiPct, 2)} | ${signedPercent(lowTaker.ci95LowPct, 1)} to ${signedPercent(lowTaker.ci95HighPct, 1)} |

In a robust logistic model controlling for average entry price, log position size, timing, discipline, market type and concentration, a 10-point increase in taker share multiplies the odds of the dominant outcome winning by about ${perTenPointOdds.toFixed(2)} (full-range coefficient \`p=${logitTaker.pValue.toExponential(2)}\`). This is descriptive, not causal, but it survives controls that the original report omitted.

## Second-Pass Discovery

The first pass contained a consequential semantic bug: titles marked \`(BO1)\` were classified as series winners even though a best-of-one is a single map. Correcting that label exposes a much sharper boundary:

| Format | Markets | Cost | PnL | ROI |
| --- | ---: | ---: | ---: | ---: |
| BO1 alone | ${number(bo1.markets)} | ${money(bo1.costBasisUsdc)} | ${signedMoney(bo1.realizedPnlUsdc)} | ${signedPercent(bo1.roiPct, 2)} |
| True multi-map series | ${number(series.markets)} | ${money(series.costBasisUsdc)} | ${signedMoney(series.realizedPnlUsdc)} | ${signedPercent(series.roiPct, 2)} |
| Single game/map, including BO1 | ${number(singleMap.markets)} | ${money(singleMap.costBasisUsdc)} | ${signedMoney(singleMap.realizedPnlUsdc)} | ${signedPercent(singleMap.roiPct, 2)} |

This is a domain correction consistent with the pre-existing map exclusion, but it was noticed while inspecting final-period losses. It is disclosed as such, not presented as a pristine holdout discovery.

The sign does not depend on that correction. A counterfactual that leaves BO1 eligible as the original classifier did returns ${signedPercent(edge.bo1ClassificationSensitivity.all.roiPct, 2)} over ${number(edge.bo1ClassificationSensitivity.all.bets)} events and ${signedPercent(edge.bo1ClassificationSensitivity.afterFixedSplit.roiPct, 2)} over ${number(edge.bo1ClassificationSensitivity.afterFixedSplit.bets)} events after the same fixed split. The corrected rule is economically better; the counterfactual checks that the positive sign was not manufactured by relabeling BO1.

## What Blind Copying Would Have Done

A follower who copied every first canonical-event signal after the target crossed $25,000 would have placed ${number(blind.all.bets)} equal $100 bets, staked ${money(blind.all.stakeUsdc)}, and lost ${money(Math.abs(blind.all.profitUsdc))}. That is ${signedPercent(blind.all.roiPct, 2)} ROI with a ${money(blind.all.maxDrawdownUsdc)} maximum drawdown. The result did not repair itself later: the ${number(blind.later.bets)} signals after the fixed split lost ${money(Math.abs(blind.later.profitUsdc))} at ${signedPercent(blind.later.roiPct, 2)} ROI.

Blind copying also produced only ${number(blind.all.wins)} wins versus ${number(blind.calibration.expectedWinsFromExecutionProxy, 2)} implied by the execution proxy. Its ${signedPoints(blind.calibration.calibrationGapPctPoints, 1)} calibration gap is ordinary (Poisson-binomial upper-tail \`p=${blind.calibration.poissonBinomialUpperTailPValue.toFixed(3)}\`). That diagnostic assumes independent outcomes and calibrated proxy probabilities; it is not a causal p-value. The large-wager observation alone therefore contains no demonstrated follower edge.

![Chronological equity for blind copying and progressively filtered rules](./figures/strategy_equity.png)

![Nested blind-copy attribution ladder](./figures/blind_copy_funnel.png)

The deeper test replaces the target's later fills with ${number(edge.coverage.publicTakerPrints)} unrelated public taker prints from ${number(edge.coverage.tapeMarkets)} signal markets. Every eligible event is forced into the simulation: after a 60-second lag, execution uses the first direction-neutral public print in the next minute, falls back to the trigger price when none exists, adds five cents adverse slippage, and applies the account-observed 3% fee curve.

| External-tape test | Bets | Wins | ROI |
| --- | ---: | ---: | ---: |
| Earlier 70% | ${number(fixed.train.bets)} | ${number(fixed.train.wins)} | ${signedPercent(fixed.train.roiPct, 2)} |
| Chronological final 30% | ${number(fixed.test.bets)} | ${number(fixed.test.wins)} | ${signedPercent(fixed.test.roiPct, 2)} |
| All eligible events | ${number(fixed.all.bets)} | ${number(fixed.all.wins)} | ${signedPercent(fixed.all.roiPct, 2)} |

The final-period result beats an opposite-side return of ${signedPercent(edge.randomSideFalsification.oppositeSideRoiPct, 2)} and a random-side median of ${signedPercent(edge.randomSideFalsification.randomSideMedianRoiPct, 2)} (one-sided randomization \`p=${edge.randomSideFalsification.randomizationPValue.toFixed(4)}\`). It is still not statistically settled: the day-clustered 95% interval is ${signedPercent(edge.fixedTestDayClusterBootstrap.ci95LowPct, 1)} to ${signedPercent(edge.fixedTestDayClusterBootstrap.ci95HighPct, 1)} across only ${number(edge.fixedTestDayClusterBootstrap.dayClusters)} days.

The mechanism is a **rapid taker sweep**, not eventual wallet size. Signals with most taker notional arriving in the final 60 seconds returned ${signedPercent(edge.subgroups.burst60.roiPct, 2)} versus ${signedPercent(edge.subgroups.notBurst60.roiPct, 2)} without that burst. Meanwhile, initial trigger size predicts eventual cost poorly: chronological log-cost \`R^2=${Number(edge.sizing.chronologicalTest.r2LogCost).toFixed(3)}\`, with ${money(edge.sizing.chronologicalTest.meanAbsoluteErrorUsdc)} mean absolute error. A follower can observe urgency; it cannot reliably infer the target's final stake.

That burst split has the same sign on both sides of the chronological boundary: ${signedPercent(edge.subgroupChronology.earlier70Pct.burst60.roiPct, 1)} versus ${signedPercent(edge.subgroupChronology.earlier70Pct.slower.roiPct, 1)} earlier, and ${signedPercent(edge.subgroupChronology.final30Pct.burst60.roiPct, 1)} versus ${signedPercent(edge.subgroupChronology.final30Pct.slower.roiPct, 1)} in the final period. The full-sample win-rate Fisher test gives \`p=${edge.subgroupChronology.winRateFisherExact.twoSidedPValue.toFixed(4)}\`, but that is a descriptive post-discovery test without feature-search correction.

## Sharpened Mechanism: Conviction Compression

The strongest new diagnostic compares realized wins with the probability visible at the forced execution proxy. Rapid signals won ${number(calibration.burst60.wins)} times; their prices implied only ${number(calibration.burst60.expectedWinsFromExecutionProxy, 2)} wins. That is ${number(calibration.burst60.excessWins, 2)} excess wins and a ${signedPoints(calibration.burst60.calibrationGapPctPoints, 1)} calibration gap. Slower signals produced ${number(calibration.slower.wins)} wins versus ${number(calibration.slower.expectedWinsFromExecutionProxy, 2)} implied, a ${signedPoints(calibration.slower.calibrationGapPctPoints, 1)} gap in the opposite direction.

| Period and urgency | Bets | Actual wins | Proxy-implied wins | Calibration gap | ROI |
| --- | ---: | ---: | ---: | ---: | ---: |
| All rapid | ${number(calibration.burst60.bets)} | ${number(calibration.burst60.wins)} | ${number(calibration.burst60.expectedWinsFromExecutionProxy, 2)} | ${signedPoints(calibration.burst60.calibrationGapPctPoints, 1)} | ${signedPercent(edge.subgroups.burst60.roiPct, 2)} |
| All slower | ${number(calibration.slower.bets)} | ${number(calibration.slower.wins)} | ${number(calibration.slower.expectedWinsFromExecutionProxy, 2)} | ${signedPoints(calibration.slower.calibrationGapPctPoints, 1)} | ${signedPercent(edge.subgroups.notBurst60.roiPct, 2)} |
| Earlier rapid | ${number(calibration.earlier.burst60.bets)} | ${number(calibration.earlier.burst60.wins)} | ${number(calibration.earlier.burst60.expectedWinsFromExecutionProxy, 2)} | ${signedPoints(calibration.earlier.burst60.calibrationGapPctPoints, 1)} | ${signedPercent(edge.subgroupChronology.earlier70Pct.burst60.roiPct, 2)} |
| Earlier slower | ${number(calibration.earlier.slower.bets)} | ${number(calibration.earlier.slower.wins)} | ${number(calibration.earlier.slower.expectedWinsFromExecutionProxy, 2)} | ${signedPoints(calibration.earlier.slower.calibrationGapPctPoints, 1)} | ${signedPercent(edge.subgroupChronology.earlier70Pct.slower.roiPct, 2)} |
| Later rapid | ${number(calibration.later.burst60.bets)} | ${number(calibration.later.burst60.wins)} | ${number(calibration.later.burst60.expectedWinsFromExecutionProxy, 2)} | ${signedPoints(calibration.later.burst60.calibrationGapPctPoints, 1)} | ${signedPercent(edge.subgroupChronology.final30Pct.burst60.roiPct, 2)} |
| Later slower | ${number(calibration.later.slower.bets)} | ${number(calibration.later.slower.wins)} | ${number(calibration.later.slower.expectedWinsFromExecutionProxy, 2)} | ${signedPoints(calibration.later.slower.calibrationGapPctPoints, 1)} | ${signedPercent(edge.subgroupChronology.final30Pct.slower.roiPct, 2)} |

![Realized win rates against execution-proxy implied probabilities](./figures/urgency_calibration.png)

The raw gap is not only an in-play artifact. Rapid signals returned ${signedPercent(rapidPregame.roiPct, 2)} over ${number(rapidPregame.bets)} pregame bets and ${signedPercent(rapidInPlay.roiPct, 2)} over ${number(rapidInPlay.bets)} in-play bets. It is also not exactly one giant transaction: all ${number(mechanism.transactionShape.oneShotSignals)} one-shot signals are mechanically rapid at the threshold timestamp, but ${number(mechanism.transactionShape.multiFillBurstSignals)} rapid multi-fill signals also exist. Those seven all won, which is suggestive but far too small to estimate separately.

Uncertainty cuts both ways. A day-cluster bootstrap estimates the rapid-minus-slow calibration gap at ${signedPoints(clusteredCalibration.burstMinusSlower.estimatePctPoints, 1)}, with a ${signedPoints(clusteredCalibration.burstMinusSlower.ci95LowPctPoints, 1)} to ${signedPoints(clusteredCalibration.burstMinusSlower.ci95HighPctPoints, 1)} interval. A broad Cochran-Mantel-Haenszel control by discipline and price band gives ${broadControl.commonOddsRatio.toFixed(2)}x common win odds (95% CI ${broadControl.ci95Low.toFixed(2)}-${broadControl.ci95High.toFixed(2)}, \`p=${broadControl.twoSidedPValue.toFixed(3)}\`). But a tighter permutation within discipline, three price bands, and chronological period retains only ${number(fineControl.comparableBets)} comparable bets; its effect shrinks to ${signedPoints(fineControl.effectPctPoints, 1)} and is not significant (one-sided \`p=${fineControl.oneSidedPValue.toFixed(3)}\`). The candidate mechanism survives broad controls, not the strongest composition control.

The threshold sweep is smooth rather than isolated at exactly 80%: thresholds from 50% through 99% retain positive ROI, but these overlapping samples are correlated and were analyzed after discovery.

![Burst threshold sensitivity](./figures/burst_threshold_sensitivity.png)

An expanding-window model trained only on markets whose Gamma \`closedTime\` preceded each prediction selected ${number(model.selected.bets)} of ${number(model.predictions)} later signals and returned ${signedPercent(model.selected.roiPct, 2)}, versus ${signedPercent(model.samePeriodAlwaysCopy.roiPct, 2)} for always copying and ${signedPercent(model.samePeriodBurstGate.roiPct, 2)} for the transparent burst gate in the same period. Gamma close-time coverage is ${percent(edge.coverage.gammaClosedTimeCoveragePct, 1)}. Its ROC-AUC is ${Number(model.rocAuc).toFixed(3)}, but the day-cluster interval still reaches ${signedPercent(model.selectedDayClusterBootstrap.ci95LowPct, 1)} and removing its top five winners makes ROI ${signedPercent(model.selected.roiWithoutTopWinnersPct['5'], 1)}. The burst is the primary guard; the model is a secondary paper filter, not proof of deployable alpha.

Ablation supports, but does not prove, the mechanism: removing the 60-second burst feature lowers walk-forward AUC to ${Number(model.ablations.withoutTakerBurst60.rocAuc).toFixed(3)}, removing public-tape momentum and flow lowers it to ${Number(model.ablations.withoutPublicTape.rocAuc).toFixed(3)}, and a price/category-only baseline scores ${Number(model.ablations.priceAndCategoryBaseline.rocAuc).toFixed(3)}.

The peer-leader hypothesis did not survive chronology. ${number(peerAudit.peersSelectedByEarlyRecurrenceOnly)} wallets were selected only from early recurrence; later signals aligned with one returned ${signedPercent(peerAudit.knownPeerAlignedLater.roiPct, 2)}, while signals without alignment returned ${signedPercent(peerAudit.knownPeerNotAlignedLater.roiPct, 2)}. Recurring whales reveal shared market selection, but no stable upstream copier was identified.

## Dataset And Reconstruction

| Measure | Value |
| --- | ---: |
| Public fill rows | ${number(analysis.coverage.trades)} |
| Activity rows | ${number(analysis.coverage.activityRows)} |
| Markets | ${number(analysis.coverage.markets)} |
| Closed positions | ${number(analysis.coverage.closedPositions)} |
| Markets with exact CLOB metadata | ${number(analysis.coverage.marketsWithMetadata)} |
| Markets with game start time | ${number(analysis.coverage.marketsWithGameStart)} |
| Exact target-taker rows collected | ${number(analysis.coverage.takerEndpointTrades)} |
| Public maker-rebate rows | ${number(analysis.coverage.makerRebateRows)} |

The public trade feed occasionally reports one maker sub-fill while the activity row reports the target's full fill in that settlement. The analysis joins the one-to-one transaction hashes and uses activity size/cash as authoritative. This adjusted ${number(execution.publicTradeSizeAdjustedFills)} fills and added ${money(execution.publicTradeQuoteAdjustmentUsdc)} of maker quote notional; join coverage is ${percent(execution.activitySizeJoinCoveragePct)}.

## Maker Versus Taker

| Role | Fills | Share of fills | Quote notional | Share of notional | Median fill | Mean fill |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Maker | ${number(execution.makerFills)} | ${percent(execution.makerFillPct)} | ${money(execution.makerQuoteNotionalUsdc)} | ${percent(execution.makerNotionalPct)} | ${money(execution.medianMakerFillUsdc)} | ${money(execution.meanMakerFillUsdc)} |
| Taker | ${number(execution.takerFills)} | ${percent(100 - execution.makerFillPct)} | ${money(execution.takerQuoteNotionalUsdc)} | ${percent(100 - execution.makerNotionalPct)} | ${money(execution.medianTakerFillUsdc)} | ${money(execution.meanTakerFillUsdc)} |

Classification comes from the Data API's exact \`takerOnly=true\` transaction hashes, independently cross-checked against cash deltas. For example, a 102,269.74-share BUY at 0.32 had ${money(102269.74 * 0.32)} quote value and ${money(33393.93366)} cash cost. The ${money(33393.93366 - 102269.74 * 0.32)} difference exactly equals \`C * 0.03 * p * (1-p)\`.

Observed taker fees total ${money(execution.observedTakerFeesUsdc)}. Public maker rebates total only ${money(execution.publicMakerRebatesUsdc)}, leaving ${money(execution.netFeesLessMakerRebatesUsdc)} of net fee drag before taker rebates. This trader paid for immediacy; maker incentives do not explain the PnL.

This execution pattern is consistent with two systems:

1. Many tiny resting orders capture incidental liquidity, manage inventory, and earn modest rebates.
2. A much smaller number of selected taker blocks express the actual directional thesis.

## Where The Money Was Made

### Discipline

| Discipline | Markets | Cost | PnL | ROI | Taker share |
| --- | ---: | ---: | ---: | ---: | ---: |
${performanceRows(perf.byDiscipline)}

Tennis, soccer, Dota 2 and Counter-Strike account for most positive dollars. MLB is effectively flat, basketball is negative, and crypto 5-minute markets lose ${money(Math.abs(rowByKey(perf.byDiscipline, 'Crypto 5m').realizedPnlUsdc))} at ${signedPercent(rowByKey(perf.byDiscipline, 'Crypto 5m').roiPct, 1)} ROI.

### Market Structure

| Market type | Markets | Cost | PnL | ROI | Taker share |
| --- | ---: | ---: | ---: | ---: | ---: |
${performanceRows(perf.byMarketType)}

Series winners earn ${signedMoney(rowByKey(perf.byMarketType, 'series winner').realizedPnlUsdc)}. Single-game/map bets lose ${money(Math.abs(rowByKey(perf.byMarketType, 'single-game/map').realizedPnlUsdc))}; their event-cluster bootstrap has a ${signedPercent(mapBootstrap.ci95LowPct, 1)} to ${signedPercent(mapBootstrap.ci95HighPct, 1)} interval. The replicator therefore excludes them.

### Timing

${percent(timing.inPlayNotionalPct)} of timed notional trades after the scheduled start, so the account is operationally an in-play trader. Profit attribution says something more specific:

| Construction | Markets | Cost | PnL | ROI |
| --- | ---: | ---: | ---: | ---: |
| First target fill pregame | ${number(startPregame.markets)} | ${money(startPregame.costBasisUsdc)} | ${signedMoney(startPregame.realizedPnlUsdc)} | ${signedPercent(startPregame.roiPct, 2)} |
| First target fill in-play | ${number(startLive.markets)} | ${money(startLive.costBasisUsdc)} | ${signedMoney(startLive.realizedPnlUsdc)} | ${signedPercent(startLive.roiPct, 2)} |
| Majority of notional pregame | ${number(majorityPregame.markets)} | ${money(majorityPregame.costBasisUsdc)} | ${signedMoney(majorityPregame.realizedPnlUsdc)} | ${signedPercent(majorityPregame.roiPct, 2)} |
| Majority of notional in-play | ${number(majorityLive.markets)} | ${money(majorityLive.costBasisUsdc)} | ${signedMoney(majorityLive.realizedPnlUsdc)} | ${signedPercent(majorityLive.roiPct, 2)} |

The edge is not well described as generic live latency arbitrage. Profits cluster in positions established or weighted before play, while live activity often manages or compounds those positions.

## Actual Bets

### 1. TEAM VISION vs Team Spirit, TI 2026 final

The target backed Team Spirit, the eventual 3-2 winner, and earned ${signedMoney(vision?.realizedPnlUsdc)} on ${money(vision?.costBasisUsdc)} cost.

- It crossed ${money(25_000)} of aggressive buys at ${vision?.accumulationMilestones?.[0]?.price?.toFixed(2)} roughly ${Math.abs(vision?.accumulationMilestones?.[0]?.minutesFromStart || 0).toFixed(0)} minutes before start.
- It crossed ${money(1_000_000)} by ${isoShort(vision?.accumulationMilestones?.find((item) => item.thresholdUsdc === 1_000_000)?.time)}, still about ${Math.abs(vision?.accumulationMilestones?.find((item) => item.thresholdUsdc === 1_000_000)?.minutesFromStart || 0).toFixed(0)} minutes pregame.
- Pregame taker buys totaled ${money(vision?.phases?.pregame?.takerBuyQuoteUsdc)}. Only one large in-play taker sell remained.

The [match record](https://liquipedia.net/dota2/Match%3AID_TI2026Main_R05-M001) confirms a five-game 3-2 final. This is a pregame directional position, not a reaction to the final map.

### 2. FURIA vs FUT Esports, EWC semifinal

The target bought ${money(fut?.accumulationMilestones?.[0]?.cumulativeTakerBuyUsdc)} of FUT at about ${fut?.accumulationMilestones?.[0]?.price?.toFixed(3)} in one transaction ${Math.abs(fut?.accumulationMilestones?.[0]?.minutesFromStart || 0).toFixed(1)} minutes before scheduled start. FUT won 2-1, and the position earned ${signedMoney(fut?.realizedPnlUsdc)}. The [match recap](https://www.talkesport.com/news/cs2/fut-vs-furia-cs2-ewc-2026-semifinal-recap/) independently confirms the upset and map score.

This is the cleanest example of the account's high-conviction mode: a seven-figure aggressive block near 45 cents, immediately before the event, followed by an almost complete winner redemption/sale.

### 3. Team Yandex vs Team Spirit, TI lower-bracket final

The same mechanism also produces catastrophic losses. In Game 2, the target began buying Yandex about ${number(yandexGame?.accumulationMilestones?.[0]?.minutesFromStart)} minutes after the series start, crossed ${money(yandexGame?.accumulationMilestones?.[0]?.cumulativeTakerBuyUsdc)} near ${yandexGame?.accumulationMilestones?.[0]?.price?.toFixed(3)}, and ramped past ${money(500_000)}. Team Spirit completed a 2-0 sweep; the game leg lost ${money(Math.abs(yandexGame?.realizedPnlUsdc))}. The [match record](https://liquipedia.net/dota2/Match%3AID_TI2026Main_R04-M002) confirms both map results.

Across the related series, Game 1 and Game 2 conditions, the trader repeatedly selected Yandex. That correlated event group lost roughly ${money(1_546_000)}. This is failed live conviction, not hedging.

## Correlated Event Leakage

| Grouping | Groups / legs | Cost | PnL | ROI |
| --- | ---: | ---: | ---: | ---: |
| All correlated match groups | ${number(correlated.all.groups)} | ${money(correlated.all.costBasisUsdc)} | ${signedMoney(correlated.all.realizedPnlUsdc)} | ${signedPercent(correlated.all.roiPct, 2)} |
| Same direction across conditions | ${number(correlated.sameDirection.groups)} | ${money(correlated.sameDirection.costBasisUsdc)} | ${signedMoney(correlated.sameDirection.realizedPnlUsdc)} | ${signedPercent(correlated.sameDirection.roiPct, 2)} |
| Mixed directions | ${number(correlated.mixedDirection.groups)} | ${money(correlated.mixedDirection.costBasisUsdc)} | ${signedMoney(correlated.mixedDirection.realizedPnlUsdc)} | ${signedPercent(correlated.mixedDirection.roiPct, 2)} |
| Game/map legs inside groups | ${number(correlated.gameMapLegs.conditions)} | ${money(correlated.gameMapLegs.costBasisUsdc)} | ${signedMoney(correlated.gameMapLegs.realizedPnlUsdc)} | ${signedPercent(correlated.gameMapLegs.roiPct, 2)} |

The account often buys the same team in the series and individual maps. That is concentrated duplicate exposure, and it destroyed value even when the series leg won. Team Liquid vs Falcons is the canonical example: the series won about ${money(279_000)}, Game 1 lost about ${money(563_600)}, and Game 2 won about ${money(52_900)}, for a net loss near ${money(231_500)}.

## Capital And PnL Concentration

The largest size quartile earns ${signedMoney(rowByKey(perf.bySizeQuartile, 'Q4 largest').realizedPnlUsdc)} at ${signedPercent(rowByKey(perf.bySizeQuartile, 'Q4 largest').roiPct, 2)} ROI. The other three quartiles lose money in aggregate. Position size is therefore a revealed-confidence signal, not just risk scaling.

The strategy is also fragile:

- Top winner: \`${top.title}\`, ${signedMoney(top.realizedPnlUsdc)}.
- Largest loss: \`${topLoss.title}\`, ${signedMoney(topLoss.realizedPnlUsdc)}.
- Top five gross winners contribute ${percent(analysis.concentration.top5ContributionPct, 1)} of net PnL.
- Removing the top five turns total PnL into ${signedMoney(analysis.concentration.pnlWithoutTop5Usdc)}.
- Maximum closed-market drawdown is ${money(analysis.concentration.maxDrawdownUsdc)}.

Even the high-taker subset falls from ${signedPercent(stats.pnlConcentration.takerShareAtLeast50Pct.all.roiPct, 1)} to ${signedPercent(stats.pnlConcentration.takerShareAtLeast50Pct.withoutTop5.roiPct, 1)} after its top five winners, and turns negative after its top ten. The edge is real in the sample but highly lumpy.

## Reverse-Engineered Edge

**Supported by the data:**

1. Domain selection in tennis, soccer and top esports series.
2. Large aggressive buys as the best observable conviction signal.
3. Pregame thesis formation followed by in-play management or escalation.
4. Automated just-in-time treasury funding and rapid capital recycling.
5. Small maker fills as an execution/inventory layer, not the primary profit center.

**Rejected or not established:**

1. Maker-rebate farming as the main edge. Net observed fee drag is far larger than maker rebates.
2. A universal in-play latency edge. In-play-started markets are roughly flat to negative.
3. Unfiltered copy trading as a stable edge. Blind copying loses ${money(Math.abs(blind.all.profitUsdc))} over ${number(blind.all.bets)} equal-stake signals at ${signedPercent(blind.all.roiPct, 2)} ROI.
4. Stable, diversified alpha. Five winners are required to keep aggregate PnL positive.
5. Map/game duplication. It is the largest identifiable strategy leak.

The closest economic analogy is informed liquidity demand inside a broader liquidity-provision operation. Polymarket pays for resting liquidity, but the empirical prediction-market literature warns that limit orders filled during informative periods can be adversely selected. That framework fits the observed split between many weak maker fills and a small aggressive core; it does not prove the trader possesses private information.

The emphasis on **arrival intensity rather than raw size** has external precedent. [Engle and Lange](https://www.nber.org/papers/w6129) find that market depth falls with transaction count and that asymmetric flow completed faster than expected carries greater trading cost. A 2026 [Polymarket PIN working paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6933527) reports that estimated informed-order-flow intensity is associated with order imbalance, while raw volume effects are not robust. Those studies make conviction compression economically plausible; they do not validate this wallet-level rule.

Measurement work also supports the conservative tape design. A preregistered 2026 [Polymarket microstructure preprint](https://arxiv.org/abs/2604.24366) finds that aggressor direction inferred from the public order-book feed agrees with on-chain ground truth only about 59% of the time. This audit therefore classifies the target from user-specific **takerOnly=true** transaction hashes and uses unrelated public prints only as direction-neutral price marks, never as evidence that another trader chose the same side.

## Statistical Limits

The event-cluster bootstrap gives overall ROI a ${signedPercent(bootstrap(stats, 'all').ci95LowPct, 1)} to ${signedPercent(bootstrap(stats, 'all').ci95HighPct, 1)} interval because profits are concentrated. The chronological descriptive classifier reaches ${Number(stats.chronologicalValidation.model.rocAuc).toFixed(3)} test ROC-AUC, versus ${Number(stats.chronologicalValidation.targetAverageEntryPriceBaseline.rocAuc).toFixed(3)} for average entry price alone, but it uses completed-position features and is not a deployable forecast.

Selection bias remains: this wallet was investigated because it was exceptional. Results cover only ${analysis.coverage.closedPositions} closed positions over roughly two months, event outcomes are dependent, and no public data identifies the trader's information source.

## Sources

- [Polymarket market-data overview](https://docs.polymarket.com/market-data/overview)
- [Polymarket maker rebates and fee curve](https://docs.polymarket.com/programs/maker-rebates)
- [Polymarket Data API trades](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets)
- [Polymarket liquidity rewards](https://docs.polymarket.com/programs/liquidity-rewards)
- [Tetlock, Liquidity and Prediction Market Efficiency](https://business.columbia.edu/faculty/research/liquidity-and-prediction-market-efficiency)
- [Engle and Lange, Measuring, Forecasting and Explaining Time Varying Liquidity](https://www.nber.org/papers/w6129)
- [Le, Beyond Liquidity: Informed Trading in Decentralized Prediction Markets](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6933527)
- [Dubach, The Anatomy of a Decentralized Prediction Market](https://arxiv.org/abs/2604.24366)
- [Bailey et al., The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)
- [BLAST official TI 2026 series results](https://blast.tv/dota/tournaments/the-international-2026/series)
- Structured evidence: [deep_analysis.json](./deep_analysis.json), [statistical_analysis.json](./statistical_analysis.json), [edge_analysis.json](./edge_analysis.json), [peer_evidence.json](./peer_evidence.json), and [edge_features.csv](./edge_features.csv)
`;
}

function replicationReport(analysis, paper, audit, edge) {
    const fixed = edge.fixedExternalTapeBacktest;
    const model = edge.walkForwardModel;
    const config = paper.config;
    const blind = edge.blindCopyCounterfactual;
    const mechanism = edge.mechanismAudit;
    const calibration = mechanism.calibration;
    const broadControl = mechanism.compositionControls.broadCmh;
    const fineControl = mechanism.compositionControls.finePermutation;
    const formatAudit = analysis.performance.formatAudit || {};
    const slips = edge.executionSensitivity
        .filter((row) => row.lagSeconds === fixed.lagSeconds)
        .sort((a, b) => a.slippageCents - b.slippageCents);
    const lags = edge.executionSensitivity
        .filter((row) => row.slippageCents === fixed.slippageCents)
        .sort((a, b) => a.lagSeconds - b.lagSeconds);
    const slipRows = slips.map((row) =>
        `| ${row.slippageCents}c | ${signedPercent(row.train.roiPct, 2)} | ${signedPercent(row.test.roiPct, 2)} | ${signedPercent(row.all.roiPct, 2)} |`
    ).join('\n');
    const lagRows = lags.map((row) =>
        `| ${row.lagSeconds}s | ${percent(row.publicPrintCoveragePct, 1)} | ${signedPercent(row.train.roiPct, 2)} | ${signedPercent(row.test.roiPct, 2)} | ${signedPercent(row.all.roiPct, 2)} |`
    ).join('\n');
    const universeLabels = [
        ['allCanonicalSignals', 'All canonical $25K signals'],
        ['rapidBurst', 'Add rapid 60-second burst'],
        ['rapidBurstAndFormatGuard', 'Add map/short-market exclusion'],
        ['rapidBurstFormatAndCoreDisciplines', 'Add core disciplines'],
        ['fullRuleWithPriceGuard', 'Add 0.30-0.85 price guard']
    ];
    const universeRows = universeLabels.map(([key, label]) => {
        const row = edge.universeSensitivity.steps[key];
        return `| ${label} | ${number(row.all.bets)} | ${signedPercent(row.all.roiPct, 2)} | ${number(row.afterFixedSplit.bets)} | ${signedPercent(row.afterFixedSplit.roiPct, 2)} |`;
    }).join('\n');

    return `# Replication Prototype: External-Tape Backtest

Generated ${paper.generatedAt}. This implementation is paper-only and contains no signing or order-submission path.

## What Changed

The earlier prototype used the target's next future BUY as an execution proxy. That leaked the target's later behavior into fill selection and could not answer whether an unrelated follower had a tradable price. The replacement uses market-wide public taker prints and never consults a later target fill to decide execution.

| Component | Locked behavior |
| --- | --- |
| Signal | Exact target taker BUY flow crosses ${money(config.strategy.thresholdUsdc)} at >=${percent(config.strategy.concentration * 100)} directional concentration |
| Urgency guard | At least ${percent(config.strategy.minimumTakerBurst60Share * 100)} of observed target taker BUY notional arrived in the final 60 seconds |
| Eligibility | Allowed disciplines, price ${config.strategy.minPrice.toFixed(2)}-${config.strategy.maxPrice.toFixed(2)}, no single-map/BO1 or short-horizon market |
| Event control | First eligible condition per canonical event |
| Delay | ${number(fixed.lagSeconds)} seconds after the signal |
| Historical price | First direction-neutral public taker print in the next 60 seconds; trigger fallback if absent |
| Cost stress | ${fixed.slippageCents} cents adverse movement plus the account-observed 3% fee curve |
| Live paper execution | Marketable limit at the current ask, FOK, rejected above trigger + ${config.maxAdverseMove.toFixed(2)} or when displayed ask depth is insufficient |
| Sizing | Fixed bankroll fraction; no attempt to predict the target's final position |
| Model gate | Predicted win probability minus all-in price must exceed ${percent(config.edgeModel.minimumPredictedEdge * 100)} |

The BO1 exclusion is important. The corrected audit records a ${money(Math.abs(formatAudit.bo1?.realizedPnlUsdc))} loss across ${number(formatAudit.bo1?.markets)} BO1 markets rather than hiding them inside the profitable series bucket.

Because that correction was found after inspecting final losses, the audit also preserves the original-classifier counterfactual. Keeping BO1 eligible returns ${signedPercent(edge.bo1ClassificationSensitivity.all.roiPct, 2)} over ${number(edge.bo1ClassificationSensitivity.all.bets)} events and ${signedPercent(edge.bo1ClassificationSensitivity.afterFixedSplit.roiPct, 2)} over ${number(edge.bo1ClassificationSensitivity.afterFixedSplit.bets)} events after the same fixed boundary. Its later ROI after removing the top three winners is ${signedPercent(edge.bo1ClassificationSensitivity.afterFixedSplit.roiWithoutTopWinnersPct['3'], 2)}.

## Blind-Copy Baseline

The literal copy strategy is rejected before model selection. Copying every first canonical-event signal produces ${number(blind.all.bets)} bets, ${signedMoney(blind.all.profitUsdc)} P&L, ${signedPercent(blind.all.roiPct, 2)} ROI, and a ${money(blind.all.maxDrawdownUsdc)} maximum drawdown at $100 per signal. It remains negative after the fixed split: ${number(blind.later.bets)} bets, ${signedMoney(blind.later.profitUsdc)}, ${signedPercent(blind.later.roiPct, 2)} ROI. Removing its best five winners worsens all-period ROI to ${signedPercent(blind.all.roiWithoutTopWinnersPct['5'], 2)}.

This matters because the ${number(fixed.all.bets)}-event primary test below is already a restricted universe. Its positive result must not be described as the return from blindly following the account.

![Chronological blind-copy and filtered-rule equity](./figures/strategy_equity.png)

## Primary Historical Test

This test includes all ${number(fixed.all.bets)} eligible events. It does not discard signals lacking a convenient future print: ${number(fixed.all.fallbackPrices)} use the trigger-price fallback. Public-print coverage is ${percent(fixed.publicPrintCoveragePct, 2)}.

| Period | Bets | Wins | P&L ($100 per bet) | ROI | Max drawdown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Earlier 70% | ${number(fixed.train.bets)} | ${number(fixed.train.wins)} | ${signedMoney(fixed.train.profitUsdc)} | ${signedPercent(fixed.train.roiPct, 2)} | ${money(fixed.train.maxDrawdownUsdc)} |
| Chronological final 30% | ${number(fixed.test.bets)} | ${number(fixed.test.wins)} | ${signedMoney(fixed.test.profitUsdc)} | ${signedPercent(fixed.test.roiPct, 2)} | ${money(fixed.test.maxDrawdownUsdc)} |
| All | ${number(fixed.all.bets)} | ${number(fixed.all.wins)} | ${signedMoney(fixed.all.profitUsdc)} | ${signedPercent(fixed.all.roiPct, 2)} | ${money(fixed.all.maxDrawdownUsdc)} |

The final-period IID bootstrap interval is ${signedPercent(edge.fixedTestBootstrap.ci95LowPct, 1)} to ${signedPercent(edge.fixedTestBootstrap.ci95HighPct, 1)}. Clustering by trading day widens it to ${signedPercent(edge.fixedTestDayClusterBootstrap.ci95LowPct, 1)} to ${signedPercent(edge.fixedTestDayClusterBootstrap.ci95HighPct, 1)} across ${number(edge.fixedTestDayClusterBootstrap.dayClusters)} days. Both cross zero.

The side falsification is harder to dismiss: target direction returned ${signedPercent(edge.randomSideFalsification.actualTargetRoiPct, 2)}, the opposite direction ${signedPercent(edge.randomSideFalsification.oppositeSideRoiPct, 2)}, and randomized sides had a ${signedPercent(edge.randomSideFalsification.randomSideMedianRoiPct, 2)} median (one-sided \`p=${edge.randomSideFalsification.randomizationPValue.toFixed(4)}\`). That supports directional information in this period; it does not remove wallet-selection bias.

## Universe Attribution

Blindly copying every canonical seed signal loses money. The nested ladder shows which observable guards change that result, using the same fixed ${edge.universeSensitivity.splitDate} boundary for every row:

| Nested rule | All bets | All ROI | Bets after split | ROI after split |
| --- | ---: | ---: | ---: | ---: |
${universeRows}

Urgency is the first rule that flips the sign; market format adds the largest structural improvement. Discipline and price increase ROI further but were informed by this investigated sample, so the ladder is attribution rather than five independent strategy trials.

![Nested rule attribution from blind copying to the exploratory full rule](./figures/blind_copy_funnel.png)

## Mechanism Audit

The candidate mechanism is **conviction compression**: most target taker buying arrives in one minute, but the next unrelated execution proxy still understates how often that side wins. Rapid signals record ${number(calibration.burst60.wins)} wins against ${number(calibration.burst60.expectedWinsFromExecutionProxy, 2)} implied (${signedPoints(calibration.burst60.calibrationGapPctPoints, 1)}); slower signals record ${number(calibration.slower.wins)} against ${number(calibration.slower.expectedWinsFromExecutionProxy, 2)} implied (${signedPoints(calibration.slower.calibrationGapPctPoints, 1)}).

![Urgency-conditioned probability calibration](./figures/urgency_calibration.png)

The day-clustered rapid-minus-slow calibration interval is ${signedPoints(calibration.dayClusterBootstrap.burstMinusSlower.ci95LowPctPoints, 1)} to ${signedPoints(calibration.dayClusterBootstrap.burstMinusSlower.ci95HighPctPoints, 1)} around a ${signedPoints(calibration.dayClusterBootstrap.burstMinusSlower.estimatePctPoints, 1)} estimate. Broad discipline/price stratification leaves ${broadControl.commonOddsRatio.toFixed(2)}x common win odds (\`p=${broadControl.twoSidedPValue.toFixed(3)}\`). The stronger falsification is less favorable: permuting urgency labels within discipline, three price bands, and chronological period reduces the effect to ${signedPoints(fineControl.effectPctPoints, 1)} across ${number(fineControl.comparableBets)} comparable bets, with one-sided \`p=${fineControl.oneSidedPValue.toFixed(3)}\`. That non-result is why the mechanism remains provisional.

Thresholds from 50% through 99% remain positive, so 80% is not a single lucky cut. They reuse overlapping bets, however, and do not count as independent confirmations.

![Burst-share threshold sensitivity](./figures/burst_threshold_sensitivity.png)

## Execution Stress

### Slippage at a 60-second delay

| Adverse stress | Earlier 70% | Final 30% | All |
| --- | ---: | ---: | ---: |
${slipRows}

![ROI under adverse execution stress](./figures/execution_sensitivity.png)

### Delay at five-cent stress

| Delay | Print coverage | Earlier 70% | Final 30% | All |
| --- | ---: | ---: | ---: | ---: |
${lagRows}

The public market usually did not reprice immediately: median target-direction markout is ${Number(Math.abs(edge.marketResponse['60'].median) < 0.00005 ? 0 : edge.marketResponse['60'].median).toFixed(4)} after 60 seconds and ${Number(Math.abs(edge.marketResponse['300'].median) < 0.00005 ? 0 : edge.marketResponse['300'].median).toFixed(4)} after five minutes. This gives a follower time in the observed tape, but a print proves neither available ask depth nor a fill for our order size.

The lag rows reuse the same outcomes and are sensitivity checks, not five independent trials. The 300-second row must not be selected retrospectively as an "optimal" delay.

## Leakage And Selection Audit

Requiring a future same-direction print looked reasonable but was outcome-dependent. ${number(edge.executionSelectionAudit.noAlignedPrint.signals)} signals had no aligned print and only ${number(edge.executionSelectionAudit.noAlignedPrint.wins)} won; ${number(edge.executionSelectionAudit.noAnyPrint.signals)} had no print at all and none won. Excluding them mechanically inflated ROI. The primary test therefore uses direction-neutral prints and a forced fallback.

A second guard tested twelve simple refinements on a 50/20/30 split. The selected \`${edge.lockedRefinement.selected.name}\` gate returned ${signedPercent(edge.lockedRefinement.selected.development.roiPct, 1)} in development, ${signedPercent(edge.lockedRefinement.selected.validation.roiPct, 1)} in validation, then ${signedPercent(edge.lockedRefinement.selected.finalTest.roiPct, 1)} in the final slice. That reversal is a direct warning against narrating one attractive subgroup as a law.

## Walk-Forward Filter

The deployable feature set is observable at signal time: trigger price, concentration, trigger-fill share, 60-second taker-burst share, prior maker share, signal age, five-minute public momentum and flow, pregame status, deposit lag, discipline and market type. For each prediction, training includes only earlier markets whose Gamma \`closedTime\` had passed. Coverage is ${percent(edge.coverage.gammaClosedTimeCoveragePct, 1)}; the ambiguous closed-position timestamp is not used for label availability.

| Walk-forward measure | Result |
| --- | ---: |
| Warmup / predictions | 40 / ${number(model.predictions)} |
| ROC-AUC | ${Number(model.rocAuc).toFixed(3)} |
| Selected | ${number(model.selected.bets)} bets, ${number(model.selected.wins)} wins |
| Selected ROI | ${signedPercent(model.selected.roiPct, 2)} |
| Same-period burst-only ROI | ${signedPercent(model.samePeriodBurstGate.roiPct, 2)} on ${number(model.samePeriodBurstGate.bets)} bets |
| Same-period always-copy ROI | ${signedPercent(model.samePeriodAlwaysCopy.roiPct, 2)} |
| Day-cluster 95% interval | ${signedPercent(model.selectedDayClusterBootstrap.ci95LowPct, 1)} to ${signedPercent(model.selectedDayClusterBootstrap.ci95HighPct, 1)} |
| ROI after removing top 3 / top 5 winners | ${signedPercent(model.selected.roiWithoutTopWinnersPct['3'], 1)} / ${signedPercent(model.selected.roiWithoutTopWinnersPct['5'], 1)} |
| Positive C/threshold sensitivity cells | ${number(model.positiveSensitivityConfigurations)} / 20 |

| Feature ablation | Walk-forward ROC-AUC |
| --- | ---: |
| Full observable feature set | ${Number(model.rocAuc).toFixed(3)} |
| Remove 60-second target burst | ${Number(model.ablations.withoutTakerBurst60.rocAuc).toFixed(3)} |
| Remove public-tape momentum and flow | ${Number(model.ablations.withoutPublicTape.rocAuc).toFixed(3)} |
| Price and category only | ${Number(model.ablations.priceAndCategoryBaseline.rocAuc).toFixed(3)} |

The transparent burst gate improves the same-period baseline before modeling. The model raises ROI from ${signedPercent(model.samePeriodBurstGate.roiPct, 2)} to ${signedPercent(model.selected.roiPct, 2)}, but model ROI turns ${signedPercent(model.selected.roiWithoutTopWinnersPct['3'], 1)} after removing its top three winners versus ${signedPercent(model.samePeriodBurstGate.roiWithoutTopWinnersPct['3'], 1)} for the burst gate. The model is therefore secondary to the mandatory burst guard.

The model is not using unresolved labels, but ${number(model.selected.bets)} bets are too few for deployment. The model family and features were designed during this investigation, so this is pseudo-out-of-sample evidence rather than a locked prospective trial. Its fit on all historical rows is used only to score forward paper signals; that in-sample fit is not counted as evidence.

## Paper Monitor

The monitor reconstructs target taker flow, enriches surviving candidates with the current book and the same one-hour market-wide tape window used in training, checks displayed ask depth, scores the frozen model, and emits a ${config.executionMode} paper intent only when price, depth, and edge guards pass. Current saved-data run: ${number(paper.intents.length)} intents from ${number(paper.candidatesBeforeBook)} pre-book candidates, with ${money(paper.risk.proposedNotionalUsdc)} proposed exposure. Zero is expected because the fixed snapshot contains no fresh signal.

| Risk control | Default |
| --- | ---: |
| Mode | \`${config.mode}\` |
| Paper bankroll | ${money(config.bankrollUsdc)} |
| Per-order cap | min(${money(config.maxOrderUsdc)}, ${percent(config.maxOrderBankrollPct)} of bankroll) |
| Per-event cap | ${percent(config.maxEventBankrollPct)} of bankroll |
| Portfolio cap | ${percent(config.maxPortfolioBankrollPct)} of bankroll |
| Maximum adverse move | ${config.maxAdverseMove.toFixed(2)} |
| Time in force | FOK; intent expires after ${number(config.cancelAfterSeconds)} seconds |

Before considering capital, the locked model needs a forward paper sample with stored order-book snapshots, observed FOK outcomes, depth slippage, and at least 200 eligible signals. The current code intentionally cannot trade.

## Reproduce

- \`npm run research:tape\` collects [market_tape.json](./market_tape.json).
- \`npm run research:edge\` builds [edge_analysis.json](./edge_analysis.json), [edge_features.csv](./edge_features.csv), and [edge_model.json](./edge_model.json).
- \`npm run research:graphics\` rebuilds every PNG/SVG in [figures](./figures/).
- \`npm run research:replicate\` rebuilds [replication_intents.json](./replication_intents.json), [replicator_config.json](./replicator_config.json), and [replication_backtest.json](./replication_backtest.json).
- Historical audit contains ${number(audit.fixedExternalTapeBacktest?.all?.bets || fixed.all.bets)} forced simulations.

## Limits

- Public prints do not reconstruct historical ask depth or queue priority.
- Five cents is a stress assumption, not a guaranteed executable price.
- The wallet was selected after exceptional performance; standard intervals do not correct that selection.
- Outcomes and trading days remain dependent, and the sample covers roughly two months.
- The broad calibration result weakens under the tightest discipline/price/time composition control.
- This is research software, not financial advice.
`;
}

function breakthroughReport(analysis, edge, peers) {
    const format = analysis.performance.formatAudit;
    const fixed = edge.fixedExternalTapeBacktest;
    const model = edge.walkForwardModel;
    const burst = edge.subgroups.burst60;
    const noBurst = edge.subgroups.notBurst60;
    const peerAudit = peers.basket.chronologicalAudit;
    const spcex = peers.peers.find((peer) => peer.name === 'SPCEXBUYER') || {};
    const blind = edge.blindCopyCounterfactual;
    const mechanism = edge.mechanismAudit;
    const calibration = mechanism.calibration;
    const broadControl = mechanism.compositionControls.broadCmh;
    const fineControl = mechanism.compositionControls.finePermutation;

    return `# Breakthrough Audit

Generated ${edge.generatedAt}. This is the shortest path through the second-pass investigation.

## Discovery

The account's repeatable-looking signal is not simply "large bet" and not "copy a winning whale." Blindly copying every canonical $25,000 signal would have lost ${money(Math.abs(blind.all.profitUsdc))} over ${number(blind.all.bets)} equal $100 bets (${signedPercent(blind.all.roiPct, 2)} ROI), including ${signedPercent(blind.later.roiPct, 2)} after the fixed chronological split.

The narrower candidate is a **rapid, concentrated taker sweep in a full-match or multi-map market**, followed by enough market inertia for a delayed observer to see a similar public price.

Four pieces of evidence support that narrower claim:

1. Blind copying loses ${signedPercent(blind.all.roiPct, 2)} overall and ${signedPercent(blind.later.roiPct, 2)} later. Urgency is the first observable filter that changes the sign.
2. Correcting BO1 semantics separates ${number(format.multiMapSeries.markets)} true multi-map series at ${signedPercent(format.multiMapSeries.roiPct, 2)} ROI from ${number(format.singleGameOrMap.markets)} single-game/map markets at ${signedPercent(format.singleGameOrMap.roiPct, 2)}. The ${number(format.bo1.markets)} mislabeled BO1 rows alone lost ${money(Math.abs(format.bo1.realizedPnlUsdc))}.
3. On an unrelated market-wide tape, a forced 60-second copy with five cents adverse stress returned ${signedPercent(fixed.all.roiPct, 2)} over ${number(fixed.all.bets)} already-filtered events and ${signedPercent(fixed.test.roiPct, 2)} over the chronological final ${number(fixed.test.bets)}.
4. Signals concentrated into the final 60 seconds returned ${signedPercent(burst.roiPct, 2)}; slower accumulations returned ${signedPercent(noBurst.roiPct, 2)}. Rapid signals won ${number(calibration.burst60.wins)} times versus ${number(calibration.burst60.expectedWinsFromExecutionProxy, 2)} implied by the execution proxy, while slow signals underperformed their proxy.

![Blind-copy attribution ladder](./figures/blind_copy_funnel.png)

## What Survived Falsification

| Test | Result | Interpretation |
| --- | ---: | --- |
| Opposite side, final period | ${signedPercent(edge.randomSideFalsification.oppositeSideRoiPct, 2)} | Direction matters |
| Random-side test | one-sided \`p=${edge.randomSideFalsification.randomizationPValue.toFixed(4)}\` | Better than side choice alone in this slice |
| All canonical signals | ${signedPercent(edge.universeSensitivity.steps.allCanonicalSignals.all.roiPct, 2)} all / ${signedPercent(edge.universeSensitivity.steps.allCanonicalSignals.afterFixedSplit.roiPct, 2)} later | Blind copying fails |
| Add rapid burst | ${signedPercent(edge.universeSensitivity.steps.rapidBurst.all.roiPct, 2)} all / ${signedPercent(edge.universeSensitivity.steps.rapidBurst.afterFixedSplit.roiPct, 2)} later | Urgency flips the sign |
| Add format guard | ${signedPercent(edge.universeSensitivity.steps.rapidBurstAndFormatGuard.all.roiPct, 2)} all / ${signedPercent(edge.universeSensitivity.steps.rapidBurstAndFormatGuard.afterFixedSplit.roiPct, 2)} later | One-map/short markets are the main structural leak |
| Five-cent all-period stress | ${signedPercent(fixed.all.roiPct, 2)} | Positive after fee and adverse-price stress |
| Keep BO1 eligible | ${signedPercent(edge.bo1ClassificationSensitivity.all.roiPct, 2)} all / ${signedPercent(edge.bo1ClassificationSensitivity.afterFixedSplit.roiPct, 2)} later | Positive sign survives the classification correction |
| Ten-cent all-period stress | ${signedPercent(edge.executionSensitivity.find((row) => row.lagSeconds === 60 && row.slippageCents === 10).all.roiPct, 2)} | Aggregate edge is exhausted near this cost |
| 60-second median markout | ${Number(Math.abs(edge.marketResponse['60'].median) < 0.00005 ? 0 : edge.marketResponse['60'].median).toFixed(4)} | No median immediate repricing in public tape |
| Burst gate, same walk-forward period | ${number(model.samePeriodBurstGate.bets)} bets / ${signedPercent(model.samePeriodBurstGate.roiPct, 2)} | Transparent primary selector |
| Model after burst behavior | ${number(model.selected.bets)} bets / ${signedPercent(model.selected.roiPct, 2)} | Secondary filter; more top-winner concentration |
| Remove burst feature | AUC ${Number(model.ablations.withoutTakerBurst60.rocAuc).toFixed(3)} vs ${Number(model.rocAuc).toFixed(3)} full | Burst adds predictive information in this sample |
| Remove public-tape features | AUC ${Number(model.ablations.withoutPublicTape.rocAuc).toFixed(3)} | External flow and momentum add information |
| Rapid calibration gap | ${signedPoints(calibration.burst60.calibrationGapPctPoints, 1)} | 41 actual wins versus ${number(calibration.burst60.expectedWinsFromExecutionProxy, 2)} implied |
| Slow calibration gap | ${signedPoints(calibration.slower.calibrationGapPctPoints, 1)} | Public proxy does not underprice slow signals |
| Broad discipline/price control | OR ${broadControl.commonOddsRatio.toFixed(2)}, \`p=${broadControl.twoSidedPValue.toFixed(3)}\` | Candidate survives broad composition control |
| Fine discipline/price/time permutation | ${signedPoints(fineControl.effectPctPoints, 1)}, \`p=${fineControl.oneSidedPValue.toFixed(3)}\` | Candidate does not survive the tightest low-power control |

The result is directional and execution-sensitive. It is not yet statistically decisive: the fixed final-period day-cluster interval is ${signedPercent(edge.fixedTestDayClusterBootstrap.ci95LowPct, 1)} to ${signedPercent(edge.fixedTestDayClusterBootstrap.ci95HighPct, 1)}, and the walk-forward interval is ${signedPercent(model.selectedDayClusterBootstrap.ci95LowPct, 1)} to ${signedPercent(model.selectedDayClusterBootstrap.ci95HighPct, 1)}. Feature design occurred during this investigation, so the expanding-window result is not equivalent to a locked prospective trial.

## Sharpened Discovery

The most specific defensible hypothesis is **conviction compression**. The target's information appears strongest when it crosses liquidity quickly enough that at least 80% of observed aggressive buying arrives in one minute. The unrelated public execution proxy remains nearly unchanged, yet those sides later win ${percent(calibration.burst60.actualWinRatePct, 1)} of the time against ${percent(calibration.burst60.meanImpliedProbabilityPct, 1)} implied. Slow signals win only ${percent(calibration.slower.actualWinRatePct, 1)} against ${percent(calibration.slower.meanImpliedProbabilityPct, 1)} implied.

![Urgency-conditioned realized and implied probabilities](./figures/urgency_calibration.png)

The day-cluster bootstrap estimates a ${signedPoints(calibration.dayClusterBootstrap.burstMinusSlower.estimatePctPoints, 1)} rapid-minus-slow calibration gap with a ${signedPoints(calibration.dayClusterBootstrap.burstMinusSlower.ci95LowPctPoints, 1)} to ${signedPoints(calibration.dayClusterBootstrap.burstMinusSlower.ci95HighPctPoints, 1)} interval. This is stronger than the ROI interval because it asks whether the target side wins more often than its observed price implies, not how a few long-shot payouts happened to land.

The negative control is equally important. Tight conditioning by discipline, three price bands, and chronological period leaves only ${number(fineControl.comparableBets)} comparable observations; permuting urgency labels within those strata produces one-sided \`p=${fineControl.oneSidedPValue.toFixed(3)}\`. Composition may explain part of the raw effect. The next genuine discovery must come from a prospectively locked forward sample, not another retrospective slice.

External microstructure research makes this hypothesis plausible without confirming it. [Engle and Lange](https://www.nber.org/papers/w6129) connect faster asymmetric transaction flow to thinner depth and higher trading costs; a 2026 [Polymarket informed-trading working paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6933527) finds order imbalance more robust than raw volume. This audit's sharper variable is therefore temporal concentration, not eventual stake. Neither paper tests this wallet or removes the need for prospective validation.

![Chronological equity under blind and filtered rules](./figures/strategy_equity.png)

## What Failed

**Predicting final size failed.** Trigger-fill share and deposit size correlate only ${Number(edge.sizing.triggerFillToFinalCostCorrelation).toFixed(3)} and ${Number(edge.sizing.depositToFinalCostCorrelation).toFixed(3)} with final cost. The chronological sizing model has \`R^2=${Number(edge.sizing.chronologicalTest.r2LogCost).toFixed(3)}\`. Fixed fractional sizing is more defensible than mirroring eventual target exposure.

**A stable upstream leader was not found.** ${number(peers.peers.length)} recurring wallets were audited. ${spcex.name} is the most interesting: it entered before ${number(spcex.enteredBeforeTarget)} of ${number(spcex.sharedTargetSignals)} shared signals, aligned ${number(spcex.alignedBeforeTarget)} times, opposed ${number(spcex.opposedBeforeTarget)} times, and led aligned trades by a median ${number(spcex.medianLastLeadSeconds)} seconds. All ${number(spcex.alignedBeforeTarget)} aligned directions won, but the near-even alignment/opposition split prevents a copying claim.

Chronology rejects peer confirmation as a filter. Peers selected only from early recurrence aligned with ${number(peerAudit.knownPeerAlignedLater.bets)} later bets at ${signedPercent(peerAudit.knownPeerAlignedLater.roiPct, 2)} ROI; the ${number(peerAudit.knownPeerNotAlignedLater.bets)} later bets without alignment returned ${signedPercent(peerAudit.knownPeerNotAlignedLater.roiPct, 2)}. The production model excludes peer identity.

**Simple subgroup hunting failed validation.** The chosen fresh-signal rule went from ${signedPercent(edge.lockedRefinement.selected.development.roiPct, 1)} in development to ${signedPercent(edge.lockedRefinement.selected.validation.roiPct, 1)} in validation before rebounding. That instability is exactly why the external-tape baseline and expanding-window test carry more weight than the best subgroup.

## Mechanism

The evidence is most consistent with informed liquidity demand:

1. The target pays taker fees to cross quickly when conviction appears.
2. The first burst contains more information than the eventual position size.
3. Rapid signals outperform their public probability proxy; slow signals do not.
4. Public price response is often flat for 15-300 seconds, leaving a limited observation window.
5. Full-match and multi-map theses work; one-map bets destroy value.
6. Other whales visit the same markets, but no wallet consistently leads and agrees.

This mechanism is an inference from transaction behavior. It does not identify a private information source or prove causality.

## Decision

There is enough evidence to run the frozen walk-forward filter in paper mode. There is not enough evidence to deploy capital. Promotion would require at least 200 new eligible signals, executable-depth snapshots, FOK failure accounting, a prospectively locked urgency/format rule, stable clustered confidence bounds above zero, and positive ROI after the top five winners are removed.

## Evidence

- [External tape and fixed tests](./edge_analysis.json)
- [Signal-level feature table](./edge_features.csv)
- [Frozen paper model](./edge_model.json)
- [Peer-wallet audit](./peer_evidence.json)
- [Replication implementation](../../src/research/replicator.js)
- [Polymarket Data API trade documentation](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets)
- [Polymarket Gamma market schema](https://docs.polymarket.com/api-reference/markets/list-markets)
- [Prediction-market price formation research](https://www.sciencedirect.com/science/article/pii/S1386418123000794)
- [Engle and Lange, Measuring, Forecasting and Explaining Time Varying Liquidity](https://www.nber.org/papers/w6129)
- [Le, Beyond Liquidity: Informed Trading in Decentralized Prediction Markets](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6933527)
- [Dubach, The Anatomy of a Decentralized Prediction Market](https://arxiv.org/abs/2604.24366)
- [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)
`;
}

function executiveReport(analysis, stats, onchain, edge, peers) {
    const execution = analysis.execution;
    const high = bootstrap(stats, 'takerShareAtLeast50Pct');
    const format = analysis.performance.formatAudit;
    const fixed = edge.fixedExternalTapeBacktest;
    const model = edge.walkForwardModel;
    const peerAudit = peers.basket.chronologicalAudit;
    const blind = edge.blindCopyCounterfactual;
    const calibration = edge.mechanismAudit.calibration;
    const fineControl = edge.mechanismAudit.compositionControls.finePermutation;

    return `# @djdjdjekekek: Investigation And Replication Research

## Result

The account is a two-layer automated operation: ${percent(execution.makerFillPct)} of fills are maker executions, while ${percent(100 - execution.makerNotionalPct)} of quote notional is aggressive taker flow. The deeper discovery is narrower: **rapid target taker sweeps in full-match or multi-map markets contain a delayed, execution-sensitive directional signal.**

| Evidence | Result |
| --- | ---: |
| Confirmed economic result | ${money(analysis.cash.confirmedEconomicProfitUsdc)} extracted above deposits |
| High-taker market subset | ${signedPercent(high.roiPct, 2)} ROI; clustered interval ${signedPercent(high.ci95LowPct, 1)} to ${signedPercent(high.ci95HighPct, 1)} |
| True multi-map series | ${number(format.multiMapSeries.markets)} markets, ${signedMoney(format.multiMapSeries.realizedPnlUsdc)}, ${signedPercent(format.multiMapSeries.roiPct, 2)} ROI |
| Single game/map including BO1 | ${number(format.singleGameOrMap.markets)} markets, ${signedMoney(format.singleGameOrMap.realizedPnlUsdc)}, ${signedPercent(format.singleGameOrMap.roiPct, 2)} ROI |
| Forced external-tape backtest | ${number(fixed.all.bets)} bets, ${signedPercent(fixed.all.roiPct, 2)} all-period ROI |
| Blind all-signal external-tape copy | ${number(blind.all.bets)} bets, ${signedMoney(blind.all.profitUsdc)}, ${signedPercent(blind.all.roiPct, 2)} all / ${signedPercent(blind.later.roiPct, 2)} later |
| Rapid-signal calibration | ${number(calibration.burst60.wins)} wins vs ${number(calibration.burst60.expectedWinsFromExecutionProxy, 2)} implied; ${signedPoints(calibration.burst60.calibrationGapPctPoints, 1)} |
| Tight composition control | ${signedPoints(fineControl.effectPctPoints, 1)} across ${number(fineControl.comparableBets)} comparable bets; one-sided \`p=${fineControl.oneSidedPValue.toFixed(3)}\` |
| Original-classifier BO1 counterfactual | ${number(edge.bo1ClassificationSensitivity.all.bets)} bets, ${signedPercent(edge.bo1ClassificationSensitivity.all.roiPct, 2)} all / ${signedPercent(edge.bo1ClassificationSensitivity.afterFixedSplit.roiPct, 2)} later |
| Chronological final period | ${number(fixed.test.bets)} bets, ${signedPercent(fixed.test.roiPct, 2)} ROI; day-cluster interval ${signedPercent(edge.fixedTestDayClusterBootstrap.ci95LowPct, 1)} to ${signedPercent(edge.fixedTestDayClusterBootstrap.ci95HighPct, 1)} |
| Expanding-window model | ${number(model.selected.bets)} selected bets, ${signedPercent(model.selected.roiPct, 2)} ROI; ROC-AUC ${Number(model.rocAuc).toFixed(3)} |

![Blind-copy and filtered-rule equity](./figures/strategy_equity.png)

## Corrections And Rejections

The original classifier treated BO1 as a series. Correcting it moves ${number(format.bo1.markets)} markets that lost ${money(Math.abs(format.bo1.realizedPnlUsdc))} into the single-map failure bucket. This correction was found while inspecting final losses and is explicitly not claimed as an untouched discovery.

The external backtest also fixes a more serious execution leak: it no longer uses the target's next future fill as the follower's price. It uses ${number(edge.coverage.publicTakerPrints)} unrelated market-wide prints, forces no-print signals into the test, adds five cents adverse slippage, applies fees, and permits only one condition per event.

No stable leader wallet was identified. Early-selected peer confirmation returned ${signedPercent(peerAudit.knownPeerAlignedLater.roiPct, 2)} on later bets, below the ${signedPercent(peerAudit.knownPeerNotAlignedLater.roiPct, 2)} return without confirmation. Eventual target size was also unpredictable. Neither peer identity nor inferred final size belongs in the model.

## Onchain Attribution

The type-3 Deposit Wallet resolves to controller EOA \`${onchain.wallet.owner}\`. That owner directly transacted with the EIP-7702 account responsible for ${money(onchain.flows.depositOrigins[0].usdc)} of funding. This establishes address control, not a natural-person identity. High-volume routers remain labeled as shared infrastructure.

## Read In Order

1. [Breakthrough audit](./breakthrough_report.md): the new signal, falsification tests, failed hypotheses and promotion criteria.
2. [Replication report](./replication_report.md): exact execution assumptions, sensitivity and paper-monitor behavior.
3. [Deep trader report](./trader_report.md): fill reconstruction, timing, case studies and statistical attribution.
4. [Onchain report](./onchain_report.md): controller proof, funding graph and cash reconciliation.

## Bottom Line

This is a credible paper-trading candidate, not a cracked money machine. Direction beats randomized and opposite sides, urgency separates realized wins from public implied probabilities, and the walk-forward filter improves its baseline. Yet the tightest composition control is not significant, both ROI confidence intervals still cross zero, performance is concentrated, and public prints do not prove executable depth. The repository therefore freezes the model and emits paper-only FOK intents.
`;
}

async function writeReports(outputDirectory, inputs) {
    const { analysis, stats, onchain, paper, audit, edge, peers } = inputs;
    const reports = {
        'report.md': executiveReport(analysis, stats, onchain, edge, peers),
        'breakthrough_report.md': breakthroughReport(analysis, edge, peers),
        'onchain_report.md': onchainReport(analysis, onchain),
        'trader_report.md': traderReport(analysis, stats, edge, peers),
        'replication_report.md': replicationReport(analysis, paper, audit, edge)
    };
    await fs.mkdir(outputDirectory, { recursive: true });
    await Promise.all(Object.entries(reports).map(([name, content]) =>
        fs.writeFile(path.join(outputDirectory, name), `${content.trim()}\n`, 'utf8')));
    return Object.keys(reports);
}

module.exports = {
    breakthroughReport,
    executiveReport,
    money,
    onchainReport,
    percent,
    replicationReport,
    traderReport,
    writeReports
};
