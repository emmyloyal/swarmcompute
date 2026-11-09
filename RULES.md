# SwarmCompute — Engineering Rules

These rules are binding for every change to this repository. R1–R7 restate the non-negotiable rules of the project specification (`SWARMCOMPUTE_PROMPT.md`, Section 3), in the same order. R8 onward are the conventions that follow from them. Code comments cite rules by number (e.g. `RULES.md R3`).

If a rule can't be met (for example a NEAR tool or RPC feature behaves differently than expected), stop. Document the problem and propose an alternative. Do not work around it silently.

**Revision 2 (2026-11-09): real user agents.** The market no longer ships simulated buyers or sellers. Real people open buying and selling agents from their own NEAR wallets. Each agent is its own on-chain account with its own key (R19–R25). Rules R8, R11, R12, R13, R14 and R16 were rewritten for this model. Rule numbers are unchanged so existing code citations stay valid.

---

## Non-negotiable (spec Section 3)

**R1 — NEAR Testnet only.** Nothing in this repo may target mainnet. The backend config rejects any non-testnet network, RPC URL, explorer URL or account ID at startup (`apps/backend/src/config/env.ts`). The setup and deploy scripts also check the RPC's reported `chain_id` at runtime.

**R2 — Nothing fabricated.** No invented transaction hashes, balances, confirmations, users, agents or bids. If an RPC call fails, store and show the failure. A `blockchain_transactions` row reflects the real RPC outcome. An on-chain message becomes `CONFIRMED` only after its tx hash is verified via RPC. Every agent shown in the UI exists on chain and was opened by a real wallet.

**R3 — No floating point for money.** Amounts are yoctoNEAR:

| Layer | Representation |
|---|---|
| Rust contract | `u128` (`U128` / `NearToken` at the JSON boundary) |
| TypeScript | `bigint` in memory; canonical decimal string on the wire |
| PostgreSQL | `NUMERIC(40,0)` via the `yocto` domain |
| JSON (messages, events, API) | decimal string, never a JSON number |

Use the `@swarmcompute/shared` helpers (`parseYocto`, `mulPriceHours`, `sumYocto`, `nearToYocto`). Display conversion (`yoctoToNear`) is exact, with no rounding. Probabilities and other ratios are integer basis points.

**R4 — No payout before verification.** A seller payout can only follow a successful verification, and the contract enforces this (`VERIFYING → COMPLETED`). No backend code path may bypass it.

**R5 — No LLM moves money.** An LLM may write explanations or proposals. Every transfer, approval, allocation, bid and verification is decided by deterministic code and checked by the contract. LLM output is never parsed into a financial action.

**R6 — No committed secrets.** Private keys and seed phrases live only in the backend environment (`.env` and the agent keystore, both git-ignored). Nothing secret uses the `VITE_` prefix or reaches the frontend bundle. Config errors never echo values.

**R7 — No placeholder core behaviour.** No core functionality is left as a TODO, and no frontend animation stands in for backend behaviour.

## Funds safety

**R8 — Key separation by role.** Each agent account's own key signs that agent's actions, and nothing else does:
- a buyer agent's key alone reserves its budget for a purchase (`prepay`);
- a seller agent's key alone commits and reveals its bids.

Only the Verification Agent calls `verify`, with the verifier key. The operator key opens rounds and forms coalitions (R22). It can't prepay, bid, or move money anywhere. The owner key is used only by deployment scripts, never by the running backend.

**R9 — Exact amounts, one fair price.** A prepayment reserves exactly `hours × the buyer's own max price` from the agent's deposited balance. At award, every member owes `hours × the clearing price` (the lowest eligible bid). That is the same rate for every member and never above anyone's own max. Escrow then holds exactly the sum owed, and `prepaid − owed` goes back to each buyer agent's available balance. Over- and under-reservation both fail.

**R10 — Idempotent settlement.** Payouts and withdrawals are guarded by in-flight markers and final states, both on-chain and in the DB. A retry after a failed callback is allowed; a second success is impossible.

**R11 — Funds go only to the awarded seller's owner or back to the buyer's owner.** A payout goes to the winning seller agent's **owner wallet**. Excess, refunds and withdrawals go to the buyer agent's **owner wallet**. Owners are fixed when the agent is opened. No other destination exists in the contract. An agent key can trigger a withdrawal, but it can't change where the money goes.

## Honesty and confidentiality

**R12 — Real vs simulated stays labelled.**
- **Real:** users, wallets, agent accounts and keys, deposits, coalitions, bids, escrow, clearing price, payouts, refunds and reputation.
- **Simulated:** GPU delivery and its verification, and only those. They stay labelled `is_simulated` / "Simulated delivery" in every UI element, API response and log line.

