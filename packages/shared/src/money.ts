/**
 * Money arithmetic. RULES.md R3: no floating point for money, anywhere.
 * All amounts are yoctoNEAR held as `bigint` in memory and as canonical
 * decimal strings on the wire / in JSON. Range is u128 to match the contract.
 */
import { z } from "zod";

export const YOCTO_PER_NEAR = 10n ** 24n;
export const U128_MAX = (1n << 128n) - 1n;

/** Canonical non-negative integer: no sign, no leading zeros, no exponent. */
const CANONICAL_UINT = /^(0|[1-9][0-9]*)$/;

export class MoneyError extends Error {
  override name = "MoneyError";
}

export function assertU128(value: bigint, label = "amount"): bigint {
  if (value < 0n) throw new MoneyError(`${label} is negative`);
  if (value > U128_MAX) throw new MoneyError(`${label} exceeds u128`);
  return value;
}

/** Parse a canonical yocto decimal string. Rejects floats, signs, hex, whitespace. */
export function parseYocto(input: string, label = "amount"): bigint {
  if (typeof input !== "string" || !CANONICAL_UINT.test(input)) {
    throw new MoneyError(`${label} is not a canonical yocto integer string`);
  }
  return assertU128(BigInt(input), label);
}

export function formatYocto(value: bigint): string {
  return assertU128(value).toString(10);
}

/**
 * Convert a human NEAR decimal string ("1", "0.25") to yocto exactly.
 * Rejects more than 24 fractional digits instead of rounding.
 */
export function nearToYocto(near: string): bigint {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,24}))?$/.exec(near);
  if (!m) throw new MoneyError(`"${near}" is not a valid NEAR amount`);
  const whole = BigInt(m[1]!);
  const frac = (m[2] ?? "").padEnd(24, "0");
  return assertU128(whole * YOCTO_PER_NEAR + BigInt(frac));
}

/** Display-only conversion; exact (no rounding), trailing zeros trimmed. */
export function yoctoToNear(value: bigint): string {
  assertU128(value);
  const whole = value / YOCTO_PER_NEAR;
  const frac = (value % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac.length ? `${whole}.${frac}` : whole.toString();
}

/** price_per_hour × hours with u128 overflow check (Section 5 contribution rule). */
export function mulPriceHours(pricePerHour: bigint, hours: number): bigint {
  if (!Number.isSafeInteger(hours) || hours < 0) {
    throw new MoneyError("hours must be a non-negative safe integer");
  }
  return assertU128(assertU128(pricePerHour, "price") * BigInt(hours), "price × hours");
}

export function sumYocto(values: readonly bigint[]): bigint {
  let total = 0n;
  for (const v of values) total = assertU128(total + assertU128(v), "sum");
  return total;
}

export function isYoctoString(s: unknown): s is string {
  return typeof s === "string" && s.length <= 39 && CANONICAL_UINT.test(s) && BigInt(s) <= U128_MAX;
}

/**
 * Zod schema for a yocto amount on the wire (string), with u128 bound.
 * A single refinement (not regex + refine) because Zod 3 runs later refinements
 * on values that already failed earlier checks.
 */
export const YoctoString = z
  .string()
  .refine(isYoctoString, "must be a canonical u128 integer string (yocto)");

/** Strictly positive yocto amount. */
export const PositiveYoctoString = z
  .string()
  .refine((s) => isYoctoString(s) && s !== "0", "must be a canonical u128 integer string > 0 (yocto)");
