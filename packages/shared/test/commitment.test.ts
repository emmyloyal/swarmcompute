import { describe, expect, it } from "vitest";
import { computeCommitment, encodeBidPreimage, generateNonce, verifyCommitment } from "../src/commitment.js";

/**
 * Cross-implementation test vector. Generated independently with Python
 * (hashlib + struct) and to be reused verbatim by the Rust contract tests.
 *   auction_id = "auction-0001", seller_id = "seller-01",
 *   price = 10^24 yocto (1 NEAR / hour), nonce = 0x00..0x1f
 */
const NONCE = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const VECTOR = {
  auctionId: "auction-0001",
  sellerId: "seller-01",
  pricePerHourYocto: 10n ** 24n,
  nonce: NONCE,
};
const PREIMAGE_HEX =
  "0000000c61756374696f6e2d30303031" +
  "0000000973656c6c65722d3031" +
  "00000010000000000000d3c21bcecceda1000000" +
  "00000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const COMMITMENT = "c80c9bf2feaea19846ff2eca8baacb87a274d7ad8eb08c30692cb515e651c2ee";

describe("bid commitment", () => {
  it("matches the shared test vector byte-for-byte", () => {
    expect(encodeBidPreimage(VECTOR).toString("hex")).toBe(PREIMAGE_HEX);
    expect(computeCommitment(VECTOR)).toBe(COMMITMENT);
  });

  it("binds seller_id and auction_id (no cross-seller / cross-auction replay)", () => {
    expect(computeCommitment({ ...VECTOR, sellerId: "seller-02" })).toBe(
      "6e369306be0f57efad081431de6fbfe3ffd9fecb01238171f81b8bc38439eeeb",
    );
    expect(computeCommitment({ ...VECTOR, auctionId: "auction-0002" })).toBe(
      "351f33b8e98cf6bd7a61110f0eaeadd8f96322768b2f3381b7b189726ccf277f",
    );
  });

  it("verifies matching reveals and rejects any changed field", () => {
    expect(verifyCommitment(COMMITMENT, VECTOR)).toBe(true);
    expect(verifyCommitment(COMMITMENT, { ...VECTOR, pricePerHourYocto: 10n ** 24n - 1n })).toBe(false);
    const nonce2 = Buffer.from(NONCE);
    nonce2[0] = 0xff;
    expect(verifyCommitment(COMMITMENT, { ...VECTOR, nonce: nonce2 })).toBe(false);
    expect(verifyCommitment("not-hex", VECTOR)).toBe(false);
  });

  it("is unambiguous: shifting bytes between fields changes the hash", () => {
    const a = computeCommitment({ ...VECTOR, auctionId: "auction-0001s", sellerId: "eller-01" });
    expect(a).not.toBe(COMMITMENT);
  });

  it("requires a 32-byte nonce and a u128 price", () => {
    expect(() => computeCommitment({ ...VECTOR, nonce: Buffer.alloc(31) })).toThrow();
    expect(() => computeCommitment({ ...VECTOR, pricePerHourYocto: 1n << 128n })).toThrow();
    expect(() => computeCommitment({ ...VECTOR, pricePerHourYocto: -1n })).toThrow();
    expect(generateNonce()).toHaveLength(32);
  });
});