The system is never described as trustless.

**R13 — Unrevealed bids never leave the backend.** Seller agents run in the agent host, which computes each bid from its owner's terms (R24). Unrevealed prices and nonces are stored only as AES-256-GCM ciphertext (`bid_commitments.*_ciphertext`). They are wiped after a confirmed reveal and never returned by the API: the API reads `public_*` views only. `BID_COMMITMENT` payloads are strict and reject any `price`/`nonce` field. Commit-reveal hides bids from other sellers, but **not** from the operator of the agent host, and docs and UI must say so.

## Messages and data

**R14 — Agents act only through signed transactions.** Every agent action (prepay, commit, reveal, withdraw) is a NEAR transaction signed with that agent's own key, and the contract checks it. There is no off-chain channel between agents. The host records every transaction it sends (`blockchain_transactions`) and why (`host_activity`).

**R15 — The contract is authoritative.** The database is a cache and an index. Agents, their terms and all financial history come from indexed contract events, not from backend bookkeeping. The reconciler flags drift instead of overwriting chain facts.

**R16 — Determinism.** Coalition formation and seller bid pricing are deterministic functions of on-chain agent terms and round state. The same inputs produce the same output. Never use `Math.random()` in market logic. Bid nonces come from a CSPRNG and are the only randomness.

## Agents and accounts

**R19 — One agent, one account, one key.** Opening an agent creates the sub-account `<name>.<marketplace contract>` (for example `alice-gpu.market.swarm-….testnet`). The account gets one **function-call access key** that may call only the marketplace contract, and only the agent methods (`prepay`, `commit_bid`, `reveal_bid`, `withdraw`). Agent keys are never full-access keys. The agent host generates the key pair. The private key never leaves the agent host's keystore, and only the public key reaches the browser and the chain.

**R20 — Owners open agents from their own wallet.** A user connects a NEAR wallet and calls `open_agent` themselves. That wallet becomes the agent's **owner**. Only the owner can:
- change the agent's terms;
- deposit to it;
- pause or close it.

Each agent is either a **buyer** or a **seller**, and a wallet can own any number of each. There are no preset profiles: the owner sets every term.

**R21 — Agent money lives in the contract.** A buyer's budget is deposited into the contract against its agent, from the owner's wallet. The agent reserves from that balance when it prepays (no attached deposit, so a function-call key is enough). The contract tracks, per agent:
- `available` — free to reserve or withdraw;
- `reserved` — in live purchases;
- `spent` — paid to sellers.

Withdrawals always go to the owner (R11).

Opening an agent costs the owner 0.0001 NEAR. The contract **sponsors** the rest: a 0.1 NEAR gas fund sent to the new agent account, plus its storage. Sponsorship comes only from the contract's free balance (its sponsor pool, topped up by sending NEAR to the contract), never from escrow, buyers' balances or budgets in flight; when the pool runs dry, opening fails instead. Each wallet may open at most 5 agents, so cheap opens can't drain the pool.

**R22 — The coordinator can only group what agents asked for.** A buyer agent's request (GPU model, minimum VRAM, hours, max price per hour, deadline) is stored on chain with the agent. The operator forms coalitions off-chain, and `register_coalition` checks every member's hours and max price against that agent's stored request. The operator can't invent members, change terms, or add an agent whose request is closed.

**R23 — Sellers bid only through their own account.** A seller agent's offers (GPU model, VRAM, capacity hours) and minimum price per hour are stored on chain. `commit_bid` and `reveal_bid` must be signed by that seller agent's account, and the contract rejects a revealed price below the seller's own stored minimum.

**R24 — Agents act on their owner's terms only.** The agent host runs every agent. It acts only within the terms its owner stored on chain:
- a buyer agent prepays only purchases its request matches;
- a seller agent bids only on purchases its offers can fill, at or above its minimum price, using the pricing strategy its owner picked.

The host never acts on terms that aren't on chain.

**R25 — The market can be empty, and the UI says so.** The project supplies no liquidity: every agent is opened by a real user. With no seller agents that can fill a request, nothing happens. The request waits until its deadline, and its reserved money (if any) goes back to its owner. The UI shows "waiting for sellers" rather than inventing activity (R2).

## Process

**R17 — Phased delivery.** Work proceeds in phases. After each phase: report files changed, functionality, tests run with results, known issues and the next milestone. Then wait for confirmation.

**R18 — Tests accompany behaviour.** Every money path, state transition and validation rule gets a test, including the failure cases.
