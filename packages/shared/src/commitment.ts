/**
 * Sealed-bid commitment (Section 7).
 *
 *   commitment = sha256( LP(auction_id) || LP(seller_id) || LP(price_be16) || LP(nonce) )
 *
 * LP(x)     = u32 big-endian byte length of x, followed by x
 * auction_id, seller_id = UTF-8 bytes
 * price_be16 = price_per_hour_yocto as a 16-byte big-endian unsigned integer (u128)
 * nonce      = 32 random bytes
 *
 * Length-prefixing makes the encoding unambiguous; binding auction_id and seller_id
 * prevents replaying a commitment in another auction or by another seller.
 * The Rust contract (Phase 2) MUST implement byte-identical encoding; the test
 * vector in test/commitment.test.ts is shared with the contract tests.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { assertU128 } from "./money.js";

export const NONCE_BYTES = 32;

export interface BidPreimage {
  auctionId: string;
  sellerId: string;
  pricePerHourYocto: bigint;
  nonce: Uint8Array;
}

function lengthPrefixed(bytes: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([len, Buffer.from(bytes)]);
}

function u128BigEndian(value: bigint): Buffer {
  assertU128(value, "price_per_hour_yocto");
  const out = Buffer.alloc(16);
  let v = value;
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function encodeBidPreimage(p: BidPreimage): Buffer {
  if (p.nonce.length !== NONCE_BYTES) throw new Error(`nonce must be ${NONCE_BYTES} bytes`);
  if (!p.auctionId || !p.sellerId) throw new Error("auctionId and sellerId are required");
  return Buffer.concat([
    lengthPrefixed(Buffer.from(p.auctionId, "utf8")),
    lengthPrefixed(Buffer.from(p.sellerId, "utf8")),
    lengthPrefixed(u128BigEndian(p.pricePerHourYocto)),
    lengthPrefixed(p.nonce),
  ]);
}

/** Returns the commitment as 64-char lowercase hex. */
export function computeCommitment(p: BidPreimage): string {
  return createHash("sha256").update(encodeBidPreimage(p)).digest("hex");
}

export function verifyCommitment(commitmentHex: string, p: BidPreimage): boolean {
  if (!/^[0-9a-f]{64}$/.test(commitmentHex)) return false;
  const expected = Buffer.from(computeCommitment(p), "hex");
  return timingSafeEqual(expected, Buffer.from(commitmentHex, "hex"));
}

export function generateNonce(): Buffer {
  return randomBytes(NONCE_BYTES);
}
