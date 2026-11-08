/**
 * Config subset for running the agent simulation without NEAR keys (Phases 3–5
 * work before testnet accounts exist). Same rules as env.ts for the shared keys.
 */
import { z } from "zod";
import { isTestnetAccountId } from "@swarmcompute/shared";

const SimEnv = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL"),
  AGENT_HMAC_MASTER_SECRET: z.string().regex(/^([0-9a-fA-F]{2}){32,}$/, "must be at least 32 bytes of hex"),
  BID_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be exactly 32 bytes of hex"),
  MESSAGE_MAX_AGE_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  SIMULATION_SEED: z.string().min(1).max(128),
  SELLER_PAYOUT_ACCOUNTS: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.string().refine(isTestnetAccountId, "must be a testnet account")).length(5)),
});

export interface SimConfig {
  databaseUrl: string;
  masterSecret: Buffer;
  bidEncryptionKey: Buffer;
  maxAgeMs: number;
  seed: string;
  payoutAccounts: string[];
}

export function loadSimConfig(env: Record<string, string | undefined>): SimConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const r = SimEnv.safeParse(cleaned);
  if (!r.success) {
    throw new Error(`Invalid simulation config:\n${r.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  const e = r.data;
  return {
    databaseUrl: e.DATABASE_URL,
    masterSecret: Buffer.from(e.AGENT_HMAC_MASTER_SECRET, "hex"),
    bidEncryptionKey: Buffer.from(e.BID_ENCRYPTION_KEY, "hex"),
    maxAgeMs: e.MESSAGE_MAX_AGE_SECONDS * 1000,
    seed: e.SIMULATION_SEED,
    payoutAccounts: e.SELLER_PAYOUT_ACCOUNTS,
  };
}
