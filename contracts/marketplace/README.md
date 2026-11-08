# marketplace contract

The SwarmCompute escrow and auction contract (spec Section 8). Rust, `near-sdk` 5.30.1 (verified on crates.io, 2026-11-07), built with `cargo-near` 0.23.0.

The commitment encoding and its shared test vector are in `ARCHITECTURE.md` §6. The Rust implementation (`src/commitment.rs`) reproduces the vector.

## Build and test

```sh
# Unit tests (mocked chain, native, fast)
cargo test

# wasm build -> target/near/marketplace.wasm
cargo near build non-reproducible-wasm

# Real-chain tests on NEAR Testnet (spend testnet NEAR, take several minutes)
cd ../marketplace-testnet-tests
NEAR_TEST_ACCOUNT_ID=you.testnet NEAR_TEST_PRIVATE_KEY=ed25519:... cargo test -- --ignored --nocapture
```

The testnet run writes every transaction hash to `contracts/marketplace-testnet-tests/target/testnet-report.md`.

On Windows you need the Visual Studio "Desktop development with C++" workload (MSVC linker and Windows SDK). `.cargo/config.toml` sets `AWS_LC_SYS_PREBUILT_NASM=1`, so NASM isn't needed.

## Why testnet instead of the sandbox

The spec asks for `near-workspaces` sandbox tests. The NEAR sandbox binary only runs on Linux x86 and macOS ARM (`near-sandbox` README), so it can't run on the Windows dev machine. We decided (2026-11-07) to split the testing:

- **Unit tests** (`src/tests.rs`, 23 tests) cover every rule and transition, including the fairness guarantees. Promise results are simulated, so they cover payout and withdrawal success and failure.
- **Testnet tests** (`../marketplace-testnet-tests`) cover what a mocked chain can't. Buyers prepay from their own real wallets. Every member is charged the clearing price, and the excess reaches each wallet. A payout to an account that doesn't exist fails, then is retried. A withdrawal to a deleted buyer wallet fails, then is retried. They also cover `#[private]` enforcement, real block-time deadlines and expiry by a third party.

On Linux or macOS the same scenarios could later be pointed at the sandbox.

## Fair-price collective buying

The contract guarantees that no buyer in a coalition is cheated:

1. **Nobody pays above its own maximum.** Each member's max price is registered with the coalition. The price ceiling is the lowest of them.
2. **Everyone pays the same rate.** At close, the lowest eligible revealed bid becomes the clearing price. Every member owes `hours × clearing price`.
3. **The cheapest seller wins.** The lowest eligible bid wins, with ties broken by reputation, then commit height, then seller ID.
4. **Overpayment comes back.** Each member prepays `hours × its own max` from **its own wallet**. At close, `prepaid − owed` is credited to that buyer and sent back to its wallet.
5. **Failure means a full refund to each buyer.** Failed delivery, a partial delivery or an expired deadline credits each member's remaining money back to that member, not to a central funder.

## Roles

| Role | Can |
|---|---|
| owner | `set_roles`, `set_owner`, `set_paused` |
| operator | register buyers (with wallet), sellers and coalitions (with member max prices); `leave_coalition`; `create_purchase`, `open_bidding`, `commit_bid`, `reveal_bid`; `start_delivery`, `submit_delivery_report` |
| a buyer's own wallet | `prepay` for that buyer only (payable, exactly `hours × own max price`) |
| verifier | `verify` |
| anyone | `close_auction`, `expire`, `payout` (retry), `withdraw_balance`, all views |

`payout` and `withdraw_balance` are open to anyone because neither can choose where the money goes. A payout always goes to the awarded seller's registered payout account. A withdrawal always goes to the buyer's registered wallet. The funder role from the spec no longer appears in the contract; it tops up the buyer wallets when the demo is set up.

## State machine

