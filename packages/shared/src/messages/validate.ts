/**
 * Receiver-side validation pipeline (Section 11). Rejects unknown types,
 * malformed envelopes, unauthorized senders, invalid payloads, context
 * mismatches, bad signatures, stale timestamps and replayed message IDs.
 *
 * A message that passes is ACCEPTED, not CONFIRMED: for `onChain` types the
 * caller must still verify `payload.tx_hash` via NEAR RPC before confirming.
 */
import { agentKindOf } from "../ids.js";
import { CONTEXT_KEYS, EnvelopeSchema, type AgentMessage } from "./envelope.js";
import { verifySignature } from "./signing.js";
import { isMessageType, specOf } from "./types.js";

export type RejectCode =
  | "MALFORMED_ENVELOPE"
  | "UNKNOWN_TYPE"
  | "UNAUTHORIZED_SENDER"
  | "UNKNOWN_SENDER"
  | "BAD_SIGNATURE"
  | "INVALID_PAYLOAD"
  | "CONTEXT_MISMATCH"
  | "STALE"
  | "REPLAY";

export type ValidationResult =
  | { ok: true; message: AgentMessage; requiresTxVerification: boolean }
  | { ok: false; code: RejectCode; detail: string };

/** Atomically records a message ID; returns false if it was already seen. */
export interface ReplayGuard {
  claim(messageId: string): Promise<boolean>;
}

/** For tests and single-process use. Production uses the agent_messages unique index. */
export class InMemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Set<string>();
  async claim(id: string): Promise<boolean> {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}

export interface ValidationDeps {
  keyFor(agentId: string): Buffer | undefined;
  replayGuard: ReplayGuard;
  maxAgeMs: number;
  maxFutureSkewMs?: number;
  now?: () => number;
}

const reject = (code: RejectCode, detail: string): ValidationResult => ({ ok: false, code, detail });

export async function validateMessage(raw: unknown, deps: ValidationDeps): Promise<ValidationResult> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return reject("MALFORMED_ENVELOPE", "message must be a JSON object");
  }
  const type = (raw as Record<string, unknown>).type;
  if (!isMessageType(type)) return reject("UNKNOWN_TYPE", `unknown message type: ${String(type)}`);

  const env = EnvelopeSchema.safeParse(raw);
  if (!env.success) return reject("MALFORMED_ENVELOPE", env.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const e = env.data;
  if (e.status !== "PENDING") return reject("MALFORMED_ENVELOPE", "senders may only send status PENDING");

  const spec = specOf(type);
  if (agentKindOf(e.sender_id) !== spec.sender) {
    return reject("UNAUTHORIZED_SENDER", `${e.sender_id} may not send ${type}`);
  }

  // Authenticate before doing any deeper work on the payload.
  const key = deps.keyFor(e.sender_id);
  if (!key) return reject("UNKNOWN_SENDER", `no key for ${e.sender_id}`);
  if (!verifySignature(e as unknown as Record<string, unknown>, key)) return reject("BAD_SIGNATURE", "HMAC mismatch");

  const payload = spec.payload.safeParse(e.payload);
  if (!payload.success) {
    return reject("INVALID_PAYLOAD", payload.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const p = payload.data as Record<string, unknown>;

  if (spec.senderField && p[spec.senderField] !== e.sender_id) {
    return reject("UNAUTHORIZED_SENDER", `payload.${spec.senderField} must equal sender_id`);
  }
  for (const k of CONTEXT_KEYS) {
    if (typeof p[k] === "string" && p[k] !== e[k]) {
      return reject("CONTEXT_MISMATCH", `envelope ${k} (${e[k]}) != payload ${k} (${String(p[k])})`);
    }
  }

  const now = (deps.now ?? Date.now)();
  const ts = Date.parse(e.timestamp);
  if (now - ts > deps.maxAgeMs) return reject("STALE", "message too old");
  if (ts - now > (deps.maxFutureSkewMs ?? 30_000)) return reject("STALE", "timestamp in the future");

  // Last, so only fully valid messages consume their ID.
  if (!(await deps.replayGuard.claim(e.message_id))) return reject("REPLAY", `message_id ${e.message_id} already seen`);

  return {
    ok: true,
    message: { ...e, type, payload: payload.data } as AgentMessage,
    requiresTxVerification: spec.onChain,
  };
}
