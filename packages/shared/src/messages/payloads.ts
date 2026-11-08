/**
 * Payload schemas for every agent message type (Section 11).
 *
 * All objects are `.strict()`: unknown keys are rejected. This is a leak guard —
 * e.g. a BID_COMMITMENT carrying a `price` or `nonce` field fails validation.
 * Money is always a yocto decimal string, never a JSON number.
 */
import { z } from "zod";
import {
  AuctionId,
  BuyerId,
  CoalitionId,
  GpuModel,
  Hex32,
  IsoTimestamp,
  PurchaseId,
  SellerId,
  TestnetAccountId,
  TxHash,
} from "../ids.js";
import { PositiveYoctoString, YoctoString } from "../money.js";

const Hours = z.number().int().min(1).max(100_000);
const VramGb = z.number().int().min(1).max(1024);
const Reason = z.string().min(1).max(500);

/**
 * Zod 3 runs object refinements even when a field already failed validation.
 * Cross-field checks that convert strings to BigInt are wrapped so malformed
 * input is reported as the field-level issue instead of throwing.
 */
function guarded<T>(check: (p: T) => boolean): (p: T) => boolean {
  return (p) => {
    try {
      return check(p);
    } catch {
      return true; // field-level issue already recorded; parse fails anyway
    }
  };
}

// ---------------------------------------------------------------- buyers

export const BuyerRequirementPayload = z
  .object({
    buyer_id: BuyerId,
    gpu_model: GpuModel,
    min_vram_gb: VramGb,
    required_hours: Hours,
    max_budget_yocto: PositiveYoctoString,
    max_price_per_hour_yocto: PositiveYoctoString,
    latest_delivery_at: IsoTimestamp,
  })
  .strict();

/** Coalition agent → buyer: peers found compatible under the hard constraints. */
export const BuyerDiscoveryPayload = z
  .object({
    buyer_id: BuyerId,
    gpu_model: GpuModel,
    compatible_buyer_ids: z.array(BuyerId).max(100),
  })
  .strict()
  .refine((p) => !p.compatible_buyer_ids.includes(p.buyer_id), "buyer cannot be its own peer")
  .refine((p) => new Set(p.compatible_buyer_ids).size === p.compatible_buyer_ids.length, "duplicate peers");

// ---------------------------------------------------------------- coalitions

const CoalitionMember = z
  .object({
    buyer_id: BuyerId,
    hours: Hours,
    max_price_per_hour_yocto: PositiveYoctoString,
    max_budget_yocto: PositiveYoctoString,
  })
  .strict();

export const CoalitionProposalPayload = z
  .object({
    coalition_id: CoalitionId,
    gpu_model: GpuModel,
    vram_gb: VramGb,
    members: z.array(CoalitionMember).min(1).max(20),
    min_members: z.number().int().min(1).max(20),
    total_hours: Hours,
    /** Lowest max_price_per_hour among members (Section 5). */
    price_ceiling_per_hour_yocto: PositiveYoctoString,
    /** Sum of member max budgets. */
    total_budget_yocto: PositiveYoctoString,
    delivery_deadline: IsoTimestamp,
    formation_seed: z.string().min(1).max(128),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.members.length === 0) return;
    try {
      checkCoalitionTotals(p, ctx);
    } catch {
      /* malformed field already reported */
    }
  });

function checkCoalitionTotals(
  p: {
    members: { buyer_id: string; hours: number; max_price_per_hour_yocto: string; max_budget_yocto: string }[];
    min_members: number;
    total_hours: number;
    price_ceiling_per_hour_yocto: string;
    total_budget_yocto: string;
  },
  ctx: z.RefinementCtx,
): void {
  const ids = p.members.map((m) => m.buyer_id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "duplicate members" });
  if (p.members.length < p.min_members)
    ctx.addIssue({ code: "custom", message: "fewer members than min_members" });
  const hours = p.members.reduce((s, m) => s + m.hours, 0);
  if (hours !== p.total_hours) ctx.addIssue({ code: "custom", message: "total_hours != sum of member hours" });
  const ceiling = p.members.reduce(
    (min, m) => (BigInt(m.max_price_per_hour_yocto) < min ? BigInt(m.max_price_per_hour_yocto) : min),
    BigInt(p.members[0]!.max_price_per_hour_yocto),
  );
  if (ceiling !== BigInt(p.price_ceiling_per_hour_yocto))
    ctx.addIssue({ code: "custom", message: "price ceiling != lowest member max price" });
  const budget = p.members.reduce((s, m) => s + BigInt(m.max_budget_yocto), 0n);
  if (budget !== BigInt(p.total_budget_yocto))
    ctx.addIssue({ code: "custom", message: "total_budget != sum of member budgets" });
}

