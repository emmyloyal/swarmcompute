/**
 * Backend configuration. Validated once at startup; the process refuses to run
 * against anything that is not NEAR Testnet (RULES.md R1) or with malformed keys.
 *
 * `loadConfig` is a pure function of an env record so it can be unit-tested.
 */
import { z } from "zod";
import { isTestnetAccountId } from "@swarmcompute/shared";

const Account = z.string().refine(isTestnetAccountId, "must be a NEAR testnet account id (*.testnet)");
const PrivateKey = z
  .string()
  .regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/, "must be ed25519:<base58 secret key>");
const Hex = (bytes: number, exact: boolean) =>
  z
    .string()
    .regex(/^[0-9a-fA-F]+$/, "must be hex")
    .refine((s) => s.length % 2 === 0 && (exact ? s.length === bytes * 2 : s.length >= bytes * 2), `must be ${exact ? "exactly" : "at least"} ${bytes} bytes of hex`);

const RpcUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u), "must be https (or local http)")
  .refine((u) => !/mainnet/i.test(u) && !/(^|\/\/|\.)rpc\.near\.org/i.test(u), "mainnet RPC endpoints are forbidden");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL"),

  NEAR_NETWORK: z.literal("testnet", { errorMap: () => ({ message: "NEAR_NETWORK must be 'testnet' — mainnet is never allowed" }) }),
  NEAR_RPC_URL: RpcUrl,
  NEAR_EXPLORER_TX_URL: z.string().url().refine((u) => /testnet/i.test(u), "explorer must be a testnet explorer"),

  MARKETPLACE_CONTRACT_ID: Account,
  OWNER_ACCOUNT_ID: Account,
  OPERATOR_ACCOUNT_ID: Account,
  FUNDER_ACCOUNT_ID: Account,
  VERIFIER_ACCOUNT_ID: Account,

  OPERATOR_PRIVATE_KEY: PrivateKey,
  FUNDER_PRIVATE_KEY: PrivateKey,
  VERIFIER_PRIVATE_KEY: PrivateKey,

  // Buyer agents' own wallets: buyer001.<parent> … buyer020.<parent>, topped up by the funder.
  BUYER_WALLET_PARENT: Account,
  BUYER_PRIVATE_KEY: PrivateKey,

  SELLER_PAYOUT_ACCOUNTS: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(Account).length(5, "exactly 5 seller payout accounts (seller-01..seller-05)"))
    .refine((a) => new Set(a).size === a.length, "seller payout accounts must be distinct"),

  AGENT_HMAC_MASTER_SECRET: Hex(32, false),
  MESSAGE_MAX_AGE_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  BID_ENCRYPTION_KEY: Hex(32, true),

  SIMULATION_SEED: z.string().min(1).max(128),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface Config extends Omit<RawEnv, "AGENT_HMAC_MASTER_SECRET" | "BID_ENCRYPTION_KEY"> {
  agentHmacMasterSecret: Buffer;
  bidEncryptionKey: Buffer;
  explorerTxUrl(txHash: string): string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  // Treat empty strings as unset so `KEY=` in .env produces a "required" error.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    // Never echo values: some are secrets.
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
  }
  const { AGENT_HMAC_MASTER_SECRET, BID_ENCRYPTION_KEY, ...rest } = parsed.data;
  const base = rest.NEAR_EXPLORER_TX_URL.endsWith("/") ? rest.NEAR_EXPLORER_TX_URL : `${rest.NEAR_EXPLORER_TX_URL}/`;
  return {
    ...rest,
    agentHmacMasterSecret: Buffer.from(AGENT_HMAC_MASTER_SECRET, "hex"),
    bidEncryptionKey: Buffer.from(BID_ENCRYPTION_KEY, "hex"),
    explorerTxUrl: (txHash) => `${base}${encodeURIComponent(txHash)}`,
  };
}
