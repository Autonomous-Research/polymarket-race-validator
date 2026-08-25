# Deep Trader Report: @djdjdjekekek

Generated 2026-08-25T13:48:29.233Z. Coverage: 2026-06-19T18:37:08Z through 2026-08-25T05:52:45Z.

## Executive Finding

The edge is **selective directional information expressed through aggressive taker size**, surrounded by an automated maker/inventory layer. Counting fills hid this: makers are 92.8% of fills but only 27.9% of dollars. Taker fills are just 7.2% of count yet carry 72.1% of quote notional.

The strongest split is not sport versus esports. It is **aggressive versus passive capital**:

| Market subset | Markets | Cost | PnL | ROI | Event-cluster 95% ROI interval |
| --- | ---: | ---: | ---: | ---: | ---: |
| Taker share >= 50% | 241 | $42.20M | +$10.03M | +23.76% | +1.3% to +44.7% |
| Taker share < 50% | 144 | $14.01M | -$4.37M | -31.21% | -61.7% to +0.1% |

In a robust logistic model controlling for average entry price, log position size, timing, discipline, market type and concentration, a 10-point increase in taker share multiplies the odds of the dominant outcome winning by about 1.26 (full-range coefficient `p=2.26e-8`). This is descriptive, not causal, but it survives controls that the original report omitted.

## Dataset And Reconstruction

| Measure | Value |
| --- | ---: |
| Public fill rows | 28,235 |
| Activity rows | 29,055 |
| Markets | 386 |
| Closed positions | 396 |
| Markets with exact CLOB metadata | 386 |
| Markets with game start time | 367 |
| Exact target-taker rows collected | 2,045 |
| Public maker-rebate rows | 329 |

The public trade feed occasionally reports one maker sub-fill while the activity row reports the target's full fill in that settlement. The analysis joins the one-to-one transaction hashes and uses activity size/cash as authoritative. This adjusted 37 fills and added $622.9K of maker quote notional; join coverage is 100.0%.

## Maker Versus Taker

| Role | Fills | Share of fills | Quote notional | Share of notional | Median fill | Mean fill |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Maker | 26,190 | 92.8% | $21.04M | 27.9% | $19.50 | $803.22 |
| Taker | 2,045 | 7.2% | $54.32M | 72.1% | $2.6K | $26.6K |

Classification comes from the Data API's exact `takerOnly=true` transaction hashes, independently cross-checked against cash deltas. For example, a 102,269.74-share BUY at 0.32 had $32.7K quote value and $33.4K cash cost. The $667.62 difference exactly equals `C * 0.03 * p * (1-p)`.

Observed taker fees total $811.1K. Public maker rebates total only $65.9K, leaving $745.2K of net fee drag before taker rebates. This trader paid for immediacy; maker incentives do not explain the PnL.

This execution pattern is consistent with two systems:

1. Many tiny resting orders capture incidental liquidity, manage inventory, and earn modest rebates.
2. A much smaller number of selected taker blocks express the actual directional thesis.

## Where The Money Was Made

### Discipline

| Discipline | Markets | Cost | PnL | ROI | Taker share |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dota 2 | 107 | $20.93M | +$1.59M | +7.61% | 76.9% |
| Tennis | 71 | $11.17M | +$2.20M | +19.67% | 57.7% |
| Counter-Strike | 76 | $9.89M | +$935.3K | +9.46% | 79.9% |
| MLB | 54 | $6.32M | +$160.2K | +2.53% | 63.7% |
| Soccer | 27 | $3.29M | +$1.22M | +37.01% | 88.7% |
| League of Legends | 14 | $2.05M | +$255.8K | +12.47% | 89.0% |
| Basketball | 10 | $1.81M | -$117.5K | -6.48% | 42.3% |
| Other sports | 3 | $387.5K | -$387.5K | -100.01% | 43.8% |
| Crypto 5m | 14 | $273.6K | -$237.5K | -86.81% | 4.0% |
| Valorant | 7 | $139.0K | +$24.9K | +17.92% | 65.5% |
| Cricket | 2 | $5.3K | +$3.0K | +56.21% | 63.3% |
| Other esports | 1 | $1.3K | -$1.3K | -100.01% | 40.0% |

Tennis, soccer, Dota 2 and Counter-Strike account for most positive dollars. MLB is effectively flat, basketball is negative, and crypto 5-minute markets lose $237.5K at -86.8% ROI.

### Market Structure

| Market type | Markets | Cost | PnL | ROI | Taker share |
| --- | ---: | ---: | ---: | ---: | ---: |
| series winner | 123 | $26.88M | +$5.79M | +21.55% | 80.0% |
| match winner | 151 | $20.33M | +$1.90M | +9.36% | 58.1% |
| single-game/map | 72 | $5.88M | -$3.11M | -52.98% | 75.0% |
| outright | 15 | $1.60M | +$1.07M | +67.15% | 95.3% |
| team to advance | 11 | $1.32M | +$223.9K | +17.01% | 87.5% |
| short-horizon binary | 14 | $273.6K | -$237.5K | -86.81% | 4.0% |

Series winners earn +$5.79M. Single-game/map bets lose $3.11M; their event-cluster bootstrap has a -83.7% to +1.9% interval. The replicator therefore excludes them.

