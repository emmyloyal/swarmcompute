# SwarmCompute — Engineering Rules

These rules are binding for every change to this repository. R1–R7 restate the non-negotiable rules of the project specification (`SWARMCOMPUTE_PROMPT.md`, Section 3), in the same order. R8 onward are the conventions that follow from them. Code comments cite rules by number (e.g. `RULES.md R3`).

If a rule can't be met (for example a NEAR tool or RPC feature behaves differently than expected), stop. Document the problem and propose an alternative. Do not work around it silently.

---

## Non-negotiable (spec Section 3)

**R1 — NEAR Testnet only.** Nothing in this repo may target mainnet. The backend config rejects any non-testnet network, RPC URL, explorer URL or account ID at startup (`apps/backend/src/config/env.ts`). Phase 6 also checks the RPC's reported `chain_id` at runtime.

**R2 — Nothing fabricated.** No invented transaction hashes, balances or confirmations. If an RPC call fails, store and show the failure. A `blockchain_transactions` row reflects the real RPC outcome. An on-chain message becomes `CONFIRMED` only after its tx hash is verified via RPC.

**R3 — No floating point for money.** Amounts are yoctoNEAR:

| Layer | Representation |
|---|---|
| Rust contract | `u128` (`U128` / `NearToken` at the JSON boundary) |
| TypeScript | `bigint` in memory; canonical decimal string on the wire |
| PostgreSQL | `NUMERIC(40,0)` via the `yocto` domain |
| JSON (messages, events, API) | decimal string, never a JSON number |

Use the `@swarmcompute/shared` helpers (`parseYocto`, `mulPriceHours`, `sumYocto`, `nearToYocto`). Display conversion (`yoctoToNear`) is exact, with no rounding. Probabilities and other ratios are integer basis points.

**R4 — No payout before verification.** A seller payout can only follow a successful verification, and the contract enforces this (`VERIFYING → COMPLETED`). No backend code path may bypass it.

**R5 — No LLM moves money.** An LLM may write explanations or proposals. Every transfer, approval, allocation and verification is decided by deterministic code and checked by the contract. LLM output is never parsed into a financial action.

**R6 — No committed secrets.** Private keys and seed phrases live only in the backend environment (`.env`, which is git-ignored). Nothing secret uses the `VITE_` prefix or reaches the frontend bundle. Config errors never echo values.

**R7 — No placeholder core behaviour.** No core functionality is left as a TODO, and no frontend animation stands in for backend behaviour.

## Funds safety

**R8 — Key separation by role.** Only a buyer's own wallet key signs that buyer's prepayment. Only the Verification Agent calls the contract's verification method, with the verifier key. The operator key does everything else, including triggering payouts and balance withdrawals, whose destinations are fixed on-chain. The owner key is used only by deployment scripts, never by the running backend.

**R9 — Exact amounts, one fair price.** A prepayment must equal `hours × the buyer's own max price` exactly. At award, every member owes `hours × the clearing price` (the lowest eligible bid), the same rate for all, never above anyone's own max. Escrow then holds exactly the sum owed, and `prepaid − owed` is credited back to each buyer. Over- and under-payment both fail.

**R10 — Idempotent settlement.** Payouts and balance withdrawals are guarded by in-flight markers and final states, both on-chain and in the DB. A retry after a failed callback is allowed; a second success is impossible.

**R11 — Funds go only to the awarded seller or back to the buyer who paid them.** Payouts go to the seller's registered payout account. Excess and refunds go to the buyer's registered wallet. No other destination exists in the contract.

## Honesty and confidentiality

**R12 — Real vs simulated stays labelled.** The table in Section 2 of the spec is authoritative. Every UI element, API response and log line that represents something simulated says so (`is_simulated`, `provenance = 'SIMULATED'`, "Simulated approval"). Buyer approvals are never shown as signatures. The system is never described as trustless.

**R13 — Unrevealed bids never leave the backend.** Unrevealed prices and nonces are stored only as AES-256-GCM ciphertext (`bid_commitments.*_ciphertext`). They are wiped after a confirmed reveal and never returned by the API: the API reads `public_*` views only. `BID_COMMITMENT` payloads are strict and reject any `price`/`nonce` field. Commit-reveal does **not** hide bids from the backend operator, and docs and UI must say so.

## Messages and data

**R14 — Structured, authenticated messages only.** Agents communicate only through the validated envelope in `packages/shared/src/messages`. Unknown types, invalid payloads, bad signatures, unauthorized senders, stale timestamps and replayed IDs are rejected *and logged*.

**R15 — The contract is authoritative.** The database is a cache and an index. Financial history comes from indexed contract events, not from backend bookkeeping. The reconciler flags drift instead of overwriting chain facts.

**R16 — Determinism.** Coalition formation and simulated seller behaviour are seeded (`SIMULATION_SEED`). The same inputs and seed produce the same output. Never use `Math.random()` in simulation logic.

## Process

**R17 — Phased delivery.** Work proceeds in the phases of spec Section 17. After each phase: report files changed, functionality, tests run with results, known issues and the next milestone. Then wait for confirmation.

**R18 — Tests accompany behaviour.** Every money path, state transition and validation rule gets a test, including the failure cases.
