import type { SellerStrategy, WaitReason } from "./types";

const YOCTO = 10n ** 24n;

/** Exact yocto -> NEAR display (RULES.md R3: no floats, no rounding). */
export function near(yocto: string | bigint | null | undefined): string {
  if (yocto === null || yocto === undefined || yocto === "") return "–";
  const v = BigInt(yocto);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / YOCTO;
  const frac = (a % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""} NEAR`;
}

/** Per GPU-hour price, exact. */
export const perHour = (yocto: string | bigint | null | undefined) => (yocto !== null && yocto !== undefined && yocto !== "" ? `${near(yocto)}/h` : "–");

/**
 * Exact decimal NEAR -> yocto (RULES.md R3). Returns null for anything that
 * isn't a plain non-negative decimal with at most 24 fraction digits.
 */
export function parseNear(s: string): bigint | null {
  const m = /^(\d*)(?:\.(\d{1,24}))?$/.exec(s.trim());
  if (!m || (m[1] === "" && m[2] === undefined)) return null;
  return BigInt(m[1] || "0") * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0"));
}

export function short(hash: string | null | undefined, head = 6, tail = 4): string {
  if (!hash) return "–";
  return hash.length <= head + tail + 1 ? hash : `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

/** `alice.market.swarm-….testnet` -> `alice` */
export const agentName = (id: string | null | undefined) => (id ? id.split(".")[0]! : "–");

export const nsToMs = (ns: string | null | undefined) => (ns ? Number(BigInt(ns) / 1_000_000n) : null);

export function ago(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return "–";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return `in ${dur(-s)}`;
  if (s < 45) return "just now";
  return `${dur(s)} ago`;
}

export function dur(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export function when(t: string | number | null | undefined): string {
  if (t === null || t === undefined) return "–";
  return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function strategyLabel(s: SellerStrategy): string {
  return s.kind === "AT_MINIMUM" ? "Bid my minimum price" : `Bid ${(s.discount_bps / 100).toFixed(s.discount_bps % 100 ? 2 : 0)}% below the coalition's ceiling`;
}

export const WAIT_TEXT: Record<WaitReason, string> = {
  NOT_HOSTED: "This agent's key isn't held by this host, so its owner runs it.",
  INSUFFICIENT_BALANCE: "Available balance is below hours × max price. Deposit more to be grouped.",
  DEADLINE_TOO_SOON: "The deadline is too close for a full round (prepay, bidding and delivery).",
  RETRY_COOLDOWN: "The last round found no eligible bid. Waiting for sellers to change, or for the cooldown to end.",
  NO_SELLER_FOR_SPEC: "No active seller offers this GPU with enough VRAM yet.",
  EXCEEDS_CAPACITY: "No active seller has enough capacity for these hours.",
  PRICE_BELOW_MARKET: "Max price is below every capable seller's minimum.",
  NO_SELLER_AT_PRICE: "No seller's terms let it bid at this coalition's price ceiling.",
};

export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
