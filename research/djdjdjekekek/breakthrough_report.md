# Breakthrough Audit

Generated 2026-08-25T16:10:33.436921+00:00. This is the shortest path through the second-pass investigation.

## Discovery

The account's repeatable-looking signal is not simply "large bet" and not "copy a winning whale." Blindly copying every canonical $25,000 signal would have lost $855.28 over 139 equal $100 bets (-6.15% ROI), including -6.68% after the fixed chronological split.

The narrower candidate is a **rapid, concentrated taker sweep in a full-match or multi-map market**, followed by enough market inertia for a delayed observer to see a similar public price.

Four pieces of evidence support that narrower claim:

1. Blind copying loses -6.15% overall and -6.68% later. Urgency is the first observable filter that changes the sign.
2. Correcting BO1 semantics separates 114 true multi-map series at +31.20% ROI from 81 single-game/map markets at -57.55%. The 9 mislabeled BO1 rows alone lost $1.78M.
3. On an unrelated market-wide tape, a forced 60-second copy with five cents adverse stress returned +8.50% over 80 already-filtered events and +26.36% over the chronological final 24.
4. Signals concentrated into the final 60 seconds returned +24.37%; slower accumulations returned -24.46%. Rapid signals won 41 times versus 31.24 implied by the execution proxy, while slow signals underperformed their proxy.

![Blind-copy attribution ladder](./figures/blind_copy_funnel.png)

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
| Rapid calibration gap | +18.1 pp | 41 actual wins versus 31.24 implied |
| Slow calibration gap | -11.9 pp | Public proxy does not underprice slow signals |
| Broad discipline/price control | OR 3.36, `p=0.023` | Candidate survives broad composition control |
| Fine discipline/price/time permutation | +9.6 pp, `p=0.239` | Candidate does not survive the tightest low-power control |

The result is directional and execution-sensitive. It is not yet statistically decisive: the fixed final-period day-cluster interval is -15.9% to +55.8%, and the walk-forward interval is -13.3% to +69.4%. Feature design occurred during this investigation, so the expanding-window result is not equivalent to a locked prospective trial.

## Sharpened Discovery

The most specific defensible hypothesis is **conviction compression**. The target's information appears strongest when it crosses liquidity quickly enough that at least 80% of observed aggressive buying arrives in one minute. The unrelated public execution proxy remains nearly unchanged, yet those sides later win 75.9% of the time against 57.8% implied. Slow signals win only 42.3% against 54.2% implied.

![Urgency-conditioned realized and implied probabilities](./figures/urgency_calibration.png)

The day-cluster bootstrap estimates a +30.0 pp rapid-minus-slow calibration gap with a +10.1 pp to +51.4 pp interval. This is stronger than the ROI interval because it asks whether the target side wins more often than its observed price implies, not how a few long-shot payouts happened to land.

The negative control is equally important. Tight conditioning by discipline, three price bands, and chronological period leaves only 52 comparable observations; permuting urgency labels within those strata produces one-sided `p=0.239`. Composition may explain part of the raw effect. The next genuine discovery must come from a prospectively locked forward sample, not another retrospective slice.

External microstructure research makes this hypothesis plausible without confirming it. [Engle and Lange](https://www.nber.org/papers/w6129) connect faster asymmetric transaction flow to thinner depth and higher trading costs; a 2026 [Polymarket informed-trading working paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6933527) finds order imbalance more robust than raw volume. This audit's sharper variable is therefore temporal concentration, not eventual stake. Neither paper tests this wallet or removes the need for prospective validation.

![Chronological equity under blind and filtered rules](./figures/strategy_equity.png)

## What Failed

**Predicting final size failed.** Trigger-fill share and deposit size correlate only 0.289 and 0.293 with final cost. The chronological sizing model has `R^2=-0.108`. Fixed fractional sizing is more defensible than mirroring eventual target exposure.

**A stable upstream leader was not found.** 14 recurring wallets were audited. SPCEXBUYER is the most interesting: it entered before 13 of 25 shared signals, aligned 7 times, opposed 6 times, and led aligned trades by a median 792 seconds. All 7 aligned directions won, but the near-even alignment/opposition split prevents a copying claim.

Chronology rejects peer confirmation as a filter. Peers selected only from early recurrence aligned with 24 later bets at +7.62% ROI; the 8 later bets without alignment returned +29.67%. The production model excludes peer identity.

**Simple subgroup hunting failed validation.** The chosen fresh-signal rule went from +36.5% in development to -23.9% in validation before rebounding. That instability is exactly why the external-tape baseline and expanding-window test carry more weight than the best subgroup.

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
