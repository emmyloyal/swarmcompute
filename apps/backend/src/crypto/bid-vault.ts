/**
 * Unrevealed bid secrets at rest (RULES.md R13, spec Section 13).
 *
 * AES-256-GCM, layout iv(12) ‖ ciphertext ‖ tag(16). The auction_id and
 * seller_id are bound as associated data, so a ciphertext copied to another
 * bid row fails to decrypt. Ciphertexts are wiped after a confirmed reveal.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { assertU128 } from "@swarmcompute/shared";

export const BID_KEY_VERSION = 1;

export interface SealedBid {
  priceCiphertext: Buffer;
  nonceCiphertext: Buffer;
  keyVersion: number;
}

function aad(auctionId: string, sellerId: string, field: "price" | "nonce"): Buffer {
  return Buffer.from(`swarmcompute/bid/v1/${auctionId}/${sellerId}/${field}`, "utf8");
}

function encrypt(key: Buffer, plaintext: Buffer, ad: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(ad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

function decrypt(key: Buffer, blob: Buffer, ad: Buffer): Buffer {
  if (blob.length < 12 + 16) throw new Error("ciphertext too short");
  const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  d.setAAD(ad);
  d.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
}

export class BidVault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("bid encryption key must be 32 bytes");
  }

  seal(auctionId: string, sellerId: string, pricePerHourYocto: bigint, nonce: Buffer): SealedBid {
    if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
    assertU128(pricePerHourYocto, "price");
    const price = Buffer.alloc(16);
    let v = pricePerHourYocto;
    for (let i = 15; i >= 0; i--) {
      price[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return {
      priceCiphertext: encrypt(this.key, price, aad(auctionId, sellerId, "price")),
      nonceCiphertext: encrypt(this.key, nonce, aad(auctionId, sellerId, "nonce")),
      keyVersion: BID_KEY_VERSION,
    };
  }

  open(auctionId: string, sellerId: string, sealed: SealedBid): { pricePerHourYocto: bigint; nonce: Buffer } {
    if (sealed.keyVersion !== BID_KEY_VERSION) throw new Error(`unsupported bid key version ${sealed.keyVersion}`);
    const price = decrypt(this.key, sealed.priceCiphertext, aad(auctionId, sellerId, "price"));
    const nonce = decrypt(this.key, sealed.nonceCiphertext, aad(auctionId, sellerId, "nonce"));
    let p = 0n;
    for (const b of price) p = (p << 8n) | BigInt(b);
    return { pricePerHourYocto: p, nonce };
  }
}
