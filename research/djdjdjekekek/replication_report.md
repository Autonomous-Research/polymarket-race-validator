# Replication Prototype: Evidence, Rules And Limits

Generated 2026-08-25T13:48:39.000Z. The implementation is paper-only and cannot sign or submit an order.

## Translation From Finding To Rule

| Finding | Observable rule | Guard |
| --- | --- | --- |
| Taker dollars, not maker fill count, carry the edge | Watch exact `takerOnly=true` BUY flow | Ignore maker fills as a directional trigger |
| Conviction matters | Require at least $25.0K gross aggressive buys and 70.0% net directional concentration | No signal from small exploratory activity |
| Profits cluster in selected domains | Allow Tennis, Soccer, Dota 2, Counter-Strike, League of Legends, Valorant | Exclude MLB, basketball, crypto and unclassified sports |
| Maps/games leak badly | Exclude `single-game/map`, `short-horizon binary` | One condition per canonical event |
| Chasing consumes the edge | Anchor a post-only paper bid at or below the target trigger | Skip if best ask moved over 0.01 against the signal |
| Signals decay | Wait 60s, then expire at 600s | Cancel unfilled paper orders after 300s |

## Fixed Historical Test

The rule was fixed from attribution before reporting the test period: target taker buys >= $25.0K, concentration >= 70.0%, price 0.30-0.85, allowed disciplines only, and no game/map markets. Markets were split chronologically 70/30.

| Execution | Train | Test | All |
| --- | ---: | ---: | ---: |
| Taker proxy: next target buy, +3 cents, observed fee | 27 bets / +16.61% | 30 bets / +3.98% | 57 bets / +9.96% |
| Passive price-revisit upper bound | 20 bets / +19.28% | 18 bets / +15.09% | 38 bets / +17.29% |

The untouched test period is positive under the taker proxy, but the bootstrap interval is wide: -28.8% to +37.0%. With only 30 bets, this is a forward-test candidate, not a demonstrated production edge.

The passive result is an upper bound. A later target buy at or below the trigger proves a price revisit, not our queue position or fill. The code therefore emits a post-only **paper intent** and records the live book; it does not credit a fill merely because a target print occurred.

## Lag Sensitivity

| Delay | Taker train bets / ROI | Taker test bets / ROI | Passive test price-revisit bets / ROI |
| --- | ---: | ---: | ---: |
| 15s | 39 / +9.45% | 36 / +6.06% | 26 / +15.72% |
| 30s | 32 / +11.23% | 32 / +10.86% | 21 / +21.50% |
| 60s | 27 / +16.61% | 30 / +3.98% | 18 / +15.09% |
| 120s | 24 / +23.77% | 26 / +16.49% | 16 / +29.48% |
| 300s | 12 / -7.02% | 21 / +33.80% | 8 / +74.52% |

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

Current saved-data run: 0 live paper intents, 0 candidates before book checks, proposed exposure $0.00. A zero is expected when the snapshot contains no fresh qualifying signal.

## Risk Envelope

| Control | Default |
| --- | ---: |
| Mode | `PAPER_ONLY` |
| Assumed paper bankroll | $10.0K |
| Per-order cap | min($100.00, 0.5% of bankroll) |
| Per-event cap | 1.0% of bankroll |
| Portfolio cap | 5.0% of bankroll |
| Adverse price move | 0.01 |
| Order type | Post-only limit, never market |

No strategy inferred from two months and one selected wallet should be connected to live capital. A minimum useful next step is a locked-parameter forward paper test with at least 200 eligible signals, actual order-book snapshots, queue-aware fill accounting, and event-cluster confidence intervals.

## Commands And Artifacts

`npm run research:replicate` rebuilds [replication_intents.json](./replication_intents.json), [replicator_config.json](./replicator_config.json) and [replication_backtest.json](./replication_backtest.json) from saved data.

`npm run research:monitor` refreshes public target data, evaluates current books once, and still emits paper intents only.

Implementation: [replicator.js](../../src/research/replicator.js). Historical audit contains 57 simulated signals.

## Non-Negotiable Caveats

- Target prints are not a complete historical order book.
- The wallet was selected after exceptional performance; selection bias is material.
- Signal outcome and profitability do not identify the trader's information source.
- Geographic restrictions, platform terms, legal obligations and market integrity rules still apply.
- This is research software, not financial advice.
