# Frozen Prospective Audit

Generated: 2026-08-27T03:32:49.576Z

**Status: insufficient_new_evidence.** No post-cutoff signal passed the previously frozen atomic-breadth rule. This window neither validates nor falsifies profitability.

The historical cutoff is 2026-08-25T06:09:12.000Z. The rule was not re-fit on this window.

## Scoreboard

| Stage | Signals |
|---|---:|
| Raw $25k / 70% threshold crossings | 7 |
| Decoded trigger transactions | 7 |
| Frozen base-universe signals | 2 |
| Raw >=18-maker sweeps before universe guards | 2 |
| Frozen >=18-maker signals | 0 |
| Compact-fresh shadow signals | 0 |

## Every Raw Candidate

| Time (UTC) | Market | Discipline | Price | Makers | Levels | Median age | Result | Rejection |
|---|---|---|---:|---:|---:|---:|---|---|
| 2026-08-25T16:15:55.000Z | US Open, Qualification WTA: Moyuka Uchijima vs Polona Hercog | Tennis | 0.967 | 4 | 4 | 31.7s | resolved | TRIGGER_PRICE_ABOVE_0.85, MAKER_BREADTH_BELOW_18 |
| 2026-08-25T20:00:43.000Z | Winston-Salem Open: Adam Walton vs Ignacio Buse | Tennis | 0.750 | 11 | 1 | 7.8s | resolved | MAKER_BREADTH_BELOW_18 |
| 2026-08-25T20:15:00.000Z | US Open, Qualification ATP: Hugo Gaston vs Guido Justo | Tennis | 0.891 | 11 | 3 | 6.1s | resolved | TRIGGER_PRICE_ABOVE_0.85, MAKER_BREADTH_BELOW_18 |
| 2026-08-26T01:53:34.000Z | Los Angeles Dodgers vs. Atlanta Braves | MLB | 0.490 | 5 | 1 | 7.9s | resolved | DISCIPLINE_EXCLUDED:MLB, MAKER_BREADTH_BELOW_18 |
| 2026-08-26T13:50:07.000Z | Augsburg: Facundo Mena vs Kai Wehnelt | Tennis | 0.580 | 3 | 1 | 10.0s | resolved | MAKER_BREADTH_BELOW_18 |
| 2026-08-26T21:57:12.000Z | Los Angeles Dodgers vs. Atlanta Braves | MLB | 0.550 | 40 | 1 | 5597.3s | active_or_unresolved | DISCIPLINE_EXCLUDED:MLB |
| 2026-08-27T02:43:07.000Z | Minnesota Twins vs. Athletics | MLB | 0.320 | 19 | 1 | 15.0s | active_or_unresolved | DISCIPLINE_EXCLUDED:MLB |

## Interpretation

Every raw sweep reaching 18 makers was outside the frozen discipline universe. Therefore there is no new eligible bet to score. Reporting a win, loss, ROI, or confidence interval for the frozen rule from this window would manufacture evidence.

- Zero qualifying signals is an exposure problem, not a zero-return observation.
- Active or unresolved outcomes are retained as null and are never scored as losses.
- The compact-fresh rule remains a retrospective shadow tag and is not promoted by this audit.
- A broad sweep in an excluded discipline does not validate a core-universe strategy.
