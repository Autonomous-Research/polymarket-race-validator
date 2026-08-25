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

function traderReport(analysis, stats) {
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

    return `# Deep Trader Report: @djdjdjekekek

Generated ${analysis.generatedAt}. Coverage: ${isoShort(analysis.coverage.firstTrade)} through ${isoShort(analysis.coverage.lastTrade)}.

## Executive Finding

The edge is **selective directional information expressed through aggressive taker size**, surrounded by an automated maker/inventory layer. Counting fills hid this: makers are ${percent(execution.makerFillPct)} of fills but only ${percent(execution.makerNotionalPct)} of dollars. Taker fills are just ${percent(100 - execution.makerFillPct)} of count yet carry ${percent(100 - execution.makerNotionalPct)} of quote notional.

The strongest split is not sport versus esports. It is **aggressive versus passive capital**:

| Market subset | Markets | Cost | PnL | ROI | Event-cluster 95% ROI interval |
| --- | ---: | ---: | ---: | ---: | ---: |
| Taker share >= 50% | ${number(highTaker.markets)} | ${money(highTaker.costBasisUsdc)} | ${signedMoney(highTaker.realizedPnlUsdc)} | ${signedPercent(highTaker.roiPct, 2)} | ${signedPercent(highTaker.ci95LowPct, 1)} to ${signedPercent(highTaker.ci95HighPct, 1)} |
| Taker share < 50% | ${number(lowTaker.markets)} | ${money(lowTaker.costBasisUsdc)} | ${signedMoney(lowTaker.realizedPnlUsdc)} | ${signedPercent(lowTaker.roiPct, 2)} | ${signedPercent(lowTaker.ci95LowPct, 1)} to ${signedPercent(lowTaker.ci95HighPct, 1)} |

In a robust logistic model controlling for average entry price, log position size, timing, discipline, market type and concentration, a 10-point increase in taker share multiplies the odds of the dominant outcome winning by about ${perTenPointOdds.toFixed(2)} (full-range coefficient \`p=${logitTaker.pValue.toExponential(2)}\`). This is descriptive, not causal, but it survives controls that the original report omitted.

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
3. Blind copy trading. The broad delayed baseline loses money.
4. Stable, diversified alpha. Five winners are required to keep aggregate PnL positive.
5. Map/game duplication. It is the largest identifiable strategy leak.

The closest economic analogy is informed liquidity demand inside a broader liquidity-provision operation. Polymarket pays for resting liquidity, but the empirical prediction-market literature warns that limit orders filled during informative periods can be adversely selected. That framework fits the observed split between many weak maker fills and a small aggressive core; it does not prove the trader possesses private information.

## Statistical Limits

The event-cluster bootstrap gives overall ROI a ${signedPercent(bootstrap(stats, 'all').ci95LowPct, 1)} to ${signedPercent(bootstrap(stats, 'all').ci95HighPct, 1)} interval because profits are concentrated. The chronological descriptive classifier reaches ${Number(stats.chronologicalValidation.model.rocAuc).toFixed(3)} test ROC-AUC, versus ${Number(stats.chronologicalValidation.targetAverageEntryPriceBaseline.rocAuc).toFixed(3)} for average entry price alone, but it uses completed-position features and is not a deployable forecast.

Selection bias remains: this wallet was investigated because it was exceptional. Results cover only ${analysis.coverage.closedPositions} closed positions over roughly two months, event outcomes are dependent, and no public data identifies the trader's information source.

## Sources

- [Polymarket market-data overview](https://docs.polymarket.com/market-data/overview)
- [Polymarket maker rebates and fee curve](https://docs.polymarket.com/programs/maker-rebates)
- [Polymarket liquidity rewards](https://docs.polymarket.com/programs/liquidity-rewards)
- [Tetlock, Liquidity and Prediction Market Efficiency](https://business.columbia.edu/faculty/research/liquidity-and-prediction-market-efficiency)
- [BLAST official TI 2026 series results](https://blast.tv/dota/tournaments/the-international-2026/series)
- Structured evidence: [deep_analysis.json](./deep_analysis.json), [statistical_analysis.json](./statistical_analysis.json), [market_features.csv](./market_features.csv)
`;
}

