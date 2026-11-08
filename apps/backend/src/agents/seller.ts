/**
 * Seller Agent (spec Sections 4, 6, 7). Simulated behaviour, REAL payout account.
 *
 * - Announces public availability (no private minimum price).
 * - On AUCTION_REQUEST, decides whether and what to bid with its pricing
 *   strategy, seeded per (seed, seller, auction) (RULES.md R16). A bid is never
 *   below the seller's private minimum, never above the coalition's price ceiling,
 *   and never above the coalition's budget for the requested hours.
 * - Seals the bid: fresh 32-byte nonce (cryptographic randomness: it is a
 *   secret, not simulation behaviour), commitment per ARCHITECTURE.md §6, and
 *   price + nonce encrypted at rest (RULES.md R13).
 *
 * The on-chain commit/reveal transactions are submitted by the auction engine
 * (Phase 5), which then builds BID_COMMITMENT / BID_REVEAL with the real tx hash.
 */
import { randomBytes } from "node:crypto";
import {
  computeCommitment,
  createMessage,
  mulPriceHours,
  SYSTEM_AGENTS,
  type AgentMessage,
  type PayloadOf,
} from "@swarmcompute/shared";
import type { BidVault, SealedBid } from "../crypto/bid-vault.js";
import type { MessageBus } from "../messaging/bus.js";
import type { SimulatedDelivery } from "../sim/gpu.js";
import { Prng } from "../sim/prng.js";
import type { GpuOffer, PricingStrategy, SellerProfile } from "../sim/profiles.js";

type AuctionRequest = PayloadOf<"AUCTION_REQUEST">;

export type DeclineReason =
  | "GPU_MISMATCH"
  | "VRAM_TOO_LOW"
  | "INSUFFICIENT_CAPACITY"
  | "MIN_PRICE_ABOVE_LIMIT";

export type BidPlan =
  | { bid: true; pricePerHourYocto: bigint; offer: GpuOffer }
  | { bid: false; reason: DeclineReason };

export interface PendingBid {
  auctionId: string;
  purchaseId: string;
  commitmentHex: string;
  sealed: SealedBid;
}

/**
 * Price within [min, max] by strategy. All integer arithmetic on the span in
 * basis points (RULES.md R3).
 */
export function strategyPrice(strategy: PricingStrategy, min: bigint, max: bigint, rng: Prng): bigint {
  const span = max - min;
  const at = (bps: number) => min + (span * BigInt(bps)) / 10_000n;
  switch (strategy) {
    case "AGGRESSIVE_LOW":
      return at(rng.int(0, 1000)); // 0–10% of the way up from the minimum
    case "PREMIUM_RELIABLE":
      return at(rng.int(9000, 10_000)); // near the ceiling
    case "LIMITED_CAPACITY":
      return at(rng.int(3000, 5000));
    case "FLEXIBLE":
      return at(rng.int(4000, 6000));
    case "RANDOMIZED_COMPETITIVE":
      return rng.bigint(min, max);
  }
}

export class SellerAgent {
  readonly id: string;
  private readonly pending = new Map<string, PendingBid>();
  readonly declined = new Map<string, DeclineReason>();

  constructor(
    readonly profile: SellerProfile,
    private readonly key: Buffer,
    private readonly seed: string,
    private readonly vault: BidVault,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.id = profile.agentId;
  }

  availabilityMessages(to: string = SYSTEM_AGENTS.AUCTION_COORDINATOR): AgentMessage<"SELLER_AVAILABILITY">[] {
    return this.profile.offers.map((o) =>
      this.msg("SELLER_AVAILABILITY", to, {
        seller_id: this.id,
        payout_account: this.profile.payoutAccount,
        gpu_model: o.gpuModel,
        vram_gb: o.vramGb,
        capacity_hours: o.capacityHours,
        delivery_time_minutes: o.deliveryTimeMinutes,
        simulated: true,
      }),
    );
  }

  planBid(req: AuctionRequest): BidPlan {
    const models = this.profile.offers.filter((o) => o.gpuModel === req.gpu_model);
    if (models.length === 0) return { bid: false, reason: "GPU_MISMATCH" };
    const vram = models.filter((o) => o.vramGb >= req.min_vram_gb);
    if (vram.length === 0) return { bid: false, reason: "VRAM_TOO_LOW" };
    const offer = vram.find((o) => o.capacityHours >= req.total_hours);
    if (!offer) return { bid: false, reason: "INSUFFICIENT_CAPACITY" };

    // Highest price that is still eligible on-chain: ≤ ceiling and price × hours ≤ budget.
    const ceiling = BigInt(req.price_ceiling_per_hour_yocto);
    const byBudget = BigInt(req.total_budget_yocto) / BigInt(req.total_hours);
    const max = ceiling < byBudget ? ceiling : byBudget;
    const min = this.profile.minPricePerHourYocto;
    if (min > max) return { bid: false, reason: "MIN_PRICE_ABOVE_LIMIT" };

    const rng = new Prng(this.seed, `bids/${this.id}/${req.auction_id}`);
    let price = strategyPrice(this.profile.strategy, min, max, rng);
    if (price < min) price = min;
    if (price > max) price = max;
    // Invariant re-check (defence in depth; the contract checks again).
    if (mulPriceHours(price, req.total_hours) > BigInt(req.total_budget_yocto)) throw new Error("bid exceeds budget");
    return { bid: true, pricePerHourYocto: price, offer };
  }

