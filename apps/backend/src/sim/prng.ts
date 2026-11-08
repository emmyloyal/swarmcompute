/**
 * Seeded deterministic PRNG for all simulation behaviour (RULES.md R16).
 * The platform's unseeded random number generator is never used in simulation logic.
 *
 * Stream = SHA-256(seed ‖ 0x00 ‖ label ‖ 0x00 ‖ counter_be64). Each label gives
 * an independent stream, so adding draws for one agent never shifts another
 * agent's draws. Integer-only output; probabilities are basis points.
 */
import { createHash } from "node:crypto";

export class Prng {
  private counter = 0n;
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;

  constructor(
    private readonly seed: string,
    private readonly label: string,
  ) {
    if (!seed) throw new Error("PRNG seed is required");
  }

  /** Independent child stream, e.g. `rng.fork("buyer-001")`. */
  fork(label: string): Prng {
    return new Prng(this.seed, `${this.label}/${label}`);
  }

  private refill(): void {
    const c = Buffer.alloc(8);
    c.writeBigUInt64BE(this.counter++);
    this.buf = createHash("sha256")
      .update(this.seed, "utf8")
      .update(Buffer.from([0]))
      .update(this.label, "utf8")
      .update(Buffer.from([0]))
      .update(c)
      .digest();
    this.pos = 0;
  }

  nextU32(): number {
    if (this.pos + 4 > this.buf.length) this.refill();
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  /** Uniform integer in [0, n). Rejection sampling: no modulo bias. */
  below(n: number): number {
    if (!Number.isSafeInteger(n) || n <= 0 || n > 2 ** 32) throw new RangeError(`below(${n})`);
    const limit = 2 ** 32 - (2 ** 32 % n);
    for (;;) {
      const v = this.nextU32();
      if (v < limit) return v % n;
    }
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) throw new RangeError(`int(${min}, ${max})`);
    return min + this.below(max - min + 1);
  }

  /** Uniform bigint in [min, max] inclusive (for yocto amounts). */
  bigint(min: bigint, max: bigint): bigint {
    if (max < min) throw new RangeError("bigint: max < min");
    const span = max - min + 1n;
    const bits = span.toString(2).length;
    const words = Math.ceil(bits / 32);
    const mask = (1n << BigInt(bits)) - 1n;
    for (;;) {
      let v = 0n;
      for (let i = 0; i < words; i++) v = (v << 32n) | BigInt(this.nextU32());
      v &= mask;
      if (v < span) return min + v;
    }
  }

  /** True with probability bps / 10000. */
  chanceBps(bps: number): boolean {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError(`chanceBps(${bps})`);
    return this.below(10_000) < bps;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("pick from empty list");
    return items[this.below(items.length)]!;
  }
}
