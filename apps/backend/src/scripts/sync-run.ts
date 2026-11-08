/**
 * Phase 6 sync worker: confirm on-chain messages via RPC, index contract
 * events, reconcile purchases against contract views.
 *
 *   pnpm --filter @swarmcompute/backend sync:run
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { yoctoToNear } from "@swarmcompute/shared";
import { NearChain } from "../chain/near-client.js";
import { loadConfig } from "../config/env.js";
import { PgMessageConfirmer } from "../sync/confirm.js";
import { PgEventIndexer } from "../sync/indexer.js";
import { PgReconciler } from "../sync/reconcile.js";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.env") });

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL });
  try {
    const chain = await NearChain.connect({
      rpcUrl: cfg.NEAR_RPC_URL,
      contractId: cfg.MARKETPLACE_CONTRACT_ID,
      accounts: {
        operator: { accountId: cfg.OPERATOR_ACCOUNT_ID, privateKey: cfg.OPERATOR_PRIVATE_KEY },
        funder: { accountId: cfg.FUNDER_ACCOUNT_ID, privateKey: cfg.FUNDER_PRIVATE_KEY },
        verifier: { accountId: cfg.VERIFIER_ACCOUNT_ID, privateKey: cfg.VERIFIER_PRIVATE_KEY },
      },
    });
    const idx = await new PgEventIndexer(pool, chain).run();
    console.log(`index:     ${idx.txs} txs, ${idx.events} new events, ${idx.reputation} reputation snapshots, ${idx.notFound} not yet visible`);
    const conf = await new PgMessageConfirmer(pool, chain, {
      operator: cfg.OPERATOR_ACCOUNT_ID,
      funder: cfg.FUNDER_ACCOUNT_ID,
      verifier: cfg.VERIFIER_ACCOUNT_ID,
    }).run();
    console.log(`confirm:   ${conf.confirmed} confirmed, ${conf.rejected} rejected, ${conf.pending} pending`);
    const rec = await new PgReconciler(pool, chain).run();
    console.log(`reconcile: ${rec.checked} purchases checked, ${rec.drifted.length} with drift${rec.drifted.length ? `: ${rec.drifted.join(", ")}` : ""}`);
    console.log(
      `escrow:    contract total ${yoctoToNear(rec.escrow.chainTotal)} NEAR, explained by known purchases ${yoctoToNear(rec.escrow.explained)} NEAR` +
        (rec.escrow.unexplained !== 0n ? `  UNEXPLAINED ${yoctoToNear(rec.escrow.unexplained < 0n ? -rec.escrow.unexplained : rec.escrow.unexplained)} NEAR` : ""),
    );
    if (rec.drifted.length || rec.escrow.unexplained !== 0n) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
