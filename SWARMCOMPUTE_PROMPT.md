# SwarmCompute — Master Development Prompt (v2, consolidated)

This version merges the original specification with the Critical Architecture Corrections. Where anything here conflicts with an earlier version, this document wins.

---

## 1. Role and objective

Act as a senior blockchain engineer, AI systems architect, full-stack developer and smart contract security engineer.

Build **SwarmCompute**, an autonomous GPU marketplace demo in which simulated AI buyer agents form purchasing coalitions, simulated seller agents compete in a commit-reveal sealed-bid reverse auction, and escrow, accounting and settlement execute on **NEAR Testnet**.

Build the complete application: smart contract, backend, agent engine, database, frontend, tests, documentation and deployment configuration. Work in phases (Section 17) and stop to report after each phase.

---

## 2. What is real and what is simulated

This table is authoritative. Every page of the UI, every API response and the README must stay consistent with it.

| Component | Status |
|---|---|
| 20 buyer agents | Simulated identities, controlled by the backend |
| Buyer contribution approvals | Simulated decisions, recorded by the backend; **not** wallet signatures |
| 5 seller agents | Simulated, controlled by the backend |
| GPU provisioning and delivery | Simulated |
| Delivery verification | Simulated (Verification Agent in the backend) |
| Funding wallet | **Real** — one designated demo NEAR Testnet account |
| Marketplace contract | **Real** — deployed on NEAR Testnet |
| Agent / coalition / auction registration | **Real** on-chain records |
| Bid commitments and reveals | **Real** on-chain records, submitted by the operator account |
| Escrow deposits, per-buyer allocations | **Real** on-chain state |
| Seller payouts and refunds | **Real** NEAR transfers |
| Reputation records | **Real** on-chain records |

Seller payout destinations: each of the 5 simulated sellers is mapped to a real testnet account (sub-accounts of the operator, e.g. `seller1.<operator>.testnet`) so payouts are real, visible transfers. Seller *behaviour* remains simulated.

Never describe the MVP as trustless or as deployed decentralized infrastructure. The backend operator controls all agents and the verifier role; the contract constrains what that operator can do with funds.

---

## 3. Non-negotiable rules

- NEAR Testnet only. Never mainnet.
- No fake transaction hashes, fabricated balances or invented confirmations. If an RPC call fails, show the failure.
- No floating-point arithmetic for money anywhere (contract, backend, DB). Use yoctoNEAR as `u128` in Rust and as decimal strings / `NUMERIC(40,0)` / `BigInt` elsewhere.
- Payment is **never** released before successful delivery verification.
- No LLM may authorize or trigger a financial transfer. LLMs may produce explanations or proposals; all money movement is gated by deterministic code and contract checks.
- Never commit private keys or seed phrases. Keys live only in the backend environment.
- No core functionality left as TODOs. No frontend animation standing in for backend behaviour.

---

## 4. Participants

### Buyers (20, simulated)
Each has: agent ID, buyer ID, GPU model (A100 or H100), minimum VRAM, required hours, max budget (yocto), max price per hour (yocto), delivery deadline preference, coalition membership, allocation history.

Buyer IDs are opaque strings (e.g. `buyer-001`) registered on-chain. The contract stores an optional `wallet: Option<AccountId>` per buyer, always `None` in the MVP, so independent buyer wallets can be added later without a migration of the accounting model.

### Sellers (5, simulated)
Each has: seller ID, payout account, GPU model, VRAM, capacity in hours, minimum acceptable price per hour, delivery time, pricing strategy, reputation, auction history.

Pricing strategies (one per seller): aggressive low-price, premium high-reliability, limited capacity, flexible, randomized competitive. Each strategy also has a configured delivery failure probability so the demo exercises refunds.

---

## 5. Coalition formation

The Coalition Formation Agent groups buyers deterministically. Same inputs and seed must produce the same coalitions.

Hard compatibility constraints (never violated): same GPU model; buyer's minimum VRAM satisfied by the coalition's VRAM spec; delivery deadlines compatible; coalition total hours within at least one seller's capacity.

Optimization: prefer groupings that maximize the number of buyers who can be served at a price at or below their own max price per hour, not simply the largest coalitions. A coalition's effective price ceiling is the **lowest** max price per hour among its members, so one low-ceiling buyer can disqualify all bids. The engine must account for this and may exclude such a buyer rather than sink the coalition.

