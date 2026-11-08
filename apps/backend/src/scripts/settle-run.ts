/**
 * Settle every purchase that still holds escrow on-chain (FUNDED, DELIVERING,
 * VERIFYING, or FAILED/EXPIRED with a failed refund): deliver + verify, or expire
 * past-deadline ones, then pay out or refund via the contract.
 *
 *   pnpm --filter @swarmcompute/backend settle:run [-- --fail <purchase_id>]...
 */
import { yoctoToNear } from "@swarmcompute/shared";
import type { ContractPurchase } from "../chain/marketplace.js";
import { PgSettlementStore } from "../db/settlement-repo.js";
import { SettlementEngine } from "../settlement/engine.js";
import type { DeliveryOutcome } from "../sim/gpu.js";
import { bootstrap } from "./bootstrap.js";

async function main(): Promise<void> {
  const rt = await bootstrap();
  try {
    const force: Record<string, DeliveryOutcome> = {};
    process.argv.forEach((a, i) => {
      if (a === "--fail" && process.argv[i + 1]) force[process.argv[i + 1]!] = "FAILURE";
    });
    const ids: string[] = await rt.chain.view("list_purchase_ids", { from_index: 0, limit: 100 });
    const open: string[] = [];
    for (const id of ids) {
      const p = await rt.chain.view<ContractPurchase>("get_purchase", { purchase_id: id });
      // Anything still holding money, or not yet in a final state (expired leftovers from interrupted runs).
      if (BigInt(p.held) > 0n || !["COMPLETED", "REFUNDED", "FAILED", "EXPIRED"].includes(p.state)) open.push(id);
    }
    console.log(`${open.length} purchases hold escrow on ${rt.cfg.MARKETPLACE_CONTRACT_ID}`);
    const engine = new SettlementEngine({
      swarm: rt.swarm,
      contract: rt.contract,
      seed: rt.cfg.SIMULATION_SEED,
      verifierAccountId: rt.cfg.VERIFIER_ACCOUNT_ID,
      store: new PgSettlementStore(rt.pool),
      force,
      log: (l) => console.log(l),
    });
    const runs = await engine.settleAll(open);
    print(runs, rt.cfg.explorerTxUrl);
  } finally {
    await rt.pool.end();
  }
}

export function print(runs: Awaited<ReturnType<SettlementEngine["settleAll"]>>, explorer: (h: string) => string): void {
  console.log("\nsettlement");
  for (const r of runs) {
    const money = r.paidOut ? `paid ${yoctoToNear(r.paidOut)} NEAR to seller` : r.refunded ? `refunded ${yoctoToNear(r.refunded)} NEAR to the buyers` : "no transfer";
    const back = r.returnedToBuyers > 0n ? `; ${yoctoToNear(r.returnedToBuyers)} NEAR sent to buyer wallets` : "";
    console.log(`  ${r.purchaseId}  ${r.path.padEnd(9)} → ${r.finalState.padEnd(9)} ${money}${back}${r.retries ? ` (${r.retries} retries)` : ""}`);
    if (r.delivery) console.log(`      delivery ${r.delivery.outcome} ${r.delivery.allocatedHours}/${r.delivery.requiredHours} h (SIMULATED); ${r.decision?.reason}`);
    const last = r.txs.at(-1);
    if (last) console.log(`      ${explorer(last.txHash)}`);
  }
}

if (process.argv[1]?.endsWith("settle-run.ts")) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
