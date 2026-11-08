/**
 * Message type registry: payload schema, permitted sender kind, and whether the
 * message references a real NEAR transaction that must be RPC-verified before
 * the message may be marked CONFIRMED (Section 11).
 */
import type { z } from "zod";
import type { AgentKind } from "../ids.js";
import * as P from "./payloads.js";

export const MESSAGE_TYPES = [
  "BUYER_REQUIREMENT",
  "BUYER_DISCOVERY",
  "COALITION_PROPOSAL",
  "COALITION_ACCEPTANCE",
  "COALITION_REJECTION",
  "COALITION_LEAVE",
  "SELLER_AVAILABILITY",
  "AUCTION_REQUEST",
  "BID_COMMITMENT",
  "BID_REVEAL",
  "AUCTION_RESULT",
  "CONTRIBUTION_APPROVAL",
  "PREPAYMENT",
  "FUNDING_CONFIRMATION",
  "BALANCE_RETURNED",
  "DELIVERY_REPORT",
  "VERIFICATION_RESULT",
  "SETTLEMENT_CONFIRMATION",
  "REFUND_CONFIRMATION",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

interface TypeSpec {
  payload: z.ZodTypeAny;
  /** Only agents of this kind may send the type. */
  sender: AgentKind;
  /** Payload field that must equal envelope.sender_id (self-assertion guard). */
  senderField?: "buyer_id" | "seller_id";
  /** Carries a real tx hash that the backend must verify via RPC. */
  onChain: boolean;
}

export const MESSAGE_SPECS = {
  BUYER_REQUIREMENT: { payload: P.BuyerRequirementPayload, sender: "BUYER", senderField: "buyer_id", onChain: false },
  BUYER_DISCOVERY: { payload: P.BuyerDiscoveryPayload, sender: "COALITION", onChain: false },
  COALITION_PROPOSAL: { payload: P.CoalitionProposalPayload, sender: "COALITION", onChain: false },
  COALITION_ACCEPTANCE: { payload: P.CoalitionAcceptancePayload, sender: "BUYER", senderField: "buyer_id", onChain: false },
  COALITION_REJECTION: { payload: P.CoalitionRejectionPayload, sender: "BUYER", senderField: "buyer_id", onChain: false },
  COALITION_LEAVE: { payload: P.CoalitionLeavePayload, sender: "BUYER", senderField: "buyer_id", onChain: false },
  SELLER_AVAILABILITY: { payload: P.SellerAvailabilityPayload, sender: "SELLER", senderField: "seller_id", onChain: false },
  AUCTION_REQUEST: { payload: P.AuctionRequestPayload, sender: "COALITION", onChain: false },
  BID_COMMITMENT: { payload: P.BidCommitmentPayload, sender: "SELLER", senderField: "seller_id", onChain: true },
  BID_REVEAL: { payload: P.BidRevealPayload, sender: "SELLER", senderField: "seller_id", onChain: true },
  AUCTION_RESULT: { payload: P.AuctionResultPayload, sender: "AUCTION_COORDINATOR", onChain: true },
  CONTRIBUTION_APPROVAL: { payload: P.ContributionApprovalPayload, sender: "BUYER", senderField: "buyer_id", onChain: false },
  PREPAYMENT: { payload: P.PrepaymentPayload, sender: "BUYER", senderField: "buyer_id", onChain: true },
  FUNDING_CONFIRMATION: { payload: P.FundingConfirmationPayload, sender: "TREASURY", onChain: true },
  BALANCE_RETURNED: { payload: P.BalanceReturnedPayload, sender: "TREASURY", onChain: true },
  DELIVERY_REPORT: { payload: P.DeliveryReportPayload, sender: "SELLER", senderField: "seller_id", onChain: true },
  VERIFICATION_RESULT: { payload: P.VerificationResultPayload, sender: "VERIFICATION", onChain: true },
  SETTLEMENT_CONFIRMATION: { payload: P.SettlementConfirmationPayload, sender: "TREASURY", onChain: true },
  REFUND_CONFIRMATION: { payload: P.RefundConfirmationPayload, sender: "TREASURY", onChain: true },
} as const satisfies Record<MessageType, TypeSpec>;

export type PayloadOf<T extends MessageType> = z.infer<(typeof MESSAGE_SPECS)[T]["payload"]>;

export function specOf(type: MessageType): TypeSpec {
  return MESSAGE_SPECS[type];
}

export function isMessageType(t: unknown): t is MessageType {
  return typeof t === "string" && (MESSAGE_TYPES as readonly string[]).includes(t);
}