```
CREATED (members prepay) ─open_bidding─▶ BIDDING ─close_auction─▶ FUNDED  (winner: excess credited back)
                                                  └──────────────▶ FAILED ─▶ REFUNDED  (no eligible bid)
FUNDED ─start_delivery─▶ DELIVERING ─submit_delivery_report─▶ VERIFYING
VERIFYING ─verify(ok) + payout callback─▶ COMPLETED
VERIFYING ─verify(fail)─▶ FAILED ─▶ REFUNDED
CREATED (prepay deadline) | FUNDED/DELIVERING (delivery deadline) | VERIFYING (verification deadline) ─expire─▶ EXPIRED ─▶ REFUNDED
```

How this differs from spec Section 8:
- **No AWARDED → `fund` step.** Members prepay before bidding, so escrow is already funded when the auction closes.
- **Refunds are credited to each buyer**, not to a single funder.
- **FUNDED and CREATED can both expire**, so a stalled operator can never trap anyone's money.

| Deadline | Set when | Equals |
|---|---|---|
| `prepay_deadline` | `create_purchase` | now + `prepay_secs` |
| `commit_deadline` | `open_bidding` | now + `commit_secs` |
| `reveal_deadline` | `open_bidding` | `commit_deadline` + `reveal_secs` |
| `delivery_deadline` | award (`close_auction`) | now + `delivery_secs` |
| `verification_deadline` | delivery report | now + `verification_secs` |

## Funds safety

- **Exact prepayment.** The attached deposit must equal `hours × own max price`, and must come from that buyer's wallet, or the call panics and the deposit is returned.
- **One clearing price.** `owed = hours × clearing price` for every member. The contract asserts `held == Σ owed` after crediting the excess.
- **Buyer budgets.** Available budget is `max_budget − reserved − spent`, so a buyer can't exceed its total budget across several purchases.
- **Guards on payouts and withdrawals.** Each sets an in-flight marker before creating the transfer. The callback either finalises the transfer or clears the marker so it can be retried. A second call while the marker is set panics.
- **Separate escrow.** `total_escrowed` equals Σ `held`, and `total_balances` equals Σ buyer balances. Every outgoing transfer first asserts `balance − storage_cost ≥ total_escrowed + total_balances`.
- **Pause.** It blocks registration, prepayments, bidding, delivery, verification and payouts. It never blocks `expire`, `withdraw_balance` or callbacks.
## Storage

The owner pre-funds the contract account for storage, so operator methods aren't payable. The caps on sellers (20), coalition members (32) and offers per seller (4) keep per-purchase storage bounded.

## Events

NEP-297, `EVENT_JSON:{"standard":"swarmcompute","version":"1.0.0","event":...,"data":[{...}]}`. Amounts are decimal strings. Every purchase-scoped event carries `purchase_id`. Events: `contract_initialized`, `roles_updated`, `owner_updated`, `paused_updated`, `buyer_registered`, `seller_registered`, `coalition_registered`, `coalition_member_left`, `purchase_created`, `prepaid`, `purchase_state_changed`, `bidding_opened`, `bid_committed`, `bid_revealed`, `auction_closed`, `purchase_funded` (with per-member `prepaid` / `owed` / `excess` lines), `balance_credited`, `delivery_started`, `delivery_reported`, `delivery_verified`, `payout_started`, `payout_succeeded`, `payout_failed`, `refund_succeeded` (with per-buyer `lines`), `withdrawal_started`, `withdrawal_succeeded`, `withdrawal_failed`, `reputation_updated`.

## Reputation

Reputation changes only through contract transitions:

| Field | Increases when |
|---|---|
| `wins` | the seller wins an auction |
| `completed_deliveries` | a payout succeeds |
| `failed_deliveries` | `verify(fail)` runs, or a delivery deadline expires while DELIVERING |
| `non_reveals` | an auction closes without the seller's reveal |

Two expiries leave reputation unchanged: VERIFYING (the verifier stalled) and FUNDED (the operator never started delivery). Neither is the seller's fault. The tie-break score is `completed − failed − non_reveals`.

## Known limits (MVP)

- Seller capacity is checked per auction, not reserved across concurrent auctions.
- A reveal whose hash doesn't match is rejected (the transaction panics), so it leaves no record. The seller can still reveal correctly before the deadline. A seller who never reveals is marked `NOT_REVEALED` at close and penalised.