export const CoalitionAcceptancePayload = z
  .object({ coalition_id: CoalitionId, buyer_id: BuyerId })
  .strict();

export const CoalitionRejectionPayload = z
  .object({
    coalition_id: CoalitionId,
    buyer_id: BuyerId,
    reason_code: z.enum(["PRICE_CEILING", "BUDGET", "DEADLINE", "VRAM", "OTHER"]),
    reason: Reason,
  })
  .strict();

export const CoalitionLeavePayload = z
  .object({ coalition_id: CoalitionId, buyer_id: BuyerId, reason: Reason })
  .strict();

// ---------------------------------------------------------------- sellers / auction

/** Public availability. Deliberately excludes the seller's private minimum price. */
export const SellerAvailabilityPayload = z
  .object({
    seller_id: SellerId,
    payout_account: TestnetAccountId,
    gpu_model: GpuModel,
    vram_gb: VramGb,
    capacity_hours: Hours,
    delivery_time_minutes: z.number().int().min(1).max(100_000),
    simulated: z.literal(true),
  })
  .strict();

export const AuctionRequestPayload = z
  .object({
    auction_id: AuctionId,
    purchase_id: PurchaseId,
    coalition_id: CoalitionId,
    gpu_model: GpuModel,
    min_vram_gb: VramGb,
    total_hours: Hours,
    price_ceiling_per_hour_yocto: PositiveYoctoString,
    total_budget_yocto: PositiveYoctoString,
    commit_deadline: IsoTimestamp,
    reveal_deadline: IsoTimestamp,
  })
  .strict()
  .refine((p) => Date.parse(p.commit_deadline) < Date.parse(p.reveal_deadline), "commit_deadline must precede reveal_deadline");

/** Commitment existence only — no price, no nonce (Section 7 confidentiality). */
export const BidCommitmentPayload = z
  .object({
    auction_id: AuctionId,
    seller_id: SellerId,
    commitment_hex: Hex32,
    tx_hash: TxHash,
  })
  .strict();

export const BidRevealPayload = z
  .object({
    auction_id: AuctionId,
    seller_id: SellerId,
    price_per_hour_yocto: PositiveYoctoString,
    nonce_hex: Hex32,
    tx_hash: TxHash,
  })
  .strict();

const Exclusion = z
  .object({
    seller_id: SellerId,
    reason_code: z.enum([
      "NOT_REVEALED",
      "HASH_MISMATCH",
      "GPU_MISMATCH",
      "VRAM_TOO_LOW",
      "INSUFFICIENT_CAPACITY",
      "ABOVE_PRICE_CEILING",
      "ABOVE_BUDGET",
    ]),
  })
  .strict();

export const AuctionResultPayload = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("AWARDED"),
      auction_id: AuctionId,
      purchase_id: PurchaseId,
      coalition_id: CoalitionId,
      winner_seller_id: SellerId,
      winning_price_per_hour_yocto: PositiveYoctoString,
      total_price_yocto: PositiveYoctoString,
      excluded: z.array(Exclusion),
      tx_hash: TxHash,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("FAILED"),
      auction_id: AuctionId,
      purchase_id: PurchaseId,
      coalition_id: CoalitionId,
      excluded: z.array(Exclusion),
      tx_hash: TxHash,
    })
    .strict(),
]);

// ---------------------------------------------------------------- funding / delivery / settlement

/** Simulated buyer decision — explicitly NOT a wallet signature (Section 2). */
export const ContributionApprovalPayload = z
  .object({
    purchase_id: PurchaseId,
    coalition_id: CoalitionId,
    buyer_id: BuyerId,
    hours: Hours,
    contribution_yocto: PositiveYoctoString,
    approved: z.boolean(),
    approval_kind: z.literal("SIMULATED"),
    reason: Reason.optional(),
  })
  .strict();

