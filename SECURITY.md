# Security and trust model

SwarmCompute is a demo on NEAR Testnet. It is **not** a trustless system. This document says exactly who is trusted for what, and what the contract enforces no matter who calls it.

## Who controls what

| Party | Controls | Held by |
|---|---|---|
| Owner | role rotation, pause | the deployment script's account (in the demo, the dev account) |
| Operator | registers buyers, sellers and coalitions; opens auctions; submits sellers' sealed bids and reveals; starts delivery; submits delivery reports | backend |
| Verifier | the only account that can call `verify` | backend (Verification Agent) |
| Buyer wallets (20) | prepay for their own buyer only | backend holds the keys (the buyers are simulated) |
| Seller payout accounts (5) | receive payouts | real testnet accounts |

In the demo every role, and every buyer wallet key, belongs to one operator. The roles are separate contract fields so they can be split.

## What the contract guarantees, whoever calls it

1. **No buyer pays above its own maximum.** The coalition's price ceiling is the lowest member maximum. Bids above it are ineligible.
2. **Every member pays the same rate.** At close, each member owes exactly `hours × clearing price`, and the contract asserts `held == Σ owed`.
3. **The cheapest eligible seller wins.** It's the lowest revealed bid that is eligible on GPU, VRAM, capacity, ceiling and budget, with deterministic tie-breaks.
4. **Prepayment is exact and comes from the buyer's own wallet.** Any other sender or amount panics, and the deposit is returned.
5. **Excess is returned.** `prepaid − owed` is credited to the buyer at close. `withdraw_balance` can send it only to that buyer's registered wallet.
6. **No payout before verification.** A seller is paid only after `verify(success)` by the verifier.
7. **Money has only two destinations:** the awarded seller's registered payout account, or the buyer who paid it. Payout accounts and wallets can't be changed after registration.
8. **Nothing is paid twice.** Payouts and withdrawals set an in-flight marker before the transfer. The callback finalises or clears it. A second call while the marker is set, or after completion, panics.
9. **No purchase spends another's money.** `total_escrowed` (Σ held) and `total_balances` (Σ buyer balances) are tracked separately from the storage reserve. Every transfer first asserts that the account balance covers both.
10. **Nobody can trap the money.** Anyone can `expire` a purchase past its prepay, delivery or verification deadline, or `close_auction` after the reveal deadline. Either way every member's money is credited back. Pause never blocks `expire`, `withdraw_balance` or callbacks.
11. **Reputation can't be edited directly.** It changes only through contract transitions: award, completed delivery, failed delivery and non-reveal.

## What a dishonest operator could still do

- **Falsely verify a delivery**, so the seller is paid for compute that never ran. Delivery and its verification are simulated and operator-controlled. Guarantees 6 and 7 still limit this: the money can only go to the seller who actually won.
- **Falsely fail a delivery**, so every buyer is refunded instead. No money is lost; the seller just isn't paid.
- **See every bid before reveal.** The backend generates all bids and nonces, so commit-reveal hides bids from other sellers and the public, but not from the operator.
- **Move buyer-wallet funds directly.** It holds those keys. This is a property of the simulation, not of the contract.
- **Stall.** It can refuse to start delivery or submit reports. The deadlines then let anyone return everyone's money.

## Secrets

- **Private keys** live only in `.env`, which is git-ignored. The config loader never echoes values. Nothing secret has the `VITE_` prefix, and the frontend holds no keys.
- **Unrevealed bids** are stored only as AES-256-GCM ciphertext. The auction and seller IDs are bound in as associated data, and the ciphertext is wiped once the reveal is final on-chain.
- **Agent messages** are HMAC-SHA256 signed with per-agent keys derived from `AGENT_HMAC_MASTER_SECRET`. Unknown types, bad signatures, wrong senders, stale timestamps and replays are rejected and logged.
- **The public API** reads only `public_*` database views. Those exclude seller minimum prices, failure rates, ciphertexts and message signatures.

## Checks you can run yourself

- **Fairness:** the explorer page for each purchase shows every member's prepaid, owed and returned amounts. "Check on-chain" reads the same purchase from the contract through the public RPC.
- **The `sync:run` job:** it confirms every agent message that claims a transaction by finding the matching contract event, and flags any drift between the database and the contract.
- **The contract's view methods:** `get_solvency` and `get_config` expose the escrow, balance and storage invariants.

## Network

Everything targets NEAR **Testnet**:
- The config rejects mainnet RPCs, explorers and non-`.testnet` accounts.
- The chain client refuses any RPC whose `chain_id` isn't `testnet`.