function replicationReport(analysis, stats, paper, audit) {
    const proposed = analysis.backtest.proposed;
    const strategyStats = stats.proposedStrategyBootstrap;
    const lags = analysis.backtest.lagSensitivity.filter((row) => row.executionMode === 'taker-chase');
    const passive = analysis.backtest.lagSensitivity.filter((row) => row.executionMode === 'post-only-price-revisit');
    const lagRows = lags.map((row) => {
        const optimistic = passive.find((candidate) => candidate.lagSeconds === row.lagSeconds);
        return `| ${row.lagSeconds}s | ${number(row.train.bets)} / ${signedPercent(row.train.roiPct, 2)} | ${number(row.test.bets)} / ${signedPercent(row.test.roiPct, 2)} | ${number(optimistic?.test?.bets)} / ${signedPercent(optimistic?.test?.roiPct, 2)} |`;
    }).join('\n');

    return `# Replication Prototype: Evidence, Rules And Limits

Generated ${paper.generatedAt}. The implementation is paper-only and cannot sign or submit an order.

## Translation From Finding To Rule

| Finding | Observable rule | Guard |
| --- | --- | --- |
| Taker dollars, not maker fill count, carry the edge | Watch exact \`takerOnly=true\` BUY flow | Ignore maker fills as a directional trigger |
| Conviction matters | Require at least ${money(paper.config.strategy.thresholdUsdc)} gross aggressive buys and ${percent(paper.config.strategy.concentration * 100)} net directional concentration | No signal from small exploratory activity |
| Profits cluster in selected domains | Allow ${paper.config.strategy.allowedDisciplines.join(', ')} | Exclude MLB, basketball, crypto and unclassified sports |
| Maps/games leak badly | Exclude \`${paper.config.strategy.excludedMarketTypes.join('`, `')}\` | One condition per canonical event |
| Chasing consumes the edge | Anchor a post-only paper bid at or below the target trigger | Skip if best ask moved over ${paper.config.maxAdverseMove.toFixed(2)} against the signal |
| Signals decay | Wait ${paper.config.targetCopyLagSeconds}s, then expire at ${paper.config.signalMaxAgeSeconds}s | Cancel unfilled paper orders after ${paper.config.cancelAfterSeconds}s |

## Fixed Historical Test

The rule was fixed from attribution before reporting the test period: target taker buys >= ${money(proposed.taker.strategy.thresholdUsdc)}, concentration >= ${percent(proposed.taker.strategy.concentration * 100)}, price ${proposed.taker.strategy.minPrice.toFixed(2)}-${proposed.taker.strategy.maxPrice.toFixed(2)}, allowed disciplines only, and no game/map markets. Markets were split chronologically 70/30.

| Execution | Train | Test | All |
| --- | ---: | ---: | ---: |
| Taker proxy: next target buy, +3 cents, observed fee | ${number(proposed.taker.train.bets)} bets / ${signedPercent(proposed.taker.train.roiPct, 2)} | ${number(proposed.taker.test.bets)} bets / ${signedPercent(proposed.taker.test.roiPct, 2)} | ${number(proposed.taker.all.bets)} bets / ${signedPercent(proposed.taker.all.roiPct, 2)} |
| Passive price-revisit upper bound | ${number(proposed.passivePriceRevisit.train.bets)} bets / ${signedPercent(proposed.passivePriceRevisit.train.roiPct, 2)} | ${number(proposed.passivePriceRevisit.test.bets)} bets / ${signedPercent(proposed.passivePriceRevisit.test.roiPct, 2)} | ${number(proposed.passivePriceRevisit.all.bets)} bets / ${signedPercent(proposed.passivePriceRevisit.all.roiPct, 2)} |

The untouched test period is positive under the taker proxy, but the bootstrap interval is wide: ${signedPercent(strategyStats.test.ci95LowPct, 1)} to ${signedPercent(strategyStats.test.ci95HighPct, 1)}. With only ${number(strategyStats.test.bets)} bets, this is a forward-test candidate, not a demonstrated production edge.

The passive result is an upper bound. A later target buy at or below the trigger proves a price revisit, not our queue position or fill. The code therefore emits a post-only **paper intent** and records the live book; it does not credit a fill merely because a target print occurred.

## Lag Sensitivity

| Delay | Taker train bets / ROI | Taker test bets / ROI | Passive test price-revisit bets / ROI |
| --- | ---: | ---: | ---: |
${lagRows}

Positive results from 15 to 120 seconds are more useful than a single optimized delay. The 300-second result has fewer bets and should not be treated as superior.

## Prototype Behavior

The monitor performs this state transition:

1. Fetch the target's public activity and exact taker transactions.
2. Join current CLOB metadata and classify discipline, market type and canonical event.
3. Accumulate net aggressive flow by outcome without using future fills.
4. Reject categories, maps/games, stale signals, price extremes and duplicate event exposure.
5. Fetch the current order book for surviving candidates.
6. Emit a post-only paper BUY below the ask, capped by trigger price and bankroll rules.
7. Record every rejection and expire the paper order after five minutes.

Current saved-data run: ${number(paper.intents.length)} live paper intents, ${number(paper.candidatesBeforeBook)} candidates before book checks, proposed exposure ${money(paper.risk.proposedNotionalUsdc)}. A zero is expected when the snapshot contains no fresh qualifying signal.

## Risk Envelope

| Control | Default |
| --- | ---: |
| Mode | \`${paper.config.mode}\` |
| Assumed paper bankroll | ${money(paper.config.bankrollUsdc)} |
| Per-order cap | min(${money(paper.config.maxOrderUsdc)}, ${percent(paper.config.maxOrderBankrollPct)} of bankroll) |
| Per-event cap | ${percent(paper.config.maxEventBankrollPct)} of bankroll |
| Portfolio cap | ${percent(paper.config.maxPortfolioBankrollPct)} of bankroll |
| Adverse price move | ${paper.config.maxAdverseMove.toFixed(2)} |
| Order type | Post-only limit, never market |

No strategy inferred from two months and one selected wallet should be connected to live capital. A minimum useful next step is a locked-parameter forward paper test with at least 200 eligible signals, actual order-book snapshots, queue-aware fill accounting, and event-cluster confidence intervals.

## Commands And Artifacts

\`npm run research:replicate\` rebuilds [replication_intents.json](./replication_intents.json), [replicator_config.json](./replicator_config.json) and [replication_backtest.json](./replication_backtest.json) from saved data.

\`npm run research:monitor\` refreshes public target data, evaluates current books once, and still emits paper intents only.

Implementation: [replicator.js](../../src/research/replicator.js). Historical audit contains ${number(audit.all.bets)} simulated signals.

## Non-Negotiable Caveats

- Target prints are not a complete historical order book.
- The wallet was selected after exceptional performance; selection bias is material.
- Signal outcome and profitability do not identify the trader's information source.
- Geographic restrictions, platform terms, legal obligations and market integrity rules still apply.
- This is research software, not financial advice.
`;
}

