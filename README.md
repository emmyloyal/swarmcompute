# SwarmCompute

An autonomous GPU marketplace where AI buyer agents team up into one order, sellers compete for it in a sealed-bid auction, and every buyer in the group pays the same fair price, held in on-chain escrow until delivery is verified.

> This is a demo running on NEAR Testnet. Agents, GPU delivery and verification are simulated. See [What is real and what is simulated](#what-is-real-and-what-is-simulated) before drawing conclusions.

## The problem

AI agents increasingly need to buy compute on their own, without a human negotiating each purchase. The GPU market makes that hard.

**Small buyers have no bargaining power.** An agent that needs a few GPU-hours pays whatever it is quoted, while larger orders attract competing offers.

**Pricing is opaque.** Without a competitive process, buyers can't tell whether a quoted price is fair, and sellers have little reason to sharpen their offers.

**Strangers can't trust each other.** Buyer and seller agents have no shared history. If the buyer pays first, it risks paying for compute that never arrives. If the seller delivers first, it risks never being paid.

**Reputation doesn't carry over.** Even when a seller performs well, there is rarely a shared, durable record that the next buyer can check.

## How SwarmCompute addresses it

**Buyer coalitions make small buyers worth competing for.** Buyer agents with compatible needs (same GPU, enough VRAM, compatible deadlines) group into one larger order that sellers bid on. Each coalition is kept small enough that at least two sellers can fill it, so the auction always has competition. A buyer whose maximum price is below the going market rate is left out rather than added, because one low maximum would lower the whole group's ceiling and could leave no eligible bid.

**Sealed-bid reverse auctions set the price.** Each seller first commits to a hidden bid, then reveals it, so no seller can see the others' bids and undercut them at the last second. The lowest eligible bid wins.

**One fair price for every member.** The winning bid becomes the coalition's *clearing price*. Every member pays `its hours × the clearing price`, the same rate as everyone else and never more than its own maximum. Before bidding, each buyer prepays its own maximum from its own wallet. Whatever it paid above the clearing price is credited back to it when the auction closes and then sent to its wallet.

**On-chain escrow holds the money until delivery is verified.** The seller is paid only after delivery is verified. If delivery fails, or a deadline passes, each buyer gets its money back in its own wallet. The contract also guarantees money can only go to the awarded seller or back to the buyer who paid it, and never twice.

**On-chain reputation keeps a track record.** Each auction win, completed delivery, failed delivery and unrevealed bid updates the seller's reputation on-chain. Anyone can check it, and the contract uses it to break ties between equal bids. It doesn't otherwise affect which bid wins.

## How a purchase flows

1. Buyer agents post their needs, and a coalition forms (deterministically, from a seed).
2. Each member prepays **hours × its own maximum price** into escrow, from its own wallet.
3. Seller agents commit sealed bids, then reveal them; the contract checks every reveal against its commitment.
4. The lowest eligible bid wins. Every member owes **hours × that clearing price**. The rest of its prepayment is credited back when the auction closes, then sent to its wallet.
5. GPU delivery happens and is verified (both simulated in this demo).
6. On success, escrow pays the seller. On failure (including partial delivery), each member gets its payment back. Reputation is updated by the contract.

Example from a real testnet run: seven buyers whose own maximums ranged from 0.000867 to 0.001868 NEAR per GPU-hour all paid 0.000658 NEAR per hour, the lowest of two sealed bids. The buyer with the highest maximum prepaid 0.0168 NEAR, paid 0.0059 and got 0.0109 back.

## What is real and what is simulated

SwarmCompute is a demonstration, and it is **not** a trustless system. To be specific:

- The 20 buyer agents are **simulated**, but each has a **real testnet wallet** that prepays and receives its returned balance. The backend holds those wallets' keys.
- One designated demo wallet tops up the buyer wallets when the demo is set up.
- Seller agents are **simulated**; their payout accounts are **real** testnet accounts.
- GPU provisioning, delivery and delivery verification are **simulated**.
- Prepayments, escrow, the clearing-price settlement, payouts, refunds, returned balances and reputation execute on **NEAR Testnet**.
- Seller pricing is **simulated**: each seller picks a price from its strategy and private minimum, and the price does not depend on order size. Savings in this demo come from sellers competing in the auction, not from volume discounts. The demo reports savings against each buyer's own maximum price, not against what that buyer would have paid buying alone.
- Commit-reveal bidding is **not** confidential from the backend operator, which generates every bid.
- The operator controls the agents and the verifier, so a dishonest operator could falsely verify a delivery. See [SECURITY.md](SECURITY.md) for exactly what the contract does and doesn't guarantee.

## Repository

| Path | What |
|---|---|
| [contracts/marketplace](contracts/marketplace/) | Rust escrow and auction contract (`near-sdk` 5.30.1) |
| [contracts/marketplace-testnet-tests](contracts/marketplace-testnet-tests/) | Real-chain tests on NEAR Testnet |
| [packages/shared](packages/shared/) | Money arithmetic, IDs, bid commitments, signed agent messages |
| [apps/backend](apps/backend/) | Agents, coalition engine, auction and settlement engines, chain sync, read-only API |
| [apps/frontend](apps/frontend/) | Web UI (React + Vite) |

Docs: [ARCHITECTURE.md](ARCHITECTURE.md) · [RULES.md](RULES.md) · [SECURITY.md](SECURITY.md) · [API.md](API.md) · [DEPLOYMENT.md](DEPLOYMENT.md) · [DEMO.md](DEMO.md)

## Getting started

### Prerequisites

- Node.js ≥ 20 with pnpm 9
- PostgreSQL 15+ (native install, or Docker via `pnpm db:up`)
- Rust (stable) with the `wasm32-unknown-unknown` target and `cargo-near` 0.23
- Windows only: the Visual Studio "Desktop development with C++" workload (MSVC linker and Windows SDK)

### Install and test

```sh
pnpm install
cp .env.example .env      # then fill in the secrets; never commit .env
pnpm db:migrate
pnpm test                                   # 117 TypeScript tests
cd contracts/marketplace && cargo test      # 23 contract unit tests
```

### Run the demo on testnet

```sh
cd contracts/marketplace && cargo near build non-reproducible-wasm --no-abi && cd ../..
pnpm --filter @swarmcompute/backend testnet:setup   # dev account, contract, seller + buyer wallets → .env
pnpm --filter @swarmcompute/backend demo:run        # the full flow, one forced delivery failure
pnpm --filter @swarmcompute/backend api:start       # read-only API on :4000
pnpm --filter @swarmcompute/frontend dev            # UI on http://localhost:5173
```

[DEPLOYMENT.md](DEPLOYMENT.md) has the details, and [DEMO.md](DEMO.md) has a walkthrough for presenting it.
