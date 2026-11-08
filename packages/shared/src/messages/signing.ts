/**
 * HMAC-SHA256 message authentication with per-agent keys (Section 11).
 *
 * agent_key = HMAC-SHA256(master_secret, "swarmcompute/agent-key/v1/" + agent_id)
 * signature = hex(HMAC-SHA256(agent_key, canonicalJson(envelope without `signature` and `status`)))
 *
 * `status` is excluded because it is the receiver's processing state
 * (PENDING → CONFIRMED/REJECTED), not part of what the sender asserted.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";

const KEY_DOMAIN = "swarmcompute/agent-key/v1/";

export function deriveAgentKey(masterSecret: Buffer, agentId: string): Buffer {
  if (masterSecret.length < 32) throw new Error("master secret must be at least 32 bytes");
  return createHmac("sha256", masterSecret).update(KEY_DOMAIN + agentId, "utf8").digest();
}

export function signingInput(envelope: Record<string, unknown>): string {
  const { signature: _sig, status: _status, ...signed } = envelope;
  return canonicalJson(signed);
}

export function computeSignature(envelope: Record<string, unknown>, key: Buffer): string {
  return createHmac("sha256", key).update(signingInput(envelope), "utf8").digest("hex");
}

export function verifySignature(envelope: Record<string, unknown>, key: Buffer): boolean {
  const sig = envelope.signature;
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(computeSignature(envelope, key), "hex");
  } catch {
    return false; // non-canonicalizable content can never carry a valid signature
  }
  return timingSafeEqual(expected, Buffer.from(sig, "hex"));
}
