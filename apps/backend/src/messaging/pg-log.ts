/**
 * Postgres-backed message log + replay guard (agent_messages, migration 0001).
 * Replay protection is the partial unique index `agent_messages_accept_once`:
 * a second ACCEPTED row with the same message_id raises 23505.
 */
import type pg from "pg";
import type { AgentMessage, RejectCode } from "@swarmcompute/shared";
import { acceptedRow, rejectedRow, type LoggedMessage, type MessageLog } from "./log.js";

const COLS = [
  "message_id",
  "sender_id",
  "receiver_id",
  "type",
  "sent_at",
  "coalition_id",
  "auction_id",
  "purchase_id",
  "payload",
  "signature",
  "status",
  "rejection_code",
  "rejection_detail",
  "tx_hash",
] as const;

const INSERT = `INSERT INTO agent_messages (${COLS.join(", ")}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(", ")})`;

/** Rejected payloads may not be JSON-serializable (e.g. contain a bigint); logging must never fail. */
function jsonPayload(p: unknown): string {
  try {
    const s = JSON.stringify(p);
    if (s !== undefined) return s;
  } catch {
    /* fall through */
  }
  return JSON.stringify({ raw: "[unserializable]" });
}

function values(row: LoggedMessage): unknown[] {
  return COLS.map((c) => (c === "payload" ? jsonPayload(row.payload) : row[c]));
}

export class PgMessageLog implements MessageLog {
  constructor(private readonly db: pg.Pool | pg.PoolClient) {}

  async recordAccepted(msg: AgentMessage): Promise<boolean> {
    try {
      await this.db.query(INSERT, values(acceptedRow(msg)));
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return false;
      throw err;
    }
  }

  async recordRejected(raw: unknown, code: RejectCode, detail: string): Promise<void> {
    await this.db.query(INSERT, values(rejectedRow(raw, code, detail)));
  }
}
