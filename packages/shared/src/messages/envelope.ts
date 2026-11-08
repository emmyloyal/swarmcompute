/**
 * Agent message envelope (Section 11) and the sender-side constructor.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentId, AuctionId, CoalitionId, IsoTimestamp, PurchaseId } from "../ids.js";
import { computeSignature } from "./signing.js";
import { MESSAGE_TYPES, specOf, type MessageType, type PayloadOf } from "./types.js";

/**
 * PENDING   — as sent; the only status a sender may set.
 * CONFIRMED — accepted; for on-chain types, only after the tx hash is verified via RPC.
 * REJECTED  — failed validation, signature, replay or RPC verification.
 */
export const MESSAGE_STATUSES = ["PENDING", "CONFIRMED", "REJECTED"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const CONTEXT_KEYS = ["coalition_id", "auction_id", "purchase_id"] as const;

export const EnvelopeSchema = z
  .object({
    message_id: z.string().uuid(),
    sender_id: AgentId,
    receiver_id: AgentId,
    type: z.enum(MESSAGE_TYPES),
    timestamp: IsoTimestamp,
    coalition_id: CoalitionId.nullable(),
    auction_id: AuctionId.nullable(),
    purchase_id: PurchaseId.nullable(),
    payload: z.unknown(),
    status: z.enum(MESSAGE_STATUSES),
    signature: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type Envelope = z.infer<typeof EnvelopeSchema>;

export type AgentMessage<T extends MessageType = MessageType> = Omit<Envelope, "type" | "payload"> & {
  type: T;
  payload: PayloadOf<T>;
};

export interface CreateMessageArgs<T extends MessageType> {
  type: T;
  sender_id: string;
  receiver_id: string;
  payload: PayloadOf<T>;
  coalition_id?: string | null;
  auction_id?: string | null;
  purchase_id?: string | null;
  /** Overrides for deterministic tests only. */
  message_id?: string;
  timestamp?: string;
}

/**
 * Build and sign a message. Validates the payload first so a sender can never
 * emit something its receiver would reject as malformed. Context IDs default to
 * the matching payload fields.
 */
export function createMessage<T extends MessageType>(args: CreateMessageArgs<T>, senderKey: Buffer): AgentMessage<T> {
  const parsed = specOf(args.type).payload.parse(args.payload) as PayloadOf<T>;
  const p = parsed as Record<string, unknown>;
  const ctx = (k: (typeof CONTEXT_KEYS)[number]): string | null => {
    const explicit = args[k];
    if (explicit !== undefined) return explicit;
    return typeof p[k] === "string" ? (p[k] as string) : null;
  };
  const unsigned = {
    message_id: args.message_id ?? randomUUID(),
    sender_id: args.sender_id,
    receiver_id: args.receiver_id,
    type: args.type,
    timestamp: args.timestamp ?? new Date().toISOString(),
    coalition_id: ctx("coalition_id"),
    auction_id: ctx("auction_id"),
    purchase_id: ctx("purchase_id"),
    payload: parsed,
    status: "PENDING" as const,
  };
  return { ...unsigned, signature: computeSignature(unsigned, senderKey) };
}
