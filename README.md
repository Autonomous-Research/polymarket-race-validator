# Polymarket Trader Research: `@djdjdjekekek`

Transaction-level investigation of a high-volume Polymarket account, including wallet-control attribution, decoded funding flows, maker/taker reconstruction, actual bet case studies, event correlation, statistical robustness checks, and a paper-only replication monitor.

Profile: [polymarket.com/@djdjdjekekek](https://polymarket.com/@djdjdjekekek)

## Read This First

1. [Executive report](research/djdjdjekekek/report.md)
2. [Onchain investigation](research/djdjdjekekek/onchain_report.md)
3. [Deep trader report](research/djdjdjekekek/trader_report.md)
4. [Replication report](research/djdjdjekekek/replication_report.md)

## Main Discovery

The account is a two-layer operation. Small maker fills dominate row count, while a small number of large, fee-paying taker fills dominate capital and profitability.

| Finding | Result |
| --- | ---: |
| Maker fills | 92.8% of fills, 27.9% of quote notional |
| Taker fills | 7.2% of fills, 72.1% of quote notional |
| Markets with at least 50% taker notional | +23.76% capital-weighted ROI |
| Markets below 50% taker notional | -31.21% capital-weighted ROI |
| Single-game/map markets | -$3.11M realized PnL |
| Net cash withdrawn above deposits | $5.91M |
| Fixed 60-second copy proxy, untouched test period | 30 bets, +3.98% ROI |

The aggressive/passive split survives a controlled logistic model and event-cluster bootstrap. The copy result does not yet survive a confidence test: its interval is wide and crosses zero. The prototype is therefore intentionally paper-only.

## Onchain Result

The public profile resolves to deposit wallet `0x6D20...a165`, a Polymarket `POLY_1271` wallet rather than a Gnosis Safe. Three independent contract surfaces resolve control to EOA `0xC332...141b`:

- `owner()`
- the address encoded in `id()`
- the sole `OwnershipTransferred` initialization event

That EOA directly transacted with an EIP-7702 source account responsible for $29.56M across 358 funding transactions. Large deposit and withdrawal routers are labeled as infrastructure rather than falsely attributed to the owner. See the [onchain report](research/djdjdjekekek/onchain_report.md) for explorer links and confidence boundaries.

## Actual Bet Reconstruction

The analysis does not stop at profile totals. It reconstructs each market from fills, activity cash, exact taker hashes, CLOB metadata, game start time, resolved outcome, deposits, rebates, and correlated conditions.

Representative cases include:

- Team Spirit in the TI 2026 final: more than $1M of aggressive buys accumulated roughly 82 minutes before start; +$2.88M realized PnL.
- FUT over FURIA: a roughly $1.01M taker BUY near 0.448, 2.5 minutes before start; +$1.54M PnL.
- Team Yandex against Spirit: repeated same-direction series and game exposure during a 0-2 loss; approximately -$1.55M across correlated conditions.

The resulting edge thesis is specific: domain selection, pregame thesis formation, and large aggressive conviction, followed by in-play inventory management. Maker rebates, generic live latency, and map duplication do not explain the profit.

## Repository Map

Core pipeline:

- `src/trader_research.js` - command-line orchestration.
- `src/research/collect.js` - public Polymarket collection with windowed pagination.
- `src/research/onchain.js` - wallet control, contract state, logs and transaction-flow decoding.
- `src/research/analyze.js` - fill reconstruction, accounting, timing, event grouping and case studies.
- `src/research/backtest.js` - no-lookahead chronological simulations and execution sensitivity.
- `src/research/statistical_analysis.py` - robust regression, chronological validation and clustered bootstrap.
- `src/research/replicator.js` - guarded paper-intent state machine.
- `src/research/report.js` - reproducible Markdown reports.

Primary structured artifacts:

- `snapshot.json` - raw public profile, fills, activity and positions.
- `enrichment.json` - CLOB metadata, exact taker fills, rebates and onchain evidence.
- `deep_analysis.json` - reconstructed market-level analysis.
- `statistical_analysis.json` and `market_features.csv` - robustness outputs.
- `onchain_evidence.json` and `flow_transactions.json` - decoded chain evidence.
- `replication_backtest.json`, `replicator_config.json`, and `replication_intents.json` - prototype evidence and output.

All generated artifacts are under `research/djdjdjekekek/`.

## Setup

Node.js 20+ and Python 3.11+ are recommended.

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r requirements-analysis.txt
```

Run verification:

```bash
npm test
.venv/bin/python -m py_compile src/research/statistical_analysis.py
```

## Reproduce Saved Analysis

The saved snapshot can be analyzed without recollecting all public data:

```bash
npm run research:analyze
.venv/bin/python src/research/statistical_analysis.py
npm run research:replicate
npm run research:report
```

## Refresh Public Data

```bash
npm run research:collect
npm run research:enrich
npm run research:analyze
.venv/bin/python src/research/statistical_analysis.py
npm run research:replicate
npm run research:report
```

`npm run research:onchain` refreshes contract state and chain evidence separately. `npm run research:monitor` performs one fresh public-data pass, evaluates current order books, and emits paper intents only.

For a complete rebuild with the virtual environment, run `PYTHON=.venv/bin/python npm run research:all`.

Optional environment variables:

```text
TARGET_USERNAME=djdjdjekekek
TARGET_WALLET=0x...
OUT_DIR=research/djdjdjekekek
POLYGON_RPC=https://...
HTTP_TIMEOUT_MS=30000
REFRESH_ENRICHMENT=1
```

## Replication Rules

The fixed paper strategy watches exact target taker BUYs and requires:

- at least $25,000 of cumulative aggressive target buying;
- at least 70% net directional concentration;
- an entry price from 0.30 to 0.85;
- tennis, soccer, Dota 2, Counter-Strike, League of Legends, or Valorant;
- no single game/map or short-horizon crypto condition;
- one condition per canonical event;
- a fresh signal and an order book that has not moved more than one cent adversely.

The monitor emits a post-only paper BUY below the ask, caps exposure, records rejection reasons, and expires the intent after five minutes. It contains no order-signing or submission path.

## Data Integrity

- High-volume endpoints use recursive time windows rather than trusting an offset cap.
- Maker/taker role comes from exact `takerOnly=true` transaction hashes.
- Activity size and cash correct maker sub-fills exposed by the public trade feed.
- The official fee curve independently checks role classification.
- Every reported deposit and withdrawal has a decoded Blockscout transaction.
- Correlated uncertainty is estimated by bootstrapping canonical events, not individual conditions.
- Train/test selection is chronological and every execution waits for the configured copy lag.

## Limits

This is an investigation of public addresses and public market behavior. It does not identify a natural person. The account was selected because of exceptional observed performance, creating selection bias. Historical target fills are not a complete order book, passive queue fills are unproven, and a positive 30-bet test is not enough to deploy capital.

This repository is for research and simulation, not financial advice.
