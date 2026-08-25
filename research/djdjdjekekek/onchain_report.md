# Onchain Investigation: @djdjdjekekek

Generated 2026-08-25T13:48:29.233Z. Polygon state was refreshed 2026-08-25T13:48:23.246Z.

## Finding

The profile wallet is not an unidentified Safe. It is a Polymarket POLY_1271 Deposit Wallet controlled by the EOA [0xC332040b7ed35DeB84488bEEa049d8d34934141b](https://polygon.blockscout.com/address/0xC332040b7ed35DeB84488bEEa049d8d34934141b). The wallet's onchain `owner()`, its `id()`, and its sole initialization event all resolve to that same EOA. The owner then directly transacted with the EIP-7702 account that supplied $29.56M of the target's funding.

This establishes an address-control graph. It does **not** identify a natural person, and the high-volume deposit and withdrawal routers are deliberately not attributed to the owner.

## Control Graph

| Role | Address | Evidence | Confidence |
| --- | --- | --- | --- |
| Public profile / funder | [0x6D20C35F65D9899B6d6B74f8466e824580F9a165](https://polygon.blockscout.com/address/0x6D20C35F65D9899B6d6B74f8466e824580F9a165) | Gamma profile, deployed bytecode, pUSD balances and all trading activity | Confirmed |
| Deposit-wallet implementation | [0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB](https://polygon.blockscout.com/address/0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB) | EIP-1967 implementation slot | Confirmed |
| Controller EOA | [0xC332040b7ed35DeB84488bEEa049d8d34934141b](https://polygon.blockscout.com/address/0xC332040b7ed35DeB84488bEEa049d8d34934141b) | `owner()`, `id()`, and `OwnershipTransferred` agree | Confirmed |
| Main funding source | [0x8B2F31a32D033067538244E4a39b6C964Bb7510E](https://polygon.blockscout.com/address/0x8B2F31a32D033067538244E4a39b6C964Bb7510E) | 358 backing deposits; owner sent a direct transaction to it | Strong address link |
| Main cash-out route | [0x4cD00E387622C35bDDB9b4c962C136462338BC31](https://polygon.blockscout.com/address/0x4cD00E387622C35bDDB9b4c962C136462338BC31) | 119 withdrawals, but 456,767 explorer-counted transactions | Infrastructure only |

The owner EOA is code-free, currently has nonce 2, and holds 150.004 POL. The main source is an EIP-7702 delegated account using `Simple7702Account`; its low explorer activity and the owner's [direct transaction](https://polygon.blockscout.com/tx/0x16f96d78250990c3405c71a38b6177887c31c1273e27292d2686cb9c5b7a04d7) make this relationship materially stronger than simple transfer adjacency.

## Wallet Anatomy

| Check | Result |
| --- | --- |
| Wallet type | `POLY_1271 Deposit Wallet` |
| Signature type | `3` (POLY_1271) |
| Relayer deployment check | `WALLET=true`, `SAFE=false` |
| Runtime bytecode | 125 bytes; hash `0x3ab8c1dc47a224191bae04f12253073bee0b2a2994e41d753178e6d7d5f1f3d6` |
| Factory | [0x00000000000Fb5C9ADea0298D729A0CB3823Cc07](https://polygon.blockscout.com/address/0x00000000000Fb5C9ADea0298D729A0CB3823Cc07) |
| Current batch nonce | 216 |
| Batch executions observed | 216 |
| Session-signer events | 0 |
| Upgrade events | 0 |
| Paused | `false` |

Polymarket's documentation defines signature type 3 as a deposit wallet whose owner or session signer authorizes orders through ERC-1271. The absence of session-signer events means the controller EOA is the only controller evidenced by this contract history; it does not prove that no offchain automation exists.

## Launch Timeline

| Event | UTC | Block / transaction |
| --- | --- | --- |
| Wallet initialized to owner | 2026-06-19T18:32:44Z | 88792646 |
| First `BatchExecuted` | 2026-06-19T18:32:55Z | 88792653 |
| First observed trade | 2026-06-19T18:37:08Z | [transaction](https://polygon.blockscout.com/tx/0xb214c9ef5dd831e2a305ff9273a36c1c7028f0f608021558e1787651dc555574) |

Initialization to first observed trade took 264 seconds (4.4 minutes). That sequence, plus 216 batches and rapid treasury transfers, is consistent with a purpose-built automated trading operation.

## Funding In

All 362 reported deposits were decoded from their transaction receipts.

| Origin | Transfers | Amount | Share of deposits | Explorer tx count | Interpretation |
| --- | ---: | ---: | ---: | ---: | --- |
| [0x8B2F31...b7510E](https://polygon.blockscout.com/address/0x8B2F31a32D033067538244E4a39b6C964Bb7510E) | 358 | $29.56M | 93.27% | 32 | Owner-funded EIP-7702 source account |
| [0xf70da9...A3dbEF](https://polygon.blockscout.com/address/0xf70da97812CB96acDF810712Aa562db8dfA3dbEF) | 3 | $2.13M | 6.73% | 2,883,694 | High-volume infrastructure; not identity evidence |
| [0xB35D87...2D363b](https://polygon.blockscout.com/address/0xB35D87Bf9414858eD098D6340547EDDc152D363b) | 1 | $0.20 | 0.00% | 0 | Unclassified dust/source |

The $2.13M from `0xf70da9...A3dbEF` arrived as three direct USDC.e transfers. Its roughly 2,883,694 explorer transactions make it a router or service-like account, not a credible second owner wallet. A $0.20 PUSD transfer is immaterial.

## Cash Out

| Destination | Transfers | Amount | Explorer tx count | Interpretation |
| --- | ---: | ---: | ---: | --- |
| [0x4cD00E...38BC31](https://polygon.blockscout.com/address/0x4cD00E387622C35bDDB9b4c962C136462338BC31) | 119 | $37.60M | 456,767 | Shared contract/infrastructure |
| [0xb92fe9...4fFf4f](https://polygon.blockscout.com/address/0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f) | 1 | $36.00 | 193,786 | Shared contract/infrastructure |

The main destination has hundreds of thousands of transactions and millions of token transfers. It is a shared cash-out contract. Following it as though it were the trader would be a false identity cluster.

## Cash Reconciliation

| Item | Amount |
| --- | ---: |
| Deposits | $31.69M |
| Withdrawals | $37.60M |
| Net cash withdrawn | $5.91M |
| Onchain pUSD + USDC.e + native USDC | $0.00 |
| Open position value | $0.00 |
| Confirmed economic result | $5.91M |
| Closed realized PnL | $5.64M |
| Rebates and rewards | $427.6K |
| Closed PnL plus incentives | $6.07M |
| Confirmed result minus that endpoint total | -$165.4K |
| Activity-ledger residual, not an onchain balance | $196.5K |

The wallet was initialized immediately before its first deposit, currently has no open positions, and holds $0.00 across the three relevant stablecoins. Net withdrawals therefore provide the strongest economic result: $5.91M was extracted above deposits. The activity rows leave a $196.5K arithmetic residual even though RPC balances are zero, so that residual is retained as a data-quality diagnostic and is not counted as liquid value. Closed-position PnL plus incentives differs from the confirmed cash result by -$165.4K, consistent with endpoint accounting/timing differences.

## Treasury Automation

Deposits and buys have a 0.782 daily correlation. The next buy follows a deposit after a median 48 seconds; 57.5% occur within one minute and 87.3% within five. This is strong evidence of just-in-time funding and capital recycling.

## Confidence Boundaries

| Statement | Assessment |
| --- | --- |
| The profile wallet is a type-3 Deposit Wallet | Confirmed by relayer response, bytecode and implementation |
| `0xC33204...34141b` controls it | Confirmed by three independent contract fields/events |
| `0x8B2F31...b7510E` is linked to the owner | Strong: direct owner transaction plus 358 deposits |
| The large router addresses belong to the trader | Unsupported; their activity profiles indicate shared infrastructure |
| A real-world person can be named | Not established by public evidence |

## Sources

- [Polymarket trading overview and signature types](https://docs.polymarket.com/trading/overview)
- [Polymarket relayer deployment check](https://docs.polymarket.com/api-reference/relayer/check-if-a-wallet-is-deployed)
- [Wallet explorer](https://polygon.blockscout.com/address/0x6D20C35F65D9899B6d6B74f8466e824580F9a165)
- [Owner explorer](https://polygon.blockscout.com/address/0xC332040b7ed35DeB84488bEEa049d8d34934141b)
- [Main source explorer](https://polygon.blockscout.com/address/0x8B2F31a32D033067538244E4a39b6C964Bb7510E)
- [Implementation explorer](https://polygon.blockscout.com/address/0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB)
- Raw evidence: [onchain_evidence.json](./onchain_evidence.json) and [flow_transactions.json](./flow_transactions.json)
