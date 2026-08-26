# Breakthrough Audit: Atomic Breadth

Generated 2026-08-25T20:19:42.882017+00:00. For the illustrated, nontechnical version, read [the plain-English essay](./plain_english_essay.pdf).

## Discovery

The strongest observable edge is not the wallet address, raw bet size, or copy speed. It is **atomic maker breadth**: one mined V2 `matchOrders` transaction consuming offers from at least 18 distinct signed maker accounts.

Blindly copying every canonical $25,000 signal lost $855.28 across 139 equal $100 bets (-6.15% ROI). The later period also lost -6.68%.

The breadth rule selected 30 bets, won 23, and returned +41.94% under the original 60-second plus five-cent stress. Triggers below 18 makers returned -11.56%.

| Rule | Bets | Wins | Price-implied wins | Calibration gap | ROI |
| --- | ---: | ---: | ---: | ---: | ---: |
| Below 18 makers | 50 | 29 | 29.30 | -0.6 pp | -11.56% |
| At least 18 makers | 30 | 23 | 16.04 | +23.2 pp | +41.94% |
| Held out after selection | 21 | 15 | 11.55 | +16.4 pp | +27.32% |

![Atomic-breadth calibration](./figures/atomic_breadth_calibration.svg)

## What The Chain Proves

- All 149 trigger transactions were decoded from Polygon.
- The target was the BUY taker in all 149.
- The median trigger matched 19 maker orders from 14 distinct maker accounts.
- 66 triggers crossed more than one price level.
- The maximum on-chain notional reconciliation error was below one millionth of one percent.

Distinct signed accounts are not proven distinct humans. The fact is contract-level breadth, not human headcount.

![Anatomy of one atomic sweep](./figures/atomic_sweep_anatomy.svg)

## Realistic Copy Speed

The execution audit crosses 15 delays from same-second through 300 seconds with 17 adverse-price assumptions from zero through 30 cents. Historical timestamps are only one second precise, so 0.1-second and 0.5-second bots cannot be distinguished. Same-second is an optimistic bound because ordering inside that second is unknown. The clock starts at the mined block: maker breadth cannot be decoded at Polymarket's earlier off-chain MATCHED state from this public history.

At one second plus one cent, blind copying returned +1.04%. At one second plus two cents, it returned -0.90%. Its solved one-second break-even allowance is only 1.53 cents. The breadth rule's held-out allowance is 19.12 cents.

There is no measured sub-minute latency cliff. Price impact is the cliff: a fast bot still loses after paying away roughly two cents on indiscriminate copies.

![Latency and adverse-price surface](./figures/copy_execution_surface.svg)

![Break-even execution frontier](./figures/copy_break_even_frontier.svg)

## Full Parameter Atlas

The exported audit contains 1,444 grid cells across four sensitivity families:

- 510 latency-by-price results across blind and alpha-filtered copying;
- 102 fee-by-price settings for each strategy view;
- 442 breadth-cutoff-by-price settings;
- 390 breadth-cutoff-by-latency settings.

At one second plus one cent, the held-out breadth sample returned +35.60%. The dense atlas is a fragility map, not 1,444 independent confirmations.

![All measured latency curves](./figures/copy_latency_curves.svg)

![All execution-cost curves](./figures/copy_cost_curves.svg)

![Fee and price-cost surface](./figures/fee_cost_surface.svg)

## Capacity And Size

The audit adds 4,800 size cells, bringing the execution-and-capacity total to 6,244. The current CLOB snapshot walks actual asks across 206 liquid sports token sides. Through +1c, complete FOK coverage was 94.7% at $100.00, 84.5% at $1.0K, 46.1% at $10.0K, and 26.2% at $25.0K.

That favorable current cross-section is not the follower's post-sweep book. Across 21 held-out breadth signals, the optimistic all-print turnover ceiling covered a $100.00 request within one second only 38.1% of the time. At 60 seconds it covered 85.7%; limiting participation to 25% reduced that to 71.4%. FOK rejects the whole order when capacity is short.

![Immediate FOK capacity surface](./figures/live_fok_capacity_surface.svg)

![Size, rejection, and conditional VWAP](./figures/live_depth_survival.svg)

![Historical post-sweep turnover surface](./figures/historical_capacity_surface.svg)

![Current book versus post-sweep capacity](./figures/capacity_reality_gap.svg)

## Alpha, Literally

The recoverable alpha is a conditional market-pricing residual:

```text
B(tx) = count(distinct makerOrders[].maker)
Signal(tx) = eligible first-event BUY taker transaction AND B(tx) >= 18
Probability alpha = realized outcome - public execution-proxy probability
```

Measured probability alpha was +23.21 pp across all 30 broad sweeps and +16.41 pp after development selection. Below 18 makers it was -0.59 pp. This identifies the public footprint of conviction, not the private information source.

## Closest Observable Mechanism

The second-stage exploratory fingerprint is **compact-fresh breadth**:

```text
distinct makers >= 18
distinct execution price levels <= 3
median maker-order age <= 300 seconds
```

Development selected the three-level and 300-second limits from the stated grid. It found 5 bets, 5 wins, and +115.94% ROI. Held out without changing the limits, it found 7 bets, 6 wins, and +63.17% ROI. Other broad sweeps returned +13.14%.