/**
 * A buyer prepays hours × its OWN max price from its own wallet, before bidding.
 * The contract accepts only that exact amount and only from that wallet.
 */
export const PrepaymentPayload = z
  .object({
    purchase_id: PurchaseId,
    coalition_id: CoalitionId,
    buyer_id: BuyerId,
    wallet: TestnetAccountId,
    hours: Hours,
    max_price_per_hour_yocto: PositiveYoctoString,
    amount_yocto: PositiveYoctoString,
    tx_hash: TxHash,
  })
  .strict()
  .refine(
    guarded((p) => BigInt(p.max_price_per_hour_yocto) * BigInt(p.hours) === BigInt(p.amount_yocto)),
    "prepayment must equal hours × own max price",
  );

/**
 * Sent to EACH member when its purchase is funded at the clearing price. The
 * fairness arithmetic is part of the schema: everyone pays the same rate, and
 * whatever was prepaid above it comes back.
 */
export const FundingConfirmationPayload = z
  .object({
    purchase_id: PurchaseId,
    buyer_id: BuyerId,
    clearing_price_per_hour_yocto: PositiveYoctoString,
    hours: Hours,
    prepaid_yocto: PositiveYoctoString,
    owed_yocto: PositiveYoctoString,
    excess_yocto: YoctoString,
    tx_hash: TxHash,
  })
  .strict()
  .refine(guarded((p) => BigInt(p.clearing_price_per_hour_yocto) * BigInt(p.hours) === BigInt(p.owed_yocto)), "owed must equal hours × clearing price")
  .refine(guarded((p) => BigInt(p.prepaid_yocto) - BigInt(p.owed_yocto) === BigInt(p.excess_yocto)), "excess must equal prepaid − owed");

/** A credited balance actually sent to the buyer's own wallet. */
export const BalanceReturnedPayload = z
  .object({
    buyer_id: BuyerId,
    wallet: TestnetAccountId,
    amount_yocto: PositiveYoctoString,
    tx_hash: TxHash,
  })
  .strict();

export const DeliveryReportPayload = z
  .object({
    purchase_id: PurchaseId,
    seller_id: SellerId,
    outcome: z.enum(["SUCCESS", "FAILURE", "PARTIAL"]),
    required_hours: Hours,
    allocated_hours: z.number().int().min(0).max(100_000),
    started_at: IsoTimestamp,
    finished_at: IsoTimestamp,
    job_log_hash_hex: Hex32,
    simulated: z.literal(true),
    tx_hash: TxHash,
  })
  .strict()
  .refine((p) => Date.parse(p.started_at) <= Date.parse(p.finished_at), "finished before started")
  .refine((p) => p.allocated_hours <= p.required_hours, "allocated > required")
  .refine(
    (p) =>
      (p.outcome === "SUCCESS" && p.allocated_hours === p.required_hours) ||
      (p.outcome === "PARTIAL" && p.allocated_hours > 0 && p.allocated_hours < p.required_hours) ||
      p.outcome === "FAILURE",
    "outcome inconsistent with allocated hours",
  );

export const VerificationResultPayload = z
  .object({
    purchase_id: PurchaseId,
    success: z.boolean(),
    reason: Reason,
    report_hash_hex: Hex32,
    verifier_account: TestnetAccountId,
    simulated_verification: z.literal(true),
    tx_hash: TxHash,
  })
  .strict();

export const SettlementConfirmationPayload = z
  .object({
    purchase_id: PurchaseId,
    seller_id: SellerId,
    payout_account: TestnetAccountId,
    amount_yocto: PositiveYoctoString,
    tx_hash: TxHash,
  })
  .strict();

/** Each member's money from a failed/expired purchase, credited back to that member. */
export const RefundConfirmationPayload = z
  .object({
    purchase_id: PurchaseId,
    total_refund_yocto: PositiveYoctoString,
    per_buyer: z
      .array(z.object({ buyer_id: BuyerId, amount_yocto: YoctoString }).strict())
      .min(1),
    tx_hash: TxHash,
  })
  .strict()
  .refine(
    guarded((p) => p.per_buyer.reduce((s, b) => s + BigInt(b.amount_yocto), 0n) === BigInt(p.total_refund_yocto)),
    "per-buyer refunds must sum to total_refund_yocto",
  );
