/**
 * Phase 3 runner: start the 20 buyer + 5 seller agents against the local DB.
 * Persists the swarm, publishes requirements and availability over the
 * authenticated bus (every message logged to agent_messages), prints a summary.
 *
 *   pnpm --filter @swarmcompute/backend agents:run
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { yoctoToNear } from "@swarmcompute/shared";
import { Swarm } from "../agents/swarm.js";
import { loadSimConfig } from "../config/sim-env.js";
import { BidVault } from "../crypto/bid-vault.js";
import { persistSwarm } from "../db/agents-repo.js";
import { PgCoalitionStore } from "../db/coalition-repo.js";
import { PgMessageLog } from "../messaging/pg-log.js";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.env") });

async function main(): Promise<void> {
  const cfg = loadSimConfig(process.env);
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
  try {
    const swarm = new Swarm({
      seed: cfg.seed,
      masterSecret: cfg.masterSecret,
      payoutAccounts: cfg.payoutAccounts,
      baseTime: new Date(),
      log: new PgMessageLog(pool),
      vault: new BidVault(cfg.bidEncryptionKey),
      maxAgeMs: cfg.maxAgeMs,
      coalition: { store: new PgCoalitionStore(pool) },
    });
    await persistSwarm(pool, swarm.buyers.map((b) => b.profile), swarm.sellers.map((s) => s.profile));

    console.log(`seed "${cfg.seed}": ${swarm.buyers.length} buyers, ${swarm.sellers.length} sellers (all SIMULATED)`);
    for (const b of swarm.buyers) {
      const p = b.profile;
      console.log(
        `  ${p.buyerId}  ${p.gpuModel} ≥${p.minVramGb}GB  ${String(p.requiredHours).padStart(2)}h  ` +
          `max ${yoctoToNear(p.maxPricePerHourYocto)} NEAR/h  budget ${yoctoToNear(p.maxBudgetYocto)} NEAR`,
      );
    }
    for (const s of swarm.sellers) {
      const offers = s.profile.offers.map((o) => `${o.gpuModel}/${o.vramGb}GB/${o.capacityHours}h`).join(", ");
      console.log(`  ${s.id}  ${s.profile.strategy.padEnd(22)} ${offers}  payout ${s.profile.payoutAccount}`);
    }

    const r = await swarm.announce();
    console.log(`\nmessages: ${r.sent} accepted, ${r.rejected} rejected`);
    for (const [id, inbox] of swarm.inboxes) if (inbox.length) console.log(`  ${id}: ${inbox.length} received`);

    const formed = await swarm.formCoalitions();
    console.log(`\ncoalition round: ${formed.coalitions.length} coalitions, ${formed.unserved.length} buyers not grouped`);
    for (const plan of formed.coalitions) {
      const c = swarm.coalitionAgent.coalitions.get(plan.coalitionId)!;
      const members = [...c.members].map(([b, st]) => `${b}${st === "ACCEPTED" ? "" : `(${st})`}`).join(" ");
      console.log(
        `  ${plan.coalitionId} [${c.status}] ${plan.gpuModel}/${plan.vramGb}GB ${c.plan.totalHours}h ` +
          `ceiling ${yoctoToNear(c.plan.priceCeilingPerHourYocto)} NEAR/h, min ${plan.minMembers}, sellers ${plan.feasibleSellerIds.join(",")}`,
      );
      console.log(`      ${members}`);
    }
    for (const u of formed.unserved) console.log(`  not grouped: ${u.buyerId} (${u.reason})`);
    if (swarm.bus.deliveryErrors.length) {
      console.error("delivery errors:", swarm.bus.deliveryErrors.map((d) => d.error));
      process.exitCode = 1;
    }
    const { rows } = await pool.query<{ status: string; n: string }>(
      "SELECT status, count(*)::text AS n FROM agent_messages GROUP BY status ORDER BY status",
    );
    console.log(`agent_messages totals: ${rows.map((x) => `${x.status}=${x.n}`).join(", ")}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
