# Polymarket Trader Reverse Engineering: Djdjdjekekek

Snapshot: 2026-08-25T00:59:17.668Z
Profile: https://polymarket.com/@djdjdjekekek
Proxy wallet: `0x6d20c35f65d9899b6d6b74f8466e824580f9a165`

## Data Sources

- Polymarket Gamma `/public-search` and `/public-profile` for profile-to-wallet resolution.
- Polymarket Data API `/positions`, `/closed-positions`, `/activity`, `/trades`, `/value`, and `/traded` for trading and wallet activity.
- Public profile HTML was used only as a cross-check of displayed value/PnL.

## Coverage

- First observed trade: 2026-06-19T18:37:08.000Z
- Last observed trade: 2026-08-25T00:45:55.000Z
- Trade rows collected: 28,167
- Activity rows collected: 28,948
- Unique markets from trades: 383
- Polymarket traded endpoint count: 383
- Closed positions: 392
- Active positions: 1

## Wallet And Onchain Activity

- Deposits: 360 totaling $31,642,992.64
- Withdrawals: 117 totaling $37,483,621.19
- Redeems: 169 totaling $40,285,419.83
- Splits: 0; merges: 0

Public Data API activity rows expose the proxy wallet and transaction hashes, but not a separate EOA owner for this profile. Without a block-indexer API key, the current prototype treats the proxy wallet as the authoritative detected wallet and records all transaction hashes for deeper block-explorer clustering.

## Trading Profile

- Gross observed trade notional: $74,613,854.59
- BUY fills: 27,495 / $53,933,358.71
- SELL fills: 672 / $20,680,495.88
- Average fill: $2,648.98; median fill: $24.5
- Closed realized PnL: $5,601,928.33 (9.97% of estimated closed cost basis)
- Active current value: $24,232.35; active cash PnL: $869.96

## Notional By Family

- esports: $43,674,161.89 across 13,536 fills
- sports: $25,318,642.44 across 8,311 fills
- other: $5,347,695.03 across 1,274 fills
- crypto-5m: $273,355.23 across 5,046 fills

## Largest Closed Winners

- Dota 2: TEAM VISION vs Team Spirit (BO5) - The International Playoffs | Team Spirit: PnL $2,882,989.96, bought 5,223,962.626 shares @ avg 0.4480
- Counter-Strike: FURIA vs FUT Esports (BO3) - Esports World Cup Playoffs | FUT Esports: PnL $1,535,241.47, bought 2,836,524.461 shares @ avg 0.4584
- Dota 2: Iron Wing vs BoomBoys (BO3) - The International Playoffs | BoomBoys: PnL $1,316,320.8, bought 3,339,218.813 shares @ avg 0.6057
- Dota 2: Team Spirit vs Team Liquid (BO3) - The International Playoffs | Team Spirit: PnL $1,306,055.01, bought 3,598,245.071 shares @ avg 0.6370
- Dota 2: Nigma Galaxy vs Team Falcons (BO3) - The International Playoffs | Nigma Galaxy: PnL $1,096,482.28, bought 1,757,255.641 shares @ avg 0.3751
- Dota 2: Team Falcons vs Team Liquid (BO5) - 1win Essence Playoffs | Team Liquid: PnL $1,026,958.67, bought 1,665,161.963 shares @ avg 0.3832
- Cincinnati Open: Tommy Paul vs Flavio Cobolli | Flavio Cobolli: PnL $826,416.91, bought 1,616,118.833 shares @ avg 0.4886
- Cincinnati Open: Taylor Fritz vs Brandon Nakashima | Brandon Nakashima: PnL $821,248.05, bought 1,356,338.515 shares @ avg 0.3945
- Croatia Open: Alex Molcan vs Alejandro Davidovich Fokina | Alex Molcan: PnL $650,666.26, bought 1,004,089.658 shares @ avg 0.3516
- Boston Red Sox vs. Los Angeles Dodgers | Boston Red Sox: PnL $579,916.98, bought 765,633.678 shares @ avg 0.2425

## Largest Closed Losers

