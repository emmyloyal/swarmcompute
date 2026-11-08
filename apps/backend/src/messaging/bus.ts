/**
 * In-process agent message bus (spec Section 11, RULES.md R14).
 *
 * Every message goes through `validateMessage` (type, envelope, sender kind,
 * HMAC, strict payload, self-assertion, context IDs, freshness, replay) and is
 * logged, accepted or rejected, before delivery. Delivery is a FIFO queue
 * processed one message at a time, so handler side effects happen in a
 * deterministic order and a handler that sends never re-enters another.
 *
 * Accepted ≠ confirmed: for on-chain message types the tx hash is verified via
 * RPC in Phase 6 before the row is marked CONFIRMED.
 */
import {
  deriveAgentKey,
  validateMessage,
  type AgentMessage,
  type RejectCode,
} from "@swarmcompute/shared";
import type { MessageLog } from "./log.js";

export type Handler = (msg: AgentMessage, bus: MessageBus) => Promise<void> | void;

export type SendResult = { ok: true; message: AgentMessage } | { ok: false; code: RejectCode; detail: string };

export interface BusOptions {
  masterSecret: Buffer;
  log: MessageLog;
  maxAgeMs: number;
  now?: () => number;
}

export interface Delivery {
  message: AgentMessage;
  error?: string;
}

export class MessageBus {
  private readonly handlers = new Map<string, Handler>();
  private readonly keys = new Map<string, Buffer>();
  private readonly queue: AgentMessage[] = [];
  private draining: Promise<void> | null = null;
  /** Handler failures, in order. Never swallowed silently. */
  readonly deliveryErrors: Delivery[] = [];

  constructor(private readonly opts: BusOptions) {}

  /** Registers an agent: derives its HMAC key and (optionally) its inbox handler. */
  register(agentId: string, handler?: Handler): Buffer {
    const key = deriveAgentKey(this.opts.masterSecret, agentId);
    this.keys.set(agentId, key);
    if (handler) this.handlers.set(agentId, handler);
    return key;
  }

  keyFor(agentId: string): Buffer | undefined {
    return this.keys.get(agentId);
  }

  /** Validate, log and enqueue. Returns the validation outcome immediately. */
  async send(raw: unknown): Promise<SendResult> {
    const log = this.opts.log;
    let claimed: AgentMessage | undefined;
    const res = await validateMessage(raw, {
      keyFor: (id) => this.keys.get(id),
      maxAgeMs: this.opts.maxAgeMs,
      now: this.opts.now,
      // The accepted row is the replay claim: inserted only after every other check passed.
      replayGuard: {
        claim: async () => {
          claimed = raw as AgentMessage;
          return log.recordAccepted(claimed);
        },
      },
    });
    if (!res.ok) {
      await log.recordRejected(raw, res.code, res.detail);
      return res;
    }
    if (!this.keys.has(res.message.receiver_id)) {
      // Accepted and logged, but nobody to deliver to: surface it.
      this.deliveryErrors.push({ message: res.message, error: `unknown receiver ${res.message.receiver_id}` });
      return { ok: true, message: res.message };
    }
    this.queue.push(res.message);
    return { ok: true, message: res.message };
  }

  /** Deliver queued messages (including ones sent by handlers) until the queue is empty. */
  async drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      try {
        for (let m = this.queue.shift(); m; m = this.queue.shift()) {
          const h = this.handlers.get(m.receiver_id);
          if (!h) continue;
          try {
            await h(m, this);
          } catch (err) {
            this.deliveryErrors.push({ message: m, error: (err as Error).message });
          }
        }
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }
}
