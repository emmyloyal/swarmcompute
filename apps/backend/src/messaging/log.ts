/**
 * Message log (spec Section 11: log every message, including rejected ones).
 *
 * `recordAccepted` doubles as the replay guard: it must fail atomically when the
 * message_id was already accepted (Postgres: partial unique index
 * agent_messages_accept_once). Rejected messages never consume an ID.
 */
import type { AgentMessage, RejectCode } from "@swarmcompute/shared";

export interface LoggedMessage {
  message_id: string | null;
  sender_id: string | null;
  receiver_id: string | null;
  type: string | null;
  sent_at: string | null;
  coalition_id: string | null;
  auction_id: string | null;
  purchase_id: string | null;
  payload: unknown;
  signature: string | null;
  status: "ACCEPTED" | "CONFIRMED" | "REJECTED";
  rejection_code: RejectCode | null;
  rejection_detail: string | null;
  tx_hash: string | null;
}

export interface MessageLog {
  /** Returns false if this message_id was already accepted (replay). */
  recordAccepted(msg: AgentMessage): Promise<boolean>;
  recordRejected(raw: unknown, code: RejectCode, detail: string): Promise<void>;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function acceptedRow(msg: AgentMessage): LoggedMessage {
  const p = msg.payload as Record<string, unknown>;
  return {
    message_id: msg.message_id,
    sender_id: msg.sender_id,
    receiver_id: msg.receiver_id,
    type: msg.type,
    sent_at: msg.timestamp,
    coalition_id: msg.coalition_id,
    auction_id: msg.auction_id,
    purchase_id: msg.purchase_id,
    payload: msg.payload,
    signature: msg.signature,
    status: "ACCEPTED",
    rejection_code: null,
    rejection_detail: null,
    tx_hash: str(p.tx_hash),
  };
}

/** Rejected input may be malformed in any field: keep only well-typed values, never throw. */
export function rejectedRow(raw: unknown, code: RejectCode, detail: string): LoggedMessage {
  const r = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const ts = str(r.timestamp);
  const payload =
    typeof r.payload === "object" && r.payload !== null ? r.payload : { raw: safeString("payload" in r ? r.payload : raw) };
  const p = payload as Record<string, unknown>;
  return {
    message_id: str(r.message_id)?.slice(0, 100) ?? null,
    sender_id: str(r.sender_id)?.slice(0, 100) ?? null,
    receiver_id: str(r.receiver_id)?.slice(0, 100) ?? null,
    type: str(r.type)?.slice(0, 100) ?? null,
    sent_at: ts && !Number.isNaN(Date.parse(ts)) ? ts : null,
    coalition_id: str(r.coalition_id)?.slice(0, 100) ?? null,
    auction_id: str(r.auction_id)?.slice(0, 100) ?? null,
    purchase_id: str(r.purchase_id)?.slice(0, 100) ?? null,
    payload,
    signature: str(r.signature)?.slice(0, 200) ?? null,
    status: "REJECTED",
    rejection_code: code,
    rejection_detail: detail.slice(0, 2000),
    tx_hash: str(p.tx_hash)?.slice(0, 100) ?? null,
  };
}

function safeString(v: unknown): string {
  try {
    return String(typeof v === "string" ? v : JSON.stringify(v)).slice(0, 2000);
  } catch {
    return "[unserializable]";
  }
}

export class InMemoryMessageLog implements MessageLog {
  readonly rows: LoggedMessage[] = [];
  private readonly accepted = new Set<string>();

  async recordAccepted(msg: AgentMessage): Promise<boolean> {
    if (this.accepted.has(msg.message_id)) return false;
    this.accepted.add(msg.message_id);
    this.rows.push(acceptedRow(msg));
    return true;
  }

  async recordRejected(raw: unknown, code: RejectCode, detail: string): Promise<void> {
    this.rows.push(rejectedRow(raw, code, detail));
  }
}