  /** Plan + seal. Idempotent per auction: a seller commits at most once (Section 7). */
  prepareBid(req: AuctionRequest): PendingBid | DeclineReason {
    const existing = this.pending.get(req.auction_id);
    if (existing) return existing;
    const plan = this.planBid(req);
    if (!plan.bid) {
      this.declined.set(req.auction_id, plan.reason);
      return plan.reason;
    }
    const nonce = randomBytes(32);
    const commitmentHex = computeCommitment({
      auctionId: req.auction_id,
      sellerId: this.id,
      pricePerHourYocto: plan.pricePerHourYocto,
      nonce,
    });
    const bid: PendingBid = {
      auctionId: req.auction_id,
      purchaseId: req.purchase_id,
      commitmentHex,
      sealed: this.vault.seal(req.auction_id, this.id, plan.pricePerHourYocto, nonce),
    };
    nonce.fill(0);
    this.pending.set(req.auction_id, bid);
    return bid;
  }

  pendingBid(auctionId: string): PendingBid | undefined {
    return this.pending.get(auctionId);
  }

  /** BID_COMMITMENT carries the hash and tx only — never price or nonce. */
  commitmentMessage(auctionId: string, txHash: string): AgentMessage<"BID_COMMITMENT"> {
    const b = this.requirePending(auctionId);
    return this.msg("BID_COMMITMENT", SYSTEM_AGENTS.AUCTION_COORDINATOR, {
      auction_id: auctionId,
      seller_id: this.id,
      commitment_hex: b.commitmentHex,
      tx_hash: txHash,
    });
  }

  /** Opens the sealed bid for the on-chain reveal. */
  revealSecret(auctionId: string): { pricePerHourYocto: bigint; nonceHex: string } {
    const b = this.requirePending(auctionId);
    const { pricePerHourYocto, nonce } = this.vault.open(auctionId, this.id, b.sealed);
    return { pricePerHourYocto, nonceHex: nonce.toString("hex") };
  }

  revealMessage(auctionId: string, txHash: string): AgentMessage<"BID_REVEAL"> {
    const s = this.revealSecret(auctionId);
    return this.msg("BID_REVEAL", SYSTEM_AGENTS.AUCTION_COORDINATOR, {
      auction_id: auctionId,
      seller_id: this.id,
      price_per_hour_yocto: s.pricePerHourYocto.toString(),
      nonce_hex: s.nonceHex,
      tx_hash: txHash,
    });
  }

  /** DELIVERY_REPORT for a simulated delivery whose hash is on-chain in `txHash`. */
  deliveryReportMessage(d: SimulatedDelivery, txHash: string): AgentMessage<"DELIVERY_REPORT"> {
    if (d.sellerId !== this.id) throw new Error(`${this.id} cannot report ${d.sellerId}'s delivery`);
    return this.msg("DELIVERY_REPORT", SYSTEM_AGENTS.VERIFICATION, {
      purchase_id: d.purchaseId,
      seller_id: this.id,
      outcome: d.outcome,
      required_hours: d.requiredHours,
      allocated_hours: d.allocatedHours,
      started_at: d.startedAt.toISOString(),
      finished_at: d.finishedAt.toISOString(),
      job_log_hash_hex: d.jobLogHashHex,
      simulated: true,
      tx_hash: txHash,
    });
  }

  readonly handle = async (msg: AgentMessage, _bus: MessageBus): Promise<void> => {
    if (msg.type !== "AUCTION_REQUEST") throw new Error(`${this.id} does not handle ${msg.type}`);
    this.prepareBid((msg as AgentMessage<"AUCTION_REQUEST">).payload);
  };

  private requirePending(auctionId: string): PendingBid {
    const b = this.pending.get(auctionId);
    if (!b) throw new Error(`${this.id} has no bid for ${auctionId}`);
    return b;
  }

  private msg<T extends Parameters<typeof createMessage>[0]["type"]>(
    type: T,
    to: string,
    payload: PayloadOf<T>,
  ): AgentMessage<T> {
    return createMessage({ type, sender_id: this.id, receiver_id: to, payload, timestamp: this.clock().toISOString() }, this.key);
  }
}
