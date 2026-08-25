# Breakthrough Audit

Generated 2026-08-25T15:44:14.119839+00:00. This is the shortest path through the second-pass investigation.

## Discovery

The account's repeatable-looking signal is not simply "large bet" and not "copy a winning whale." It is a **rapid, concentrated taker sweep in a full-match or multi-map market**, followed by enough market inertia for a delayed observer to see a similar public price.

Three pieces of evidence establish that narrower claim:

1. Correcting BO1 semantics separates 114 true multi-map series at +31.20% ROI from 81 single-game/map markets at -57.55%. The 9 mislabeled BO1 rows alone lost $1.78M.
2. On an unrelated market-wide tape, a forced 60-second copy with five cents adverse stress returned +8.50% over 80 events and +26.36% over the chronological final 24.
3. Signals concentrated into the final 60 seconds returned +24.37%; slower accumulations returned -24.46%. The split remains +14.9% versus -22.6% earlier and +41.8% versus -32.4% in the final period.

## What Survived Falsification

| Test | Result | Interpretation |
| --- | ---: | --- |
| Opposite side, final period | -46.03% | Direction matters |
| Random-side test | one-sided `p=0.0301` | Better than side choice alone in this slice |
| All canonical signals | -6.15% all / -6.68% later | Blind copying fails |
| Add rapid burst | +3.42% all / +6.36% later | Urgency flips the sign |
| Add format guard | +7.33% all / +19.57% later | One-map/short markets are the main structural leak |
| Five-cent all-period stress | +8.50% | Positive after fee and adverse-price stress |
| Keep BO1 eligible | +5.27% all / +14.09% later | Positive sign survives the classification correction |
| Ten-cent all-period stress | -0.37% | Aggregate edge is exhausted near this cost |
| 60-second median markout | 0.0000 | No median immediate repricing in public tape |
| Burst gate, same walk-forward period | 28 bets / +20.05% | Transparent primary selector |
| Model after burst behavior | 15 bets / +27.54% | Secondary filter; more top-winner concentration |
| Remove burst feature | AUC 0.547 vs 0.635 full | Burst adds predictive information in this sample |
| Remove public-tape features | AUC 0.576 | External flow and momentum add information |

The result is directional and execution-sensitive. It is not yet statistically decisive: the fixed final-period day-cluster interval is -15.9% to +55.8%, and the walk-forward interval is -13.3% to +69.4%. Feature design occurred during this investigation, so the expanding-window result is not equivalent to a locked prospective trial.

## What Failed

**Predicting final size failed.** Trigger-fill share and deposit size correlate only 0.289 and 0.293 with final cost. The chronological sizing model has `R^2=-0.108`. Fixed fractional sizing is more defensible than mirroring eventual target exposure.

**A stable upstream leader was not found.** 14 recurring wallets were audited. SPCEXBUYER is the most interesting: it entered before 13 of 25 shared signals, aligned 7 times, opposed 6 times, and led aligned trades by a median 792 seconds. All 7 aligned directions won, but the near-even alignment/opposition split prevents a copying claim.

Chronology rejects peer confirmation as a filter. Peers selected only from early recurrence aligned with 24 later bets at +7.62% ROI; the 8 later bets without alignment returned +29.67%. The production model excludes peer identity.

**Simple subgroup hunting failed validation.** The chosen fresh-signal rule went from +36.5% in development to -23.9% in validation before rebounding. That instability is exactly why the external-tape baseline and expanding-window test carry more weight than the best subgroup.

## Mechanism

The evidence is most consistent with informed liquidity demand:

1. The target pays taker fees to cross quickly when conviction appears.
2. The first burst contains more information than the eventual position size.
3. Public price response is often flat for 15-300 seconds, leaving a limited observation window.
4. Full-match and multi-map theses work; one-map bets destroy value.
5. Other whales visit the same markets, but no wallet consistently leads and agrees.

This mechanism is an inference from transaction behavior. It does not identify a private information source or prove causality.

## Decision

There is enough evidence to run the frozen walk-forward filter in paper mode. There is not enough evidence to deploy capital. Promotion would require at least 200 new eligible signals, executable-depth snapshots, FOK failure accounting, stable clustered confidence bounds above zero, and positive ROI after the top five winners are removed.

## Evidence

- [External tape and fixed tests](./edge_analysis.json)
- [Signal-level feature table](./edge_features.csv)
- [Frozen paper model](./edge_model.json)
- [Peer-wallet audit](./peer_evidence.json)
- [Replication implementation](../../src/research/replicator.js)
- [Polymarket Data API trade documentation](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets)
- [Polymarket Gamma market schema](https://docs.polymarket.com/api-reference/markets/list-markets)
- [Prediction-market price formation research](https://www.sciencedirect.com/science/article/pii/S1386418123000794)
- [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)
