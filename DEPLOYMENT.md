# Deployment (NEAR Testnet)

This sets SwarmCompute up from scratch on one machine: local Postgres, a contract on NEAR Testnet, the backend, and the UI. Everything is testnet-only (RULES.md R1).

## 1. Prerequisites

- Node.js ≥ 20, pnpm 9
- PostgreSQL 15+ (native install), or Docker with `pnpm db:up`
- Rust stable, plus `rustup target add wasm32-unknown-unknown`
- `cargo-near` 0.23.0. The official release binaries are fastest, with a checksum per platform: <https://github.com/near/cargo-near/releases/tag/cargo-near-v0.23.0>
- Windows: the Visual Studio "Desktop development with C++" workload (MSVC linker + Windows SDK). `.cargo/config.toml` sets `AWS_LC_SYS_PREBUILT_NASM=1`, so NASM isn't needed.

## 2. Configure

```sh
pnpm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → AGENT_HMAC_MASTER_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → BID_ENCRYPTION_KEY
```

### Database

Create the database user once. On a native install, run this as the `postgres` superuser:

```sql
CREATE ROLE swarm LOGIN PASSWORD 'swarm_dev_only';
CREATE DATABASE swarmcompute OWNER swarm;
```

Then run `pnpm db:migrate`. Migrations are forward-only and checksummed: an applied file must never be edited.

## 3. Build and deploy the contract

```sh
cd contracts/marketplace
cargo test                                     # 23 unit tests
cargo near build non-reproducible-wasm --no-abi
cd ../..
pnpm --filter @swarmcompute/backend testnet:setup          # add -- --force to replace an existing deployment
```

`--no-abi` is needed on Windows, where generating the ABI fails to link. The ABI is optional metadata.

`testnet:setup` does five things:
1. Creates a dev account through the testnet helper. The faucet funds it with 10 NEAR.
2. Creates `market.<dev>`, then funds it, deploys the wasm and calls `new(owner, operator, verifier)`, all in **one** transaction.
3. Creates the 5 real seller payout accounts, `seller1..5.<dev>`.
4. Creates the 20 buyer wallets, `buyer001..020.<dev>`, each topped up with that buyer's budget plus 0.03 NEAR for gas.
5. Writes the account IDs and the key into `.env`. It never prints the key.

To use your own funded account instead, fill in the `*_ACCOUNT_ID` and `*_PRIVATE_KEY` values by hand, and deploy with `cargo near deploy` or near-cli.

## 4. Run

```sh
pnpm --filter @swarmcompute/backend demo:run      # the full flow on testnet; prints the fairness table and transaction links
pnpm --filter @swarmcompute/backend sync:run      # index events, confirm messages, reconcile (safe to repeat)
pnpm --filter @swarmcompute/backend settle:run    # settle or refund anything still holding money (safe to repeat)
pnpm --filter @swarmcompute/backend api:start     # read-only API on :4000
pnpm --filter @swarmcompute/frontend dev          # UI on :5173 (proxies /api to :4000)
```

To serve the UI as static files, run `pnpm --filter @swarmcompute/frontend build`, then serve `apps/frontend/dist` and route `/api` to the backend.

## 5. Real-chain contract tests

```sh
cd contracts/marketplace-testnet-tests
cargo test -- --ignored --nocapture
```

These deploy a fresh contract and spend about 9 testnet NEAR from a helper-created dev account, or from `NEAR_TEST_ACCOUNT_ID` / `NEAR_TEST_PRIVATE_KEY`. Every transaction hash is written to `target/testnet-report.md`. The NEAR local sandbox has no Windows build, which is why these run on testnet.

## Operational notes

- **Rate limits:** the free FastNEAR RPC rate-limits reads. Read calls back off and retry; transactions are never re-sent automatically.
- **Leftover purchases:** if a run is interrupted, `settle:run` closes or expires every purchase past its deadline. Each buyer's money then goes back to its own wallet.
- **Database rebuild:** the database is a cache. To rebuild it for a new contract, truncate the tables and run the flow again. The contract stays the source of truth.