### Timing

72.8% of timed notional trades after the scheduled start, so the account is operationally an in-play trader. Profit attribution says something more specific:

| Construction | Markets | Cost | PnL | ROI |
| --- | ---: | ---: | ---: | ---: |
| First target fill pregame | 100 | $23.30M | +$6.09M | +26.15% |
| First target fill in-play | 267 | $31.88M | -$572.7K | -1.80% |
| Majority of notional pregame | 63 | $16.92M | +$5.26M | +31.08% |
| Majority of notional in-play | 304 | $38.26M | +$261.8K | +0.68% |

The edge is not well described as generic live latency arbitrage. Profits cluster in positions established or weighted before play, while live activity often manages or compounds those positions.

## Actual Bets

### 1. TEAM VISION vs Team Spirit, TI 2026 final

The target backed Team Spirit, the eventual 3-2 winner, and earned +$2.88M on $2.34M cost.

- It crossed $25.0K of aggressive buys at 0.42 roughly 98 minutes before start.
- It crossed $1.00M by 2026-08-23T04:52:57Z, still about 82 minutes pregame.
- Pregame taker buys totaled $1.98M. Only one large in-play taker sell remained.

The [match record](https://liquipedia.net/dota2/Match%3AID_TI2026Main_R05-M001) confirms a five-game 3-2 final. This is a pregame directional position, not a reaction to the final map.

### 2. FURIA vs FUT Esports, EWC semifinal

The target bought $1.01M of FUT at about 0.448 in one transaction 2.5 minutes before scheduled start. FUT won 2-1, and the position earned +$1.54M. The [match recap](https://www.talkesport.com/news/cs2/fut-vs-furia-cs2-ewc-2026-semifinal-recap/) independently confirms the upset and map score.

This is the cleanest example of the account's high-conviction mode: a seven-figure aggressive block near 45 cents, immediately before the event, followed by an almost complete winner redemption/sale.

### 3. Team Yandex vs Team Spirit, TI lower-bracket final

The same mechanism also produces catastrophic losses. In Game 2, the target began buying Yandex about 58 minutes after the series start, crossed $231.3K near 0.417, and ramped past $500.0K. Team Spirit completed a 2-0 sweep; the game leg lost $1.14M. The [match record](https://liquipedia.net/dota2/Match%3AID_TI2026Main_R04-M002) confirms both map results.

Across the related series, Game 1 and Game 2 conditions, the trader repeatedly selected Yandex. That correlated event group lost roughly $1.55M. This is failed live conviction, not hedging.

## Correlated Event Leakage

| Grouping | Groups / legs | Cost | PnL | ROI |
| --- | ---: | ---: | ---: | ---: |
| All correlated match groups | 33 | $9.10M | -$1.72M | -18.86% |
| Same direction across conditions | 27 | $8.65M | -$1.63M | -18.81% |
| Mixed directions | 6 | $456.9K | -$89.9K | -19.68% |
| Game/map legs inside groups | 46 | $4.56M | -$2.76M | -60.61% |

The account often buys the same team in the series and individual maps. That is concentrated duplicate exposure, and it destroyed value even when the series leg won. Team Liquid vs Falcons is the canonical example: the series won about $279.0K, Game 1 lost about $563.6K, and Game 2 won about $52.9K, for a net loss near $231.5K.

## Capital And PnL Concentration

The largest size quartile earns +$8.06M at +17.34% ROI. The other three quartiles lose money in aggregate. Position size is therefore a revealed-confidence signal, not just risk scaling.

The strategy is also fragile:

- Top winner: `Dota 2: TEAM VISION vs Team Spirit (BO5) - The International Playoffs`, +$2.88M.
- Largest loss: `Dota 2: Team Yandex vs Team Spirit - Game 2 Winner`, -$1.14M.
- Top five gross winners contribute 144.2% of net PnL.
- Removing the top five turns total PnL into -$2.49M.
- Maximum closed-market drawdown is $3.52M.

Even the high-taker subset falls from +23.8% to +5.6% after its top five winners, and turns negative after its top ten. The edge is real in the sample but highly lumpy.

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

The event-cluster bootstrap gives overall ROI a -9.2% to +28.2% interval because profits are concentrated. The chronological descriptive classifier reaches 0.779 test ROC-AUC, versus 0.730 for average entry price alone, but it uses completed-position features and is not a deployable forecast.

Selection bias remains: this wallet was investigated because it was exceptional. Results cover only 396 closed positions over roughly two months, event outcomes are dependent, and no public data identifies the trader's information source.

## Sources

- [Polymarket market-data overview](https://docs.polymarket.com/market-data/overview)
- [Polymarket maker rebates and fee curve](https://docs.polymarket.com/programs/maker-rebates)
- [Polymarket liquidity rewards](https://docs.polymarket.com/programs/liquidity-rewards)
- [Tetlock, Liquidity and Prediction Market Efficiency](https://business.columbia.edu/faculty/research/liquidity-and-prediction-market-efficiency)
- [BLAST official TI 2026 series results](https://blast.tv/dota/tournaments/the-international-2026/series)
- Structured evidence: [deep_analysis.json](./deep_analysis.json), [statistical_analysis.json](./statistical_analysis.json), [market_features.csv](./market_features.csv)