Rules:
- Every coalition gets a unique ID and is registered on-chain with its member list and per-member hours.
- Each member's contribution = `hours_i × winning_price_per_hour` (integer yocto). No rounding is needed because price is per hour and hours are integers.
- A buyer may leave any time before FUNDED. Leaving re-validates the coalition; if it drops below its minimum, the coalition fails.
- Failed coalitions hold no funds (they fail before FUNDED, or are refunded).

---

## 6. Agents

Buyer Agents, Coalition Formation Agent, Seller Agents, Auction Coordinator, Verification Agent, Reputation Agent and Treasury/Settlement Agent, with responsibilities as in the original spec. Additions:

- **Buyer Agents** approve or reject their contribution after the auction result. Approval is a simulated decision: the agent approves only if `contribution ≤ remaining budget` and `winning price ≤ own max price`. The approval is logged as simulated and the on-chain allocation is recorded by the operator.
- **Treasury Agent** is the only component that signs funding and settlement transactions, using the demo account key from the environment.
- **Verification Agent** is the only component that may call the contract's verification method, using the verifier key.

Agents communicate through structured, validated messages (Section 11), not free text.

---

## 7. Auction

Sealed-bid reverse auction with commit-reveal. Lowest eligible revealed bid wins.

**Commitment:** `sha256(auction_id || seller_id || price_per_hour_yocto || nonce)` with a 32-byte random nonce, fields length-prefixed or delimited unambiguously. Including `auction_id` and `seller_id` prevents a commitment from being replayed in another auction or by another seller.

**Phases (enforced by on-chain deadlines using `env::block_timestamp()`):**
1. Commit phase: each registered seller may submit exactly one commitment before `commit_deadline`. Commitments are immutable.
2. Reveal phase: between `commit_deadline` and `reveal_deadline`, sellers reveal `(price, nonce)`. The contract recomputes the hash and rejects mismatches.
3. Close: after `reveal_deadline`, anyone (in practice the operator) calls `close_auction`.

**Eligibility:** revealed, hash verified, GPU model and VRAM match, capacity ≥ required hours, `price_per_hour ≤ coalition price ceiling`, `price × hours ≤ coalition total budget`.

**Non-reveal:** the seller is excluded from the auction and receives a reputation penalty.

**Tie-break:** lowest price, then higher reputation, then earliest commitment block height, then lexicographically smallest seller ID.

**No eligible bids:** state → FAILED. No funds were deposited, so nothing is refunded.

**Confidentiality disclosure (must appear in README and auction UI):** commit-reveal keeps bids hidden from other seller agents and from the public until reveal. Because the backend generates every seller's bid and nonce, it does **not** keep bids hidden from the backend operator. Unrevealed bids and nonces must never be exposed by the public API or frontend.

---

## 8. Smart contract

One Rust contract, `marketplace`, using the current official `near-sdk` (verify version against NEAR docs before starting), built with `cargo near`.

### Roles
- `owner`: can rotate the other roles and pause the contract.
- `operator`: registers agents, coalitions, auctions; submits commitments and reveals on behalf of simulated sellers; records allocations.
- `funder`: the designated demo account; the only account allowed to deposit escrow in the MVP.
- `verifier`: the only account allowed to submit verification results.

Roles may be the same account in the demo, but are separate fields so they can be split.

### Escrow state machine (per coalition purchase)

```
CREATED ──open_bidding──▶ BIDDING ──close_auction (winner)──▶ AWARDED
                            │                                   │
                            └─ close_auction (no winner) ─▶ FAILED
AWARDED ──fund (full amount)──▶ FUNDED
AWARDED ──funding deadline passed──▶ EXPIRED
FUNDED ──start_delivery──▶ DELIVERING
DELIVERING ──submit_delivery_report──▶ VERIFYING
DELIVERING ──delivery deadline passed──▶ EXPIRED
VERIFYING ──verify(success) + payout callback ok──▶ COMPLETED
VERIFYING ──verify(fail)──▶ FAILED
VERIFYING ──verification deadline passed──▶ EXPIRED
FAILED or EXPIRED, if funds held ──refund + callback ok──▶ REFUNDED
```

Every method asserts the current state, the caller's role and the relevant deadline. Any transition not drawn above panics. Deadline-based expiry can be triggered by anyone via `expire(id)`, so a stalled operator cannot trap funds.

### Partial delivery
MVP policy: partial delivery is treated as failed delivery and results in a full refund. Document this. Pro-rata settlement is a future feature.