function executiveReport(analysis, stats, onchain) {
    const execution = analysis.execution;
    const high = bootstrap(stats, 'takerShareAtLeast50Pct');
    const low = bootstrap(stats, 'takerShareBelow50Pct');
    const maps = rowByKey(analysis.performance.byMarketType, 'single-game/map');
    const proposed = analysis.backtest.proposed.taker;
    return `# @djdjdjekekek: Investigation And Replication Research

## Discovery

This is a **two-layer trading operation**: ${percent(execution.makerFillPct)} of fills are small maker executions, but ${percent(100 - execution.makerNotionalPct)} of dollars are aggressive taker flow. The passive layer loses in aggregate; the selective aggressive layer carries the edge. The trader's largest repeatable mistake is duplicating a match thesis into individual game/map markets.

The onchain work independently resolves the type-3 Deposit Wallet to controller EOA \`${onchain.wallet.owner}\`, links that owner directly to the EIP-7702 account responsible for ${money(onchain.flows.depositOrigins[0].usdc)} of funding, and reconciles the trading result to ${money(analysis.cash.netWithdrawnUsdc)} of net extracted cash.

## Evidence At A Glance

| Measure | Result |
| --- | ---: |
| Coverage | ${number(analysis.coverage.trades)} fills, ${number(analysis.coverage.markets)} markets, ${number(analysis.coverage.closedPositions)} closed positions |
| Closed realized PnL | ${signedMoney(analysis.performance.realizedPnlUsdc)} on ${money(analysis.performance.closedCostBasisUsdc)} cost |
| Confirmed economic result | ${money(analysis.cash.confirmedEconomicProfitUsdc)} from net withdrawals, onchain stablecoins and open positions |
| Maker execution | ${percent(execution.makerFillPct)} of fills, ${percent(execution.makerNotionalPct)} of notional |
| Taker execution | ${percent(100 - execution.makerFillPct)} of fills, ${percent(100 - execution.makerNotionalPct)} of notional |
| Markets >= 50% taker | ${signedPercent(high.roiPct, 2)} ROI; clustered 95% interval ${signedPercent(high.ci95LowPct, 1)} to ${signedPercent(high.ci95HighPct, 1)} |
| Markets < 50% taker | ${signedPercent(low.roiPct, 2)} ROI; clustered 95% interval ${signedPercent(low.ci95LowPct, 1)} to ${signedPercent(low.ci95HighPct, 1)} |
| Single game/map | ${signedMoney(maps.realizedPnlUsdc)}, ${signedPercent(maps.roiPct, 2)} ROI |
| Fixed 60s copy proxy, untouched test | ${number(proposed.test.bets)} bets, ${signedPercent(proposed.test.roiPct, 2)} ROI |

## What The Edge Is

1. Pre-event selection in tennis, soccer and high-level esports series.
2. Revealed conviction through large fee-paying taker buys, not raw fill count.
3. Fast, automated capital deployment: median deposit-to-next-buy lag is ${number(analysis.cash.depositToNextBuyLag.medianSeconds)} seconds.
4. In-play inventory management around positions often established before the event.

## What It Is Not

1. Not maker-rebate farming: ${money(execution.observedTakerFeesUsdc)} of observed taker fees dwarf ${money(execution.publicMakerRebatesUsdc)} of public maker rebates.
2. Not generic live betting: positions first entered in-play lose ${money(Math.abs(rowByKey(analysis.timing.performance.byFirstEntry, 'started in-play').realizedPnlUsdc))} in aggregate.
3. Not safely copyable at any price: broad delayed copying loses, and the proposed test interval still crosses zero.
4. Not diversified: removing the top five winners turns PnL into ${signedMoney(analysis.concentration.pnlWithoutTop5Usdc)}.

## Deliverables

- [Onchain investigation](./onchain_report.md): controller resolution, contract anatomy, funding graph, cash-out routes and accounting proof.
- [Deep trader report](./trader_report.md): execution-role reconstruction, actual bets, correlated events, statistical controls and edge thesis.
- [Replication report](./replication_report.md): fixed signal rules, chronological backtest, risk controls and paper monitor.
- [Structured analysis](./deep_analysis.json), [statistics](./statistical_analysis.json), [onchain evidence](./onchain_evidence.json), and [paper intents](./replication_intents.json).

## Bottom Line

The discovery is not a magic copy-trading formula. It is a measurable separation between an automated maker shell and a high-conviction taker core, plus a measurable failure mode in correlated map exposure. The prototype follows only the observable aggressive signal, removes the known leaks, refuses stale or chased prices, and remains paper-only because the out-of-sample evidence is positive but not yet statistically decisive.
`;
}

async function writeReports(outputDirectory, inputs) {
    const { analysis, stats, onchain, paper, audit } = inputs;
    const reports = {
        'report.md': executiveReport(analysis, stats, onchain),
        'onchain_report.md': onchainReport(analysis, onchain),
        'trader_report.md': traderReport(analysis, stats),
        'replication_report.md': replicationReport(analysis, stats, paper, audit)
    };
    await fs.mkdir(outputDirectory, { recursive: true });
    await Promise.all(Object.entries(reports).map(([name, content]) =>
        fs.writeFile(path.join(outputDirectory, name), `${content.trim()}\n`, 'utf8')));
    return Object.keys(reports);
}

module.exports = {
    executiveReport,
    money,
    onchainReport,
    percent,
    replicationReport,
    traderReport,
    writeReports
};
