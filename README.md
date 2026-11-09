# SwarmCompute

## The problem

AI agents increasingly need to buy compute on their own, without a human negotiating each purchase. The GPU market makes that hard.

**Small buyers have no bargaining power.** An agent that needs a few GPU-hours pays whatever it is quoted, while larger orders attract competing offers.

**Pricing is opaque.** Without a competitive process, buyers can't tell whether a quoted price is fair, and sellers have little reason to sharpen their offers.

**Strangers can't trust each other.** Buyer and seller agents have no shared history. If the buyer pays first, it risks paying for compute that never arrives. If the seller delivers first, it risks never being paid.

**Reputation doesn't carry over.** Even when a seller performs well, there is rarely a shared, durable record that the next buyer can check.

## The solution

SwarmCompute is a GPU marketplace on NEAR Testnet where anyone can open a **buying agent** or a **selling agent**. Buying agents with the same GPU needs team up into one order. Selling agents compete for it in a sealed-bid auction. Every buyer in the group pays the same fair price, held in on-chain escrow until delivery is verified.

Every agent is its own NEAR account with its own key, opened from its owner's wallet. There are no simulated buyers or sellers. If no seller can serve a request, nothing happens until one can.

> This runs on NEAR Testnet. GPU delivery and its verification are simulated; everything else is real. See [What is real and what is simulated](#what-is-real-and-what-is-simulated).

**Real agents, each its own on-chain account.** Opening an agent creates the account `<name>.<marketplace contract>`. It gets exactly one key: a function-call key that can only call the marketplace's agent actions (prepay, bid, reveal, withdraw). That key can't transfer NEAR or touch anything else. The wallet that opened the agent is its owner, and every refund, leftover and seller payout can only go back to that wallet.

**Buyer coalitions make small buyers worth competing for.** Buying agents that want the same GPU model are grouped into one larger order. The coalition takes the strictest member's VRAM requirement. Each member's hours and maximum price come from its own request stored on chain, so the coordinator can group agents but can't change anyone's terms. A round only starts if at least one seller's own terms would let it bid.

**Sealed-bid reverse auctions set the price.** Each selling agent commits to a hidden bid with its own key, then reveals it. No seller can see the others' bids and undercut them at the last second. The contract rejects any reveal below that seller's own minimum price. The lowest eligible bid wins.

**One fair price for every member.** The winning bid becomes the coalition's *clearing price*. Every member pays `its hours × the clearing price`: the same rate for everyone, never more than its own maximum. Each member first reserves `hours × its own maximum` from its budget; whatever it reserved above the clearing price goes straight back to its balance.

**On-chain escrow holds the money until delivery is verified.** The winning seller's owner is paid only after delivery is verified. If delivery fails or a deadline passes, every member gets its money back. Anyone can trigger an expiry, so money can't get stuck.

**On-chain reputation keeps a track record.** Wins, completed and failed deliveries, and unrevealed bids are recorded by the contract. Reputation breaks ties between equal bids.

## Using it

1. **Connect a NEAR Testnet wallet**: Meteor or MyNearWallet.
2. **Open an agent** and set its terms:
   - **Buying agent:** GPU model, minimum VRAM, GPU-hours, maximum price per hour, deadline, and a budget to deposit.
   - **Selling agent:** up to four GPU offers (model, VRAM, capacity in hours), a minimum price, and a strategy: bid my minimum, or bid a percentage below the coalition's price ceiling (never below my minimum).
3. **Your agent acts on its own.** The market host groups buyers, buying agents prepay, selling agents commit and reveal their bids, and the round settles. You watch it live: rounds, sealed and revealed bids, the clearing price, and why a request is still waiting.
4. **Manage it from your wallet.** Deposit more, withdraw to your wallet, change or close a request, leave a round before it's funded. As a seller: change prices, strategy or capacity, or pause bidding.

**Cost to open an agent: 0.0001 NEAR**, plus a buyer's budget, which can be withdrawn whenever it isn't reserved in a round. The contract sponsors the rest: a 0.1 NEAR gas fund sent to the new agent's account, plus its storage. Sponsorship comes only from the contract's own free balance (topped up by sending NEAR to the contract), never from escrow or buyers' money. Each wallet can open up to 5 agents.

## How a round flows

1. Buying agents with open requests for the same GPU are grouped into a coalition, if some seller's terms let it bid.
2. Each buying agent reserves `hours × its own maximum` from its budget, signed with its own key.
3. Selling agents that can serve the order commit sealed bids, then reveal them, each signed with its own key. The contract checks every reveal against its commitment and the seller's minimum.
4. The lowest eligible bid wins. Every member owes `hours × that clearing price`, and the rest of its reservation returns to its balance.
5. GPU delivery happens and is verified (both simulated).
6. On success, escrow pays the winning seller's owner. On failure, every member gets its money back and its request stays open for another round.

Example from a testnet run: two buying agents (10 hours at most 0.003 NEAR/h, and 20 hours at most 0.002 NEAR/h) formed one A100 coalition. Two selling agents bid 0.0018 and 0.001 NEAR/h. Both buyers paid the clearing price of 0.001 NEAR/h, the winning seller's owner received exactly 30 h × 0.001 = 0.03 NEAR, and the buyers kept the difference from their own maximums.

## What is real and what is simulated

**Real, on NEAR Testnet:** the users and their wallets, every agent account and its key, deposits and budgets, coalitions, sealed bids and reveals, escrow, the clearing-price settlement, payouts, refunds, withdrawals and reputation.

**Simulated:** GPU provisioning, delivery and its verification. No real compute runs; the UI labels those steps "Simulated".

**Trust assumptions, stated plainly.** SwarmCompute is not trustless:

- The **market host** holds each agent's key (encrypted at rest) so agents can act while their owners are offline. It can therefore see a seller's sealed bid before the reveal. Commit-reveal hides bids from other sellers, not from the host operator.
- The **operator** forms coalitions and runs the simulated delivery steps; the **verifier** confirms delivery. A dishonest verifier could falsely verify a delivery.
- What the contract guarantees regardless: money only ever goes to the winning seller's owner or back to the buyer's owner, never twice; no member pays above its own maximum; agent keys can't move money elsewhere; and anyone can expire a stalled round to get the money back.

## Repository

| Path | What |
|---|---|
| [contracts/marketplace](contracts/marketplace/) | Rust contract (`near-sdk` 5.30.1): agent accounts, coalitions, sealed-bid auction, escrow, sponsorship |
| [contracts/marketplace-testnet-tests](contracts/marketplace-testnet-tests/) | Real-chain tests on NEAR Testnet: agent accounts and key permissions, own-key signing, full rounds |
| [apps/backend](apps/backend/) | Market host: agent keystore, coordinator loop, event indexer, HTTP API |
| [apps/frontend](apps/frontend/) | Web app (React + Vite): open and manage agents, live market |
| [packages/shared](packages/shared/) | Money arithmetic, IDs, bid commitments |

The engineering rules every change follows are in [RULES.md](RULES.md).

## Getting started

### Prerequisites

- Node.js ≥ 20 with pnpm 9
- PostgreSQL 15+ (native install, or Docker via `pnpm db:up`)
- Rust (stable) with the `wasm32-unknown-unknown` target and `cargo-near` 0.23
- Windows only: the Visual Studio "Desktop development with C++" workload (MSVC linker and Windows SDK)

### Install and test

```sh
pnpm install
cp .env.example .env                        # DATABASE_URL at least; never commit .env
pnpm test                                   # backend + shared TypeScript tests
cd contracts/marketplace && cargo test      # contract unit tests
```

### Run it on testnet

```sh
cd contracts/marketplace && cargo near build non-reproducible-wasm --no-abi && cd ../..
pnpm --filter @swarmcompute/backend testnet:setup   # deploys the contract, writes roles and keys to .env
pnpm --filter @swarmcompute/backend start           # market host + API on :4000 (applies migrations)
pnpm --filter @swarmcompute/frontend dev            # web app on http://localhost:5173
```

Then open http://localhost:5173, connect a testnet wallet, and open an agent. To watch a full round without a browser wallet, `pnpm --filter @swarmcompute/backend testnet:smoke` creates four testnet wallets that open two buying and two selling agents, then waits for the round to complete.

A deployed frontend points at a hosted market host with `VITE_BACKEND_URL`.
