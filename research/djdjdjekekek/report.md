# @djdjdjekekek: Investigation And Replication Research

## Discovery

This is a **two-layer trading operation**: 92.8% of fills are small maker executions, but 72.1% of dollars are aggressive taker flow. The passive layer loses in aggregate; the selective aggressive layer carries the edge. The trader's largest repeatable mistake is duplicating a match thesis into individual game/map markets.

The onchain work independently resolves the type-3 Deposit Wallet to controller EOA `0xC332040b7ed35DeB84488bEEa049d8d34934141b`, links that owner directly to the EIP-7702 account responsible for $29.56M of funding, and reconciles the trading result to $5.91M of net extracted cash.

## Evidence At A Glance

| Measure | Result |
| --- | ---: |
| Coverage | 28,235 fills, 386 markets, 396 closed positions |
| Closed realized PnL | +$5.64M on $56.28M cost |
| Confirmed economic result | $5.91M from net withdrawals, onchain stablecoins and open positions |
| Maker execution | 92.8% of fills, 27.9% of notional |
| Taker execution | 7.2% of fills, 72.1% of notional |
| Markets >= 50% taker | +23.76% ROI; clustered 95% interval +1.3% to +44.7% |
| Markets < 50% taker | -31.21% ROI; clustered 95% interval -61.7% to +0.1% |
| Single game/map | -$3.11M, -52.98% ROI |
| Fixed 60s copy proxy, untouched test | 30 bets, +3.98% ROI |

## What The Edge Is

1. Pre-event selection in tennis, soccer and high-level esports series.
2. Revealed conviction through large fee-paying taker buys, not raw fill count.
3. Fast, automated capital deployment: median deposit-to-next-buy lag is 48 seconds.
4. In-play inventory management around positions often established before the event.

## What It Is Not

1. Not maker-rebate farming: $811.1K of observed taker fees dwarf $65.9K of public maker rebates.
2. Not generic live betting: positions first entered in-play lose $572.7K in aggregate.
3. Not safely copyable at any price: broad delayed copying loses, and the proposed test interval still crosses zero.
4. Not diversified: removing the top five winners turns PnL into -$2.49M.

## Deliverables

- [Onchain investigation](./onchain_report.md): controller resolution, contract anatomy, funding graph, cash-out routes and accounting proof.
- [Deep trader report](./trader_report.md): execution-role reconstruction, actual bets, correlated events, statistical controls and edge thesis.
- [Replication report](./replication_report.md): fixed signal rules, chronological backtest, risk controls and paper monitor.
- [Structured analysis](./deep_analysis.json), [statistics](./statistical_analysis.json), [onchain evidence](./onchain_evidence.json), and [paper intents](./replication_intents.json).

## Bottom Line

The discovery is not a magic copy-trading formula. It is a measurable separation between an automated maker shell and a high-conviction taker core, plus a measurable failure mode in correlated map exposure. The prototype follows only the observable aggressive signal, removes the known leaks, refuses stale or chased prices, and remains paper-only because the out-of-sample evidence is positive but not yet statistically decisive.