### Funding and allocations
- Before funding, the operator records per-buyer allocations: `(buyer_id, amount_yocto)`. The contract checks each allocation against that buyer's registered budget minus amounts already allocated in other active purchases, and checks that allocations sum exactly to `winning_price × total_hours`.
- `fund(purchase_id)` is `#[payable]`, callable only by `funder`, and requires `attached_deposit == required_total` exactly. Over- or under-payment panics (and the deposit is returned by the failed transaction).
- Storage: registration and allocation methods require an attached deposit covering their storage, or the contract is pre-funded for storage by the owner. Escrowed funds and storage reserve are tracked separately; the contract must never pay out a purchase from another purchase's escrow or from its storage reserve. Maintain `total_escrowed` and assert `env::account_balance() - storage_cost ≥ total_escrowed` before any outgoing transfer.

### Payout and refund (async safety)
Pattern for both:
1. Assert state and role. Set a `payout_in_flight` / `refund_in_flight` flag and record the amount **before** creating the promise.
2. `Promise::new(receiver).transfer(amount)` chained to a private callback.
3. Callback checks `env::promise_result`. Success → final state (COMPLETED / REFUNDED), decrement `total_escrowed`, clear flag, emit event. Failure → clear flag, keep the prior state so the action can be retried.
4. A second call while a flag is set panics. This makes settlement idempotent and prevents double payment.

Refunds go to the `funder` account (the only real depositor). Per-buyer refund amounts are recorded in internal accounting and emitted as events so each simulated buyer's refund is auditable. Refund total can never exceed the purchase's deposited amount.

### Events
Emit NEP-297 JSON events for every registration, commitment, reveal, award, allocation, funding, delivery report, verification, payout, refund, expiry and reputation update. The backend indexes these events; it does not invent its own financial history.

### Reputation
Stored on-chain per seller: wins, completed deliveries, failed deliveries, non-reveals. Updated only by contract transitions (not by arbitrary operator calls), so reputation can't be edited independently of outcomes.

---

## 9. Simulated GPU infrastructure

A100 and H100 profiles, varied VRAM, capacity, pricing and delivery times. Outcomes: success, failure, partial (treated as failure per Section 8). The simulator produces a delivery report (allocated hours, timestamps, a hash of a simulated job log). The report hash is submitted on-chain with `submit_delivery_report`.

Every simulated resource is labeled "Simulated" in the UI and API. Never imply real compute ran.

---

## 10. Settlement flow

1. Coalition formation (simulated) → coalition registered on-chain.
2. Auction creation on-chain (CREATED → BIDDING).
3. Bid commitments on-chain.
4. Bid reveals on-chain, verified by the contract.
5. Winner selection by `close_auction` (→ AWARDED or FAILED).
6. Simulated buyer approvals; operator records allocations on-chain.
7. Demo account deposits the exact total (→ FUNDED). Real transaction.
8. Simulated delivery (→ DELIVERING → VERIFYING on report).
9. Verification Agent submits result.
10. Success → payout to seller account (→ COMPLETED). Failure/timeout → refund to funder (→ FAILED/EXPIRED → REFUNDED).
11. Reputation updated by the contract transition.

---

## 11. Agent messages

Types: BUYER_REQUIREMENT, BUYER_DISCOVERY, COALITION_PROPOSAL, COALITION_ACCEPTANCE, COALITION_REJECTION, COALITION_LEAVE, SELLER_AVAILABILITY, AUCTION_REQUEST, BID_COMMITMENT, BID_REVEAL, AUCTION_RESULT, CONTRIBUTION_APPROVAL, FUNDING_CONFIRMATION, DELIVERY_REPORT, VERIFICATION_RESULT, SETTLEMENT_CONFIRMATION, REFUND_CONFIRMATION.

Each message: message ID (UUID), sender ID, receiver ID, type, timestamp, coalition/auction/purchase ID, payload (schema-validated, e.g. Zod or Pydantic), status, and an HMAC signature using a per-agent backend secret. Reject unknown types, invalid payloads, bad signatures and replayed message IDs. Log every message.

Messages that carry a real transaction reference must include the transaction hash; the backend verifies it via RPC before marking the message confirmed.

---

## 12. Frontend

Seven pages as in the original spec: Overview, Buyer Swarm, Seller Swarm, Coalition Explorer, Live Auctions, Blockchain Explorer, Agent Activity. Additional requirements:

- A persistent legend and per-item badges: **On-chain** (with explorer link) vs **Simulated**.
- Buyer Swarm shows approvals as "Simulated approval", never as a signature.
- Blockchain Explorer shows per-purchase state machine position, escrowed amount, per-buyer allocations and refunds, all read from contract views or indexed events.
- Live Auctions shows commitment existence and count before reveal, never prices.
- Wallet connection (NEAR Wallet Selector) is read-only for visitors; only the backend's funder key signs funding in the demo.
- Clean fintech design; avoid templated dashboard layouts.

---

## 13. Database

PostgreSQL with migrations. Tables: agents, buyers, sellers, gpu_resources, buyer_requirements, coalitions, coalition_members, auctions, bid_commitments, bid_reveals, allocations, purchases, settlements, refunds, deliveries, verification_records, reputation_records, agent_messages, blockchain_transactions, activity_logs.

All money columns `NUMERIC(40,0)` in yocto. Unrevealed nonces and prices are stored encrypted and excluded from every public query.

The database is a cache and an index. For any financial fact, the contract is authoritative; the backend reconciles DB state against contract views and flags drift.

---

## 14. Security

Input validation everywhere; role checks in the contract; message authentication and replay protection; exact-amount funding; idempotent, flag-guarded payouts and refunds; anyone-callable expiry; pause switch; keys only in backend env; no secrets in the frontend bundle; unrevealed bid data never leaves the backend.

Document the trust model in SECURITY.md: the operator controls agents and the verifier role, so a malicious operator could falsely verify delivery. The contract guarantees funds go only to the awarded seller or back to the funder, never elsewhere, and never twice.

---

## 15. Tests

**Contract (unit + `near-workspaces` sandbox):** registration, role checks, every valid transition, every invalid transition panics, commitment verification and mismatch rejection, non-reveal exclusion, tie-break order, exact funding, allocation limit enforcement, payout success, payout failure then retry, double payout rejected, refund success and failure, refund ceiling, deadline expiry by a third party, `total_escrowed` invariant.

**Agents:** creation, requirement parsing, compatibility, deterministic coalition output for a fixed seed, budget and price-ceiling validation, leave-before-funding.

**Integration:** 20 buyers → coalitions → 5 sellers → commit → reveal → award → allocations → real testnet funding → simulated delivery → verification → payout → reputation. Also run one forced-failure path ending in REFUNDED. Record the real transaction hashes in the test report.

---

## 16. Documentation

README.md, RULES.md, ARCHITECTURE.md, API.md, SECURITY.md, DEPLOYMENT.md, .env.example.

The README must state plainly, near the top:
- The 20 buyer agents are simulated identities.
- One designated demo wallet funds all purchases.
- Seller agents are simulated; their payout accounts are real testnet accounts.
- GPU provisioning, delivery and delivery verification are simulated.
- Escrow deposits, internal allocations, payouts, refunds and reputation execute on NEAR Testnet.
- Commit-reveal bidding is not confidential from the backend operator.
- This is not a trustless system; see SECURITY.md for the trust model.

Include a Mermaid sequence diagram of the Section 10 flow and a state diagram of Section 8.

---

## 17. Phases

1. Foundation: repo layout, env config, DB schema, message schemas, ARCHITECTURE.md, RULES.md.
2. Smart contract with full sandbox tests (do this early; everything depends on it).
3. Agent engine (buyers, sellers, messaging).
4. Coalition engine.
5. Auction engine wired to the contract.
6. Testnet deployment and backend integration (signing, confirmation, event indexing, reconciliation).
7. GPU simulation, verification, settlement, refunds.
8. Frontend.
9. Full integration runs on testnet, bug fixes, documentation, demo script.

After each phase report: files changed, functionality implemented, tests run and results, known issues, next milestone. Then **stop and wait for confirmation** before starting the next phase.

If any NEAR tool, RPC or SDK feature is unavailable or behaves differently from this spec, stop, explain, and propose a documented alternative. Never pretend a feature works.

---

## 18. Acceptance criteria

1. 20 simulated buyer agents and 5 simulated seller agents run.
2. Multiple coalitions form automatically and deterministically.
3. Per-buyer budgets are enforced on-chain.
4. Sellers commit and reveal; the contract verifies every reveal.
5. Lowest eligible bid wins with deterministic tie-breaks.
6. Real testnet funding, payout and refund transactions occur, with explorer links.
7. No payout occurs before successful verification.
8. A failed or expired delivery ends in a refund, never a payout.
9. Double payout and double refund are impossible.
10. Reputation updates from contract transitions.
11. The UI clearly separates on-chain from simulated.
12. The full workflow and a failure workflow pass integration tests on testnet.
