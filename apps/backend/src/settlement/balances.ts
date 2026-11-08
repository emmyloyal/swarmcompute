/**
 * Sends buyers' credited on-chain balances to their own wallets
 * (`withdraw_balance`; anyone may call, the destination is fixed on-chain).
 * Outcomes come from the contract's withdrawal_succeeded / withdrawal_failed
 * events (RULES.md R2). A failed transfer is retried; the contract's in-flight
 * guard makes paying a buyer twice impossible.
 */
import { createMessage, SYSTEM_AGENTS } from "@swarmcompute/shared";
import type { Swarm } from "../agents/swarm.js";
import type { MarketplaceContract } from "../chain/marketplace.js";
import type { TxResult } from "../chain/types.js";

export interface BalanceStore {
  withdrawal(buyerId: string, wallet: string, amount: bigint, ok: boolean, tx: TxResult): Promise<void>;
}

export interface Returned {
  buyerId: string;
  wallet: string;
  amount: bigint;
  txHash: string;
}

export class BalanceReturner {
  constructor(
    private readonly o: {
      swarm: Swarm;
      contract: MarketplaceContract;
      store?: BalanceStore;
      log?: (l: string) => void;
      sleep?: (ms: number) => Promise<void>;
      maxRetries?: number;
    },
  ) {}

  async returnTo(buyerIds: Iterable<string>): Promise<Returned[]> {
    const out: Returned[] = [];
    const log = this.o.log ?? (() => {});
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (const buyerId of [...new Set(buyerIds)].sort()) {
      for (let attempt = 0; ; attempt++) {
        const b = await this.o.contract.getBuyer(buyerId);
        if (!b || BigInt(b.balance) === 0n || BigInt(b.withdrawing) > 0n) break;
        const tx = await this.o.contract.withdrawBalance(buyerId);
        const ok = tx.events.find((e) => e.event === "withdrawal_succeeded");
        const failed = tx.events.find((e) => e.event === "withdrawal_failed");
        const data = (ok ?? failed)?.data[0] as { amount?: string; wallet?: string } | undefined;
        const amount = BigInt(data?.amount ?? b.balance);
        const wallet = data?.wallet ?? b.wallet;
        await this.o.store?.withdrawal(buyerId, wallet, amount, !!ok, tx);
        if (ok) {
          log(`  ${buyerId} balance ${amount} yocto → ${wallet}  ${tx.txHash}`);
          out.push({ buyerId, wallet, amount, txHash: tx.txHash });
          const r = await this.o.swarm.bus.send(
            createMessage(
              {
                type: "BALANCE_RETURNED",
                sender_id: SYSTEM_AGENTS.TREASURY,
                receiver_id: buyerId,
                timestamp: this.o.swarm.clock().toISOString(),
                payload: { buyer_id: buyerId, wallet, amount_yocto: amount.toString(), tx_hash: tx.txHash },
              },
              this.o.swarm.systemKey(SYSTEM_AGENTS.TREASURY),
            ),
          );
          if (!r.ok) throw new Error(`BALANCE_RETURNED rejected: ${r.code} ${r.detail}`);
          await this.o.swarm.bus.drain();
          break;
        }
        log(`  ${buyerId} withdrawal to ${wallet} failed (tx ${tx.txHash}), attempt ${attempt + 1}`);
        if (attempt >= (this.o.maxRetries ?? 2)) break; // left credited on-chain; a later run retries
        await sleep(2000);
      }
    }
    return out;
  }
}
