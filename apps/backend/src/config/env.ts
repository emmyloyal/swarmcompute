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
const Key32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be exactly 32 bytes of hex");

const RpcUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u), "must be https (or local http)")
  .refine((u) => !/mainnet/i.test(u) && !/(^|\/\/|\.)rpc\.near\.org/i.test(u), "mainnet RPC endpoints are forbidden");

const Secs = (def: number) => z.coerce.number().int().min(1).max(30 * 24 * 3600).default(def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Hosting platforms set PORT; BACKEND_PORT wins when both are set.
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  BACKEND_PORT: z.coerce.number().int().min(1).max(65535).optional(),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL"),

  NEAR_NETWORK: z.literal("testnet", { errorMap: () => ({ message: "NEAR_NETWORK must be 'testnet' — mainnet is never allowed" }) }),
  NEAR_RPC_URL: RpcUrl,
  NEAR_EXPLORER_TX_URL: z.string().url().refine((u) => /testnet/i.test(u), "explorer must be a testnet explorer"),

  MARKETPLACE_CONTRACT_ID: Account,
  // OPERATOR: forms coalitions, opens rounds, runs the simulated delivery steps (RULES.md R8).
  // VERIFIER: the only account allowed to call verify().
  OPERATOR_ACCOUNT_ID: Account,
  VERIFIER_ACCOUNT_ID: Account,
  OPERATOR_PRIVATE_KEY: PrivateKey,
  VERIFIER_PRIVATE_KEY: PrivateKey,

  // AES-256-GCM keys. KEYSTORE encrypts agents' private keys at rest (R19);
  // BID encrypts unrevealed bid prices and nonces (R13).
  KEYSTORE_ENCRYPTION_KEY: Key32,
  BID_ENCRYPTION_KEY: Key32,

  // Comma-separated origins allowed to call the API from a browser; "*" for any.
  CORS_ORIGINS: z.string().default("*"),

  // Market host cadence and auction phase lengths (chain seconds).
  HOST_TICK_SECONDS: z.coerce.number().int().min(2).max(600).default(8),
  PREPAY_SECS: Secs(180),
  COMMIT_SECS: Secs(60),
  REVEAL_SECS: Secs(60),
  DELIVERY_SECS: Secs(600),
  VERIFICATION_SECS: Secs(600),
  // After a failed attempt, a buyer isn't regrouped until sellers change or this passes.
  RETRY_COOLDOWN_SECS: Secs(900),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface Config extends Omit<RawEnv, "KEYSTORE_ENCRYPTION_KEY" | "BID_ENCRYPTION_KEY" | "PORT" | "BACKEND_PORT" | "CORS_ORIGINS"> {
  port: number;
  corsOrigins: "*" | string[];
  keystoreKey: Buffer;
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
  const { KEYSTORE_ENCRYPTION_KEY, BID_ENCRYPTION_KEY, PORT, BACKEND_PORT, CORS_ORIGINS, ...rest } = parsed.data;
  if (KEYSTORE_ENCRYPTION_KEY.toLowerCase() === BID_ENCRYPTION_KEY.toLowerCase()) {
    throw new ConfigError("Invalid configuration:\n  - KEYSTORE_ENCRYPTION_KEY: must differ from BID_ENCRYPTION_KEY");
  }
  const base = rest.NEAR_EXPLORER_TX_URL.endsWith("/") ? rest.NEAR_EXPLORER_TX_URL : `${rest.NEAR_EXPLORER_TX_URL}/`;
  const origins = CORS_ORIGINS.trim() === "*" ? "*" : CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    ...rest,
    port: BACKEND_PORT ?? PORT ?? 4000,
    corsOrigins: origins,
    keystoreKey: Buffer.from(KEYSTORE_ENCRYPTION_KEY, "hex"),
    bidEncryptionKey: Buffer.from(BID_ENCRYPTION_KEY, "hex"),
    explorerTxUrl: (txHash) => `${base}${encodeURIComponent(txHash)}`,
  };
}
