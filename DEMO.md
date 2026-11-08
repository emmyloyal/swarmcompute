# Demo script (about 8 minutes)

Before you start, set up a deployed contract (`testnet:setup`) and start the API (`api:start`) and the UI (`frontend dev`). Run `demo:run` once beforehand so the pages have data, then run it again live in step 3.

## 1. The problem (30 s)

Agents buying GPU time alone have no bargaining power, can't tell what a fair price is, and can't trust strangers with prepayment. SwarmCompute pools them, makes sellers bid against each other, and settles through escrow, with one fair price for everyone in the group.

## 2. Real versus simulated (30 s)

Point at the legend in the sidebar:
- **Simulated:** the agents, GPU delivery and verification.
- **On-chain:** every prepayment, auction step, payout, refund and returned balance, each with a link to NEAR Testnet.

Also say plainly that this is not trustless, and why (SECURITY.md).

## 3. Run it live (3 min)

```sh
pnpm --filter @swarmcompute/backend demo:run
```

Narrate the output as it goes:
1. **Coalitions:** 20 buyers, 3 coalitions. 2 buyers are left out because their maximum price is below the market, so they can't drag a group's ceiling down.
2. **Prepay:** each buyer prepays its **own maximum** from its own wallet. These are real transactions.
3. **Sealed bids:** 2–3 sellers per coalition commit hidden bids, then reveal them. A reveal at the wrong price is rejected by the contract.
4. **The `[fairness]` table:** one clearing price per coalition, the lowest bid. Every member pays its hours × that price, and the column "back" is what returned to its wallet.
5. **Settlement:** two deliveries are verified and the sellers are paid. One forced failure refunds **each buyer to its own wallet**.

## 4. The UI (3 min)

1. **Overview:** the purchase pipeline by state, "Saved by buyers vs their own max price", "Sent back to buyer wallets", and 0 drift.
2. **Live auctions:** before reveal there's only "sealed" and a commitment hash, never a price. Read the confidentiality note.
3. **Blockchain explorer → a completed purchase:**
   - The badges: "✓ 7 of 7 members at the same rate" and "✓ nobody above their own max".
   - The table: each buyer's own max, prepaid, rate paid (identical down the column), paid, and back to wallet. The proof links open the prepayment and the return transfer on nearblocks.
   - Click **Check on-chain**: the browser reads the same purchase straight from the contract.
4. **Blockchain explorer → the refunded purchase:** every member shows "refunded" and got back everything it prepaid.
5. **Seller swarm:** reputation comes from contract events (wins, delivered, failed, missed). Minimum prices are never shown.
6. **Agent activity:** filter to "Confirmed on-chain". Each message is HMAC-signed, and was confirmed by finding the matching contract event.

## 5. Close (30 s)

The guarantees that matter are enforced by the contract, not by trust in the agents:
- one rate for every member, never above anyone's own max;
- the cheapest seller wins;
- no payout without verification;
- money goes only to the winner or back to whoever paid it, and never twice.