Two alternative stories fail descriptively. Broad winners consumed maker orders with median age 43.3 seconds, versus 378.4 seconds for losses, so stale orders are not the explanation. Broad signals involved 388 unique makers, and prior-seen maker shares were similar for winners and losses (46.7% versus 50.0%), so recurring identity is not a substitute for geometry.

The selection-repeating market null gives `p=0.0314`, but the seven-bet held-out day-cluster interval spans -8.7% to +110.4%. The null covers the stated grid, not every hypothesis considered. This is the sharpest lead, not a cracked private model.

![Compact-fresh mechanism](./figures/compact_fresh_mechanism.svg)

## Closing-Line Falsification

All 33 eligible pregame signals received a final non-target public print before recorded start. Broad pregame sweeps had median CLV -0.67c and mean CLV -1.06c; only 4/12 were positive. The one-sided sign test for positive CLV gives `p=0.927`; broad versus narrow CLV gives `p=0.340`.

The high settlement win rate therefore lacks independent pregame price confirmation. Closing prints are not executable quotes, but this negative validation blocks an honest claim that the information source has been solved or that live capital is justified.

![Closing-line validation](./figures/closing_line_validation.svg)

![Breadth cutoff by execution cost](./figures/breadth_threshold_cost_surface.svg)

![Breadth cutoff by latency](./figures/breadth_threshold_latency_surface.svg)

## Falsification And Controls

| Test | Result | What it addresses |
| --- | ---: | --- |
| Development / validation / final ROI | +76.1% / +5.1% / +44.0% | Chronological stability |
| Held-out day-cluster ROI interval | +0.7% to +58.3% | Busy-day dependence |
| Threshold-selection market null | `p=0.046` | Repeats development cutoff search before held-out scoring |
| Discipline / price / period permutation | +28.0 pp, `p=0.0064` | Market-composition differences |
| Day-cluster broad minus narrow | +23.8 pp, interval +6.2 pp to +42.8 pp | Correlated events by day |
| Breadth odds after rapid flow, notional, and period controls | OR 4.94, `p=0.043` | Alternative observable explanations |
| Trigger notional in the same model | OR 0.94, `p=0.858` | Raw dollar size |

![Chronological breadth test](./figures/breadth_chronology.svg)

## Mechanism

The best interpretation is **informed liquidity demand**. The trader appears unusually informative when one taker decision clears offers from many maker accounts. Rapid final-minute buying was the first clue, but it lost 25.9% in middle validation and remains only a confidence tag.

The source of information is unknown. Public evidence cannot distinguish a superior model, faster public feeds, private information, coordinated research, or disciplined judgment. Maker breadth is the footprint of conviction, not the hidden information itself.

## Frozen Algorithm

1. Keep the first canonical event signal in core tennis, soccer, and esports.
2. Exclude map, single-game, BO1, and short-horizon contracts.
3. Require concentration of at least 70% and trigger price from 0.30 through 0.85.
4. Decode the mined V2 `matchOrders` call and verify the target is BUY taker for the signaled token.
5. Require at least 18 distinct `makerOrders[].maker` addresses.
6. Shadow-tag at most three price levels and median maker age at most 300 seconds; do not promote the post-hoc tag into a live gate.
7. Snapshot the first book at least one second after the block timestamp; historical data cannot separate 0.1 from 0.5 seconds.
8. Set the ordinary risk cap, then reduce it to at most 10% of displayed ask notional through the limit; reject below $25.
9. Walk every eligible ask. Cap FOK price at min(best ask + 1c, trigger + 5c, 0.90) and reject the whole intent when depth is short.
10. Hold accepted paper fills to resolution. Do not submit live orders, martingale, or infer the whale's eventual size.

## Decision And Limits

Freeze `atomic-breadth-18` and collect at least 200 genuinely new eligible signals in paper mode. Record compact-fresh status, actual FOK depth, rejection, VWAP, closing line, and resolution. Do not deploy capital before the unseen sample has positive CLV and remains profitable after real fills and after removing its largest winners.

This is a two-month, retrospectively selected wallet and feature family. The threshold simulation corrects the declared maker-count search, not every research choice. The held-out half becomes negative after removing its five best winners. Public prints do not reconstruct historical order-book depth or publication latency. This is research, not financial advice.

## Evidence

- [Decoded trigger transactions](./trigger_transactions.json)
- [External tape, execution surface, and controls](./edge_analysis.json)
- [Signal-level feature table](./edge_features.csv)
- [Current order-book capacity snapshot](./liquidity_capacity.json)
- [Pregame closing-line marks](./closing_lines.json)
- [Illustrated plain-English essay](./plain_english_essay.pdf)
- [Official Polymarket CTF Exchange V2](https://github.com/Polymarket/ctf-exchange-v2)
- [Official Polymarket order lifecycle](https://docs.polymarket.com/concepts/order-lifecycle)
- [Official Polymarket order-book endpoint](https://docs.polymarket.com/api-reference/market-data/get-order-book)
- [Official Polymarket fees](https://docs.polymarket.com/trading/fees)
- [Cheng, Yang, and Zou, Arbitrage Analysis in Polymarket NBA Markets](https://arxiv.org/abs/2605.00864), independent context on executable opportunity being bounded by depth
- [Official public market WebSocket](https://docs.polymarket.com/api-reference/wss/market)
- [Dubach, The Anatomy of a Decentralized Prediction Market](https://arxiv.org/abs/2604.24366)
- [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)
