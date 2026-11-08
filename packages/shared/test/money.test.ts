import { describe, expect, it } from "vitest";
import {
  MoneyError,
  U128_MAX,
  YoctoString,
  formatYocto,
  mulPriceHours,
  nearToYocto,
  parseYocto,
  sumYocto,
  yoctoToNear,
} from "../src/money.js";

describe("money", () => {
  it("parses canonical yocto strings", () => {
    expect(parseYocto("0")).toBe(0n);
    expect(parseYocto("1000000000000000000000000")).toBe(10n ** 24n);
    expect(parseYocto(U128_MAX.toString())).toBe(U128_MAX);
  });

  it.each(["", "01", "-1", "1.5", "1e24", " 1", "0x10", (U128_MAX + 1n).toString()])(
    "rejects non-canonical or out-of-range %j",
    (s) => {
      expect(() => parseYocto(s)).toThrow(MoneyError);
      expect(YoctoString.safeParse(s).success).toBe(false);
    },
  );

  it("converts NEAR decimals exactly, without rounding", () => {
    expect(nearToYocto("1")).toBe(10n ** 24n);
    expect(nearToYocto("0.000000000000000000000001")).toBe(1n);
    expect(nearToYocto("2.5")).toBe(25n * 10n ** 23n);
    expect(() => nearToYocto("0.0000000000000000000000001")).toThrow(MoneyError); // 25 decimals
    expect(() => nearToYocto("1.")).toThrow(MoneyError);
    expect(yoctoToNear(25n * 10n ** 23n)).toBe("2.5");
    expect(yoctoToNear(1n)).toBe("0.000000000000000000000001");
    expect(formatYocto(42n)).toBe("42");
  });

  it("multiplies price × hours with u128 overflow detection", () => {
    expect(mulPriceHours(3n, 7)).toBe(21n);
    expect(() => mulPriceHours(U128_MAX, 2)).toThrow(MoneyError);
    expect(() => mulPriceHours(1n, 1.5)).toThrow(MoneyError);
    expect(() => mulPriceHours(1n, -1)).toThrow(MoneyError);
  });

  it("sums with overflow detection", () => {
    expect(sumYocto([1n, 2n, 3n])).toBe(6n);
    expect(() => sumYocto([U128_MAX, 1n])).toThrow(MoneyError);
  });
});
