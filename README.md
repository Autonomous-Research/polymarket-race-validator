# Polymarket Trader Research: `@djdjdjekekek`

Reverse-engineering and dry-run replication prototype for the Polymarket account:

https://polymarket.com/@djdjdjekekek

This repository resolves the public profile to its Polymarket proxy wallet, collects public trading and wallet-activity data, summarizes the strategy, and emits a dry-run replication plan. It does not place live trades.

## Executive Summary

Target profile:

- Username: `Djdjdjekekek`
- Pseudonym: `Webbed-Myth`
- Proxy wallet: `0x6d20c35f65d9899b6d6b74f8466e824580f9a165`

Latest collected snapshot:

- First observed trade: `2026-06-19T18:37:08.000Z`
- Last observed trade: `2026-08-25T00:45:55.000Z`
- Trade rows collected: `28,167`
- Activity rows collected: `28,948`
- Unique markets traded: `383`
- Closed positions: `392`
- Active positions: `1`
- Gross observed trade notional: about `$74.6M`
- Closed realized PnL: about `$5.6M`

Main thesis:

The trader is primarily a high-conviction esports and sports bettor, not a broad prediction-market maker. The strongest pattern is aggressive pyramiding into single match outcomes, with many small fills and occasional very large blocks. BTC 5-minute markets appear to be low-notional noise or experimentation relative to the core strategy.

The replication prototype therefore follows a constrained copy/strategy hybrid:

- Follow only esports and sports outcomes.
- Ignore BTC 5-minute markets by default.
- Require strong target conviction before generating an intent.
- Cap single-market and portfolio risk.
- Treat historical closed markets as templates, not live order instructions.
- Emit dry-run intents only.

## Repository Map

Core implementation:

- `src/trader_research.js` - collector, analyzer, thesis builder, and dry-run replicator.
- `test/utils.test.js` - focused tests for auth header generation, market classification, and replicator defaults.
- `package.json` - npm scripts.

Generated research artifacts:

- `research/djdjdjekekek/report.md` - readable trader thesis and analysis.
- `research/djdjdjekekek/analysis.json` - structured analysis output.
- `research/djdjdjekekek/replicator_config.json` - dry-run strategy configuration.
- `research/djdjdjekekek/replication_intents.json` - generated dry-run replication intents.
- `research/djdjdjekekek/snapshot.json` - raw collected public data snapshot.

Legacy project files:

- `src/app.js`, `src/probe.js`, and `src/utils.js` are from the original Polymarket validator project and are left intact.

## Commands

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Collect fresh public data and regenerate all research artifacts:

```bash
npm run research:collect
```

Rebuild analysis/report from the saved snapshot without calling Polymarket APIs:

```bash
npm run research:analyze
```

Generate dry-run replication intents from the saved snapshot and config:

```bash
npm run research:replicate
```

## Data Sources

The collector uses public Polymarket endpoints:

- Gamma public search/profile endpoints for username-to-wallet resolution.
- Data API positions, closed positions, activity, value, traded, and trades endpoints.

The code uses time-window pagination for high-volume endpoints so the analysis does not silently stop at a single API page.

## Strategy Thesis

The observed strategy has four major features.

First, notional concentration is domain-specific. Esports accounts for the largest share of observed trade notional, followed by traditional sports. BTC 5-minute trading has many rows but very small notional share.

Second, position construction is pyramidal. The account often accumulates a single outcome through many fills. The median fill is small, but large individual fills and very large final market exposure are common.

Third, outcomes are lumpy. The account has many losing closed positions, but a small number of very large winners dominate realized PnL. This is not a smooth market-making profile.

Fourth, wallet activity is operationally simple from public data. Activity rows show deposits, withdrawals, trades, and redeems against the proxy wallet. The public endpoints do not expose a separate owner EOA, so deeper wallet clustering requires a block-indexer or explorer API.

## Replication Prototype

The prototype produces JSON intents such as:

- `CLONE_ACTIVE_POSITION` for a current live holding.
- `WATCH_NEXT_SIMILAR_SETUP` for historical setups that match the trader's pattern.

The default rules are conservative:

- Allowed families: `esports`, `sports`
- Ignored families: `crypto-5m`
- Max single order: `$2,500`
- Max portfolio risk: `8%`
- Max single-market risk: `2.5%`
- Max copy lag: `300` seconds
- Max slippage: `3` cents
- No chase above price: `0.75`

This is a research prototype. Live execution would require explicit credentials, stronger market-state checks, compliance review, and user-owned risk controls.

## Caveats

- Public Polymarket trade rows expose `size` and `price`; trade notional is derived as `size * price` when `usdcSize` is absent.
- Public Data API wallet activity exposes the proxy wallet and transaction hashes, but not all owner-wallet relationships.
- Reported profile value/PnL may move after snapshot time.
- Historical replication intents are templates, not recommendations to trade stale markets.
- This repository is for research and simulation, not financial advice.

## Private GitHub Repo

Suggested private repository:

```text
autonomous-finance/polymarket-trader-research
```

Create and push after GitHub CLI authentication:

```bash
gh auth login
gh repo create autonomous-finance/polymarket-trader-research --private --source=. --remote=autonomous-finance --push
```
