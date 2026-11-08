/**
 * Shared wiring for the testnet runners: validated config, Postgres, NEAR
 * client (chain_id checked), contract wrapper, and the agent swarm.
 */
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Swarm } from "../agents/swarm.js";
import { Marketplace } from "../chain/marketplace.js";
import { NearChain } from "../chain/near-client.js";
import { loadConfig, type Config } from "../config/env.js";
import { BidVault } from "../crypto/bid-vault.js";
import { persistSwarm } from "../db/agents-repo.js";
import { PgCoalitionStore } from "../db/coalition-repo.js";
import { PgTxRecorder } from "../db/tx-repo.js";
import { PgMessageLog } from "../messaging/pg-log.js";

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.env") });

export interface Runtime {
  cfg: Config;
  pool: pg.Pool;
  chain: NearChain;
  contract: Marketplace;
  swarm: Swarm;
}

export async function bootstrap(): Promise<Runtime> {
  const cfg = loadConfig(process.env);
  const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL });
  const chain = await NearChain.connect({
    rpcUrl: cfg.NEAR_RPC_URL,
    contractId: cfg.MARKETPLACE_CONTRACT_ID,
    accounts: {
      operator: { accountId: cfg.OPERATOR_ACCOUNT_ID, privateKey: cfg.OPERATOR_PRIVATE_KEY },
      funder: { accountId: cfg.FUNDER_ACCOUNT_ID, privateKey: cfg.FUNDER_PRIVATE_KEY },
      verifier: { accountId: cfg.VERIFIER_ACCOUNT_ID, privateKey: cfg.VERIFIER_PRIVATE_KEY },
    },
    buyerWallets: { parent: cfg.BUYER_WALLET_PARENT, privateKey: cfg.BUYER_PRIVATE_KEY },
    recorder: new PgTxRecorder(pool),
  });
  const swarm = new Swarm({
    seed: cfg.SIMULATION_SEED,
    masterSecret: cfg.agentHmacMasterSecret,
    payoutAccounts: cfg.SELLER_PAYOUT_ACCOUNTS,
    baseTime: new Date(),
    log: new PgMessageLog(pool),
    vault: new BidVault(cfg.bidEncryptionKey),
    maxAgeMs: cfg.MESSAGE_MAX_AGE_SECONDS * 1000,
    // Run-unique round so coalition IDs never collide with earlier runs on the same contract.
    coalition: { store: new PgCoalitionStore(pool), firstRound: Math.floor(Date.now() / 1000) },
    buyerWalletParent: cfg.BUYER_WALLET_PARENT,
  });
  await persistSwarm(pool, swarm.buyers.map((b) => b.profile), swarm.sellers.map((s) => s.profile));
  return { cfg, pool, chain, contract: new Marketplace(chain), swarm };
}
