/** Exact yocto -> NEAR display (RULES.md R3: no floats, no rounding). */
export function near(yocto: string | null | undefined): string {
  if (yocto === null || yocto === undefined || yocto === "") return "–";
  const v = BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} NEAR`;
}

/** Per GPU-hour price, exact. */
export const perHour = (yocto: string | null | undefined) => (yocto ? `${near(yocto)}/h` : "–");

export function short(hash: string | null | undefined, head = 6, tail = 4): string {
  if (!hash) return "–";
  return hash.length <= head + tail + 1 ? hash : `${hash.slice(0, head)}…${hash.slice(-tail)}`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "–";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
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

export function when(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const STRATEGY: Record<string, string> = {
  AGGRESSIVE_LOW: "Aggressive low price",
  PREMIUM_RELIABLE: "Premium, high reliability",
  LIMITED_CAPACITY: "Limited capacity",
  FLEXIBLE: "Flexible",
  RANDOMIZED_COMPETITIVE: "Randomized competitive",
};

export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
