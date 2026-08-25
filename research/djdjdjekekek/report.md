# @djdjdjekekek: Investigation And Replication Research

## Result

The account is a two-layer automated operation: 92.8% of fills are maker executions, while 72.1% of quote notional is aggressive taker flow. The deeper discovery is narrower: **the directional signal concentrates in mined taker transactions that consume offers from at least 18 distinct signed maker accounts.**

| Evidence | Result |
| --- | ---: |
| Confirmed economic result | $5.91M extracted above deposits |
| High-taker market subset | +23.76% ROI; clustered interval +1.3% to +44.7% |
| True multi-map series | 114 markets, +$7.57M, +31.20% ROI |
| Single game/map including BO1 | 81 markets, -$4.89M, -57.55% ROI |
| Forced external-tape backtest | 80 bets, +8.50% all-period ROI |
| Blind all-signal external-tape copy | 139 bets, -$855.28, -6.15% all / -6.68% later |
| Atomic breadth at least 18 | 30 bets, 23 wins, +41.94% ROI |
| Breadth after development selection | 21 bets, 15 wins, +27.32% ROI |
| Compact-fresh breadth held out | 7 bets, 6 wins, +63.17% ROI; cluster interval -8.7% to +110.4% |
| Current +1c FOK coverage | 94.7% at $100; 46.1% at $10,000 |
| Broad pregame closing-line value | Median -0.67c; 4/12 positive |
| Breadth composition control | +28.0 pp across 63 comparable bets; one-sided `p=0.0064` |
| Original-classifier BO1 counterfactual | 84 bets, +5.27% all / +14.09% later |
| Chronological final period | 24 bets, +26.36% ROI; day-cluster interval -15.9% to +55.8% |
| Expanding-window model | 15 selected bets, +27.54% ROI; ROC-AUC 0.635 |

![Blind-copy and filtered-rule equity](./figures/strategy_equity.png)

## Corrections And Rejections

The original classifier treated BO1 as a series. Correcting it moves 9 markets that lost $1.78M into the single-map failure bucket. This correction was found while inspecting final losses and is explicitly not claimed as an untouched discovery.

The external backtest also fixes a more serious execution leak: it no longer uses the target's next future fill as the follower's price. It uses 143,507 unrelated market-wide prints, forces no-print signals into the test, and crosses 15 delays from same-second to five minutes with 17 adverse-price assumptions from zero to 30 cents. The clock starts when settlement is mined because maker breadth is not available at the earlier off-chain MATCHED state. One-second blind copying breaks even after only 1.53 cents.

No stable leader wallet was identified. Early-selected peer confirmation returned +7.62% on later bets, below the +29.67% return without confirmation. Eventual target size was also unpredictable. Neither peer identity nor inferred final size belongs in the model.

## Onchain Attribution

The type-3 Deposit Wallet resolves to controller EOA `0xC332040b7ed35DeB84488bEEa049d8d34934141b`. That owner directly transacted with the EIP-7702 account responsible for $29.56M of funding. This establishes address control, not a natural-person identity. High-volume routers remain labeled as shared infrastructure.

## Read In Order

1. [Illustrated plain-English essay](./plain_english_essay.pdf): literal alpha and mechanism definitions, 6,244 execution-and-capacity scenarios, 31 charts, closing-line falsification, risk diagnostics, and caveats without requiring code.
2. [Breakthrough audit](./breakthrough_report.md): atomic-breadth signal, falsification tests, and promotion criteria.
3. [Replication report](./replication_report.md): the earlier monitor and its exact execution assumptions.
4. [Deep trader report](./trader_report.md): fill reconstruction, timing, case studies and statistical attribution.
5. [Onchain report](./onchain_report.md): controller proof, funding graph and cash reconciliation.

## Bottom Line

The strongest observable edge is informed-looking liquidity demand: one target transaction taking dense, fresh liquidity from many maker accounts without crossing many price levels. The frozen 18-maker rule survives chronology and controls; the sharper compact-fresh lead is only 6/7 held out, and broad pregame CLV is negative. Size also sharply reduces FOK coverage. The source of information remains unknown, so the repository runs a capacity-aware paper monitor and intentionally provides no live-money signing path.
