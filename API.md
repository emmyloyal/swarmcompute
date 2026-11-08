# Public API

A read-only HTTP API for the UI and anyone else who wants to inspect the marketplace. It holds no keys and signs nothing. It reads **only** the `public_*` database views, so seller minimum prices, failure rates, unrevealed bids and message signatures are never exposed.

```sh
pnpm --filter @swarmcompute/backend api:start      # http://localhost:4000
```

The API accepts only `GET` (anything else returns 405) and returns JSON, with `cache-control: no-store` on every response.

**Money** is always a yocto decimal string (1 NEAR = 10²⁴ yocto), never a JSON number. **Timestamps** are ISO-8601 strings.

The database is a cache. The contract is the source of truth. Each purchase carries `drift_detected` / `drift_detail` from the reconciler, and the UI's "Check on-chain" button reads the contract directly.

## Endpoints

### `GET /api/meta`
Network and contract identifiers.
```json
{ "network": "testnet", "contractId": "market.swarm-….testnet", "explorerTxUrl": "https://testnet.nearblocks.io/txns/", "rpcUrl": "https://test.rpc.fastnear.com" }
```

### `GET /api/overview`
- `counts`: buyers, sellers, coalitions, purchases, transactions, `failed_transactions`, messages, `confirmed_messages`, `escrow_held_yocto`, `paid_out_yocto`, `refunded_yocto`, `returned_to_wallets_yocto`, `saved_vs_own_max_yocto`, `member_settlements`, `drifted`
- `byState`: `[{ state, n }]` purchase counts by escrow state
- `recentTx`: the last 8 transactions sent by the backend
- `outcomes`: the last 6 completed or refunded purchases, with payout or refund transaction hashes

### `GET /api/buyers`
One row per buyer:
- **Identity and wallet:** `buyer_id`, `wallet_account_id` (its real testnet wallet)
- **Latest requirement:** `gpu_model`, `min_vram_gb`, `required_hours`, `max_price_per_hour_yocto`, `latest_delivery_at`, `requirement_status`
- **Latest coalition:** `coalition_id`, `membership_status`
- **Totals:** `owed_yocto` (paid at clearing prices), `saved_yocto` (Σ prepaid − owed), `returned_yocto` (sent to its wallet), `purchases`

### `GET /api/sellers`
`seller_id`, `payout_account_id`, `pricing_strategy`, `offers[]` (GPU, VRAM, capacity, delivery time; simulated), `reputation` (latest snapshot taken from contract events, with `source_tx_hash`), `awards`, `paid_yocto`. Minimum prices and failure rates are not included.

### `GET /api/coalitions`
Coalitions with `members[]` (`buyer_id`, `hours`, `status`), `price_ceiling_per_hour_yocto` (the lowest member max), `total_budget_yocto`, `status`, `failure_reason`, and `purchases[]`.

### `GET /api/auctions`
Auctions with deadlines, `outcome`, state, the winner, the clearing price, `commitment_count` and `reveal_count`.
- `commitments[]` has `seller_id`, `commitment_hex`, `commit_tx_hash` and `revealed`. **It never includes a price.**
- `reveals[]` appears only for bids revealed on-chain: price, eligibility, reason and reveal transaction.

### `GET /api/purchases`
Purchases with state, winner, `winning_price_per_hour_yocto` (the clearing price), `required_total_yocto`, `deposited_yocto` (Σ prepaid), and drift flags.

### `GET /api/purchases/:purchaseId`
The full record for one purchase:
- `purchase`
- `allocations[]`: the per-member fairness record: `hours`, `max_price_per_hour_yocto`, `prepaid_yocto`, `owed_yocto` (hours × clearing price), `excess_yocto`, `refunded_yocto`, `prepay_tx_hash`, `wallet`, `withdrawals[]`
- `delivery`, `verification` (both simulated, with their on-chain transaction hashes)
- `settlements[]` (payout attempts), `refunds[]`, `refundLines[]`
- `transactions[]`: every transaction the backend sent for this purchase, with its real outcome
- `events[]`: indexed contract events

Returns 404 if the purchase doesn't exist.

### `GET /api/messages?type=&status=&limit=`
The agent message log, newest first (default limit 100, maximum 500).
- `status` is `ACCEPTED`, `CONFIRMED` (its transaction was verified against a matching contract event) or `REJECTED` (with `rejection_code`).
- `BID_REVEAL` payloads are redacted until the reveal is confirmed on-chain.

### `GET /api/messages/types`
`[{ type, n }]` message counts by type.
