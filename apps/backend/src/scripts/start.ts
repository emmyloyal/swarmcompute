/**
 * Starts the SwarmCompute market host: migrations, the agent host loop, the
 * event indexer and the HTTP API, in one process.
 *
 *   pnpm --filter @swarmcompute/backend start
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApiServer } from "../api/server.js";
import { Marketplace, type ContractWindows } from "../chain/marketplace.js";
import { NearChain } from "../chain/near-client.js";
import { loadConfig } from "../config/env.js";
import { BidVault } from "../crypto/bid-vault.js";
import { migrate } from "../db/migrate.js";
import { PgTxRecorder } from "../db/tx-repo.js";
import { PgActivity } from "../host/activity.js";
import { PgBidStore } from "../host/bids.js";
import { MarketHost } from "../host/market.js";
import { KeyStore, PgKeyRepo } from "../keystore/keystore.js";
import { PgEventIndexer } from "../sync/indexer.js";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.env") });

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  await migrate(cfg.DATABASE_URL);
  const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 10 });
  const chain = await NearChain.connect({
    rpcUrl: cfg.NEAR_RPC_URL,
    contractId: cfg.MARKETPLACE_CONTRACT_ID,
    accounts: {
      operator: { accountId: cfg.OPERATOR_ACCOUNT_ID, privateKey: cfg.OPERATOR_PRIVATE_KEY },
      verifier: { accountId: cfg.VERIFIER_ACCOUNT_ID, privateKey: cfg.VERIFIER_PRIVATE_KEY },
    },
    recorder: new PgTxRecorder(pool),
  });
  const contract = new Marketplace(chain);
  const keys = new KeyStore(new PgKeyRepo(pool), cfg.keystoreKey, chain);
  const windows: ContractWindows = {
    prepay_secs: cfg.PREPAY_SECS,
    commit_secs: cfg.COMMIT_SECS,
    reveal_secs: cfg.REVEAL_SECS,
    delivery_secs: cfg.DELIVERY_SECS,
    verification_secs: cfg.VERIFICATION_SECS,
  };
  const host = new MarketHost({
    contract,
    keys,
    bids: new PgBidStore(pool),
    vault: new BidVault(cfg.bidEncryptionKey),
    windows,
    retryCooldownSecs: cfg.RETRY_COOLDOWN_SECS,
    activity: new PgActivity(pool),
    log: (l) => console.log(`${new Date().toISOString()} ${l}`),
  });
  const indexer = new PgEventIndexer(pool, chain);

  const server = createApiServer({
    host,
    keys,
    pool,
    meta: { contractId: cfg.MARKETPLACE_CONTRACT_ID, explorerTxUrl: cfg.explorerTxUrl(""), rpcUrl: cfg.NEAR_RPC_URL, windows },
    corsOrigins: cfg.corsOrigins,
  });
  server.listen(cfg.port, () => console.log(`SwarmCompute market host on :${cfg.port}, contract ${cfg.MARKETPLACE_CONTRACT_ID} (NEAR Testnet)`));

  let stopping = false;
  const stop = () => {
    stopping = true;
    server.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const started = Date.now();
    try {
      const s = await host.tick();
      if (s.tick % 3 === 1) await indexer.run(200).catch((e) => console.error(`indexer: ${(e as Error).message}`));
    } catch (err) {
      console.error(`tick failed: ${(err as Error).message}`);
    }
    const wait = cfg.HOST_TICK_SECONDS * 1000 - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await pool.end();
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