- Dota 2: Team Yandex vs Team Spirit - Game 2 Winner | Team Yandex: PnL $-1,142,095.82, bought 2,466,676.353 shares @ avg 0.4630
- Dota 2: Team Yandex vs Nigma Galaxy (BO3) - The International Playoffs | Nigma Galaxy: PnL $-997,063.86, bought 2,332,897.027 shares @ avg 0.4273
- Counter-Strike: Vitality vs 100 Thieves (BO1) - Esports World Cup Group C | 100 Thieves: PnL $-770,062.01, bought 2,640,381.584 shares @ avg 0.2916
- National Bank Open: Valentin Vacherot vs Mariano Navone | Valentin Vacherot: PnL $-695,547.74, bought 1,128,859.222 shares @ avg 0.6161
- Dota 2: Team Spirit vs TEAM VISION - Game 1 Winner | Team Spirit: PnL $-651,155.7, bought 1,300,000 shares @ avg 0.5008
- Dota 2: BoomBoys vs Team Spirit (BO3) - The International Playoffs | BoomBoys: PnL $-637,401.55, bought 2,057,587.603 shares @ avg 0.3097
- Dota 2: Team Liquid vs Team Falcons - Game 1 Winner | Team Liquid: PnL $-563,572.2, bought 1,032,266.699 shares @ avg 0.5459
- Dota 2: Team Spirit vs TEAM VISION (BO3) - The International Playoffs | Team Spirit: PnL $-546,726.21, bought 1,650,001.778 shares @ avg 0.3870
- Dota 2: TEAM VISION vs Team Yandex - Game 2 Winner | TEAM VISION: PnL $-507,491.97, bought 854,426.872 shares @ avg 0.5939
- Counter-Strike: PARIVISION vs B8 (BO1) - Esports World Cup Group C | PARIVISION: PnL $-487,985.57, bought 794,756.998 shares @ avg 0.6140

## Current Active Positions

- Boston Red Sox vs. Miami Marlins | Boston Red Sox: 55,706.545 shares, avg 0.4193, current 0.4350, value $24,232.35, cash PnL $869.96

## Thesis

- Primary edge appears to be concentrated discretionary esports betting, not broad prediction-market making. Esports represents 58.5% of observed fill notional and 200 closed positions.
- The wallet pyramids into single match outcomes with many small fills plus occasional very large blocks. The median fill is $24.5, but the largest fills are five to six figures of USDC.
- The account is willing to compound aggressively. Closed position PnL is dominated by a small number of resolved esports winners, while current active exposure is $23,362.38 initial value across 1 open positions.
- The BTC 5-minute activity looks exploratory or execution/noise relative to the main edge: many fills, short event horizons, and materially smaller average notional than the esports book.
- On-chain-account behavior is simple from Polymarket public data: funding arrives as deposits, trading creates CLOB trade rows, and settlement happens via redeems. Deposits=360, withdrawals=117, redeems=169.
- Replicating the trader should therefore be a constrained copy/strategy hybrid: follow esports and sports outcomes only after the target crosses a conviction threshold, size esports larger than sports, scale in over time, cap per-market loss, and ignore or downweight high-frequency BTC up/down trades.

## Prototype Replication Rules

```json
{
  "allowedFamilies": [
    "esports",
    "sports"
  ],
  "ignoredFamilies": [
    "crypto-5m"
  ],
  "familySizingMultiplier": {
    "esports": 1,
    "sports": 0.5
  },
  "minTargetMarketNotionalUsdc": 10000,
  "minTargetOutcomeShare": 0.7,
  "maxPortfolioRiskPct": 0.08,
  "maxSingleMarketRiskPct": 0.025,
  "entrySizing": {
    "baseUsdc": 25,
    "addWhenTargetAddsUsdc": 5000,
    "maxOrderUsdc": 2500
  },
  "priceGuard": {
    "maxCopyLagSeconds": 300,
    "maxSlippageCents": 3,
    "noChaseAbovePrice": 0.75
  },
  "exitPolicy": {
    "takeProfitWhenPriceAbove": 0.9,
    "cutWhenTargetSellsOverPctOfMarketPosition": 0.35,
    "reduceBeforeScheduledStartMinutes": 5
  }
}
```

The prototype is intentionally dry-run. It emits order intents from public data and strategy rules; placing live orders requires user-owned Polymarket credentials, explicit risk limits, and compliance with Polymarket availability rules.
