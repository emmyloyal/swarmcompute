/**
 * Identifier formats used across contract, backend, DB and messages.
 */
import { z } from "zod";

export const GPU_MODELS = ["A100", "H100"] as const;
export const GpuModel = z.enum(GPU_MODELS);
export type GpuModel = z.infer<typeof GpuModel>;

/** Simulated buyer identity, e.g. `buyer-001`. Registered on-chain as an opaque string. */
export const BuyerId = z.string().regex(/^buyer-[0-9]{3}$/, "expected buyer-NNN");
/** Simulated seller identity, e.g. `seller-01`. */
export const SellerId = z.string().regex(/^seller-[0-9]{2}$/, "expected seller-NN");

/** Coalition / auction / purchase IDs: lowercase, digits, hyphens; 3–64 chars. */
const ENTITY_ID = /^[a-z][a-z0-9-]{2,63}$/;
export const CoalitionId = z.string().regex(ENTITY_ID);
export const AuctionId = z.string().regex(ENTITY_ID);
export const PurchaseId = z.string().regex(ENTITY_ID);

/** Fixed IDs for the singleton system agents (Section 6). */
export const SYSTEM_AGENTS = {
  COALITION: "coalition-agent",
  AUCTION_COORDINATOR: "auction-coordinator",
  VERIFICATION: "verification-agent",
  REPUTATION: "reputation-agent",
  TREASURY: "treasury-agent",
} as const;

export type AgentKind = "BUYER" | "SELLER" | keyof typeof SYSTEM_AGENTS;

export function agentKindOf(agentId: string): AgentKind | undefined {
  if (BuyerId.safeParse(agentId).success) return "BUYER";
  if (SellerId.safeParse(agentId).success) return "SELLER";
  for (const [kind, id] of Object.entries(SYSTEM_AGENTS)) {
    if (id === agentId) return kind as AgentKind;
  }
  return undefined;
}

export const AgentId = z
  .string()
  .refine((s) => agentKindOf(s) !== undefined, "unknown agent id");

/**
 * NEAR account ID per protocol rules (2–64 chars, lowercase alnum separated by
 * `-`/`_`, dot-delimited parts), or a 64-hex implicit account.
 */
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export function isNearAccountId(s: string): boolean {
  return s.length >= 2 && s.length <= 64 && NEAR_ACCOUNT.test(s);
}
/** Testnet-only named account (RULES.md R1). Implicit 64-hex accounts also allowed. */
export function isTestnetAccountId(s: string): boolean {
  return isNearAccountId(s) && (s.endsWith(".testnet") || /^[0-9a-f]{64}$/.test(s));
}
export const TestnetAccountId = z
  .string()
  .refine(isTestnetAccountId, "must be a NEAR testnet account id");

/** NEAR transaction hash: base58-encoded 32 bytes. */
export const TxHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, "invalid NEAR tx hash");

/** 32 bytes, lowercase hex. Used for commitments, nonces, report hashes. */
export const Hex32 = z.string().regex(/^[0-9a-f]{64}$/, "expected 32 bytes lowercase hex");

/** ISO-8601 UTC timestamp with offset `Z`. */
export const IsoTimestamp = z.string().datetime({ offset: false });
