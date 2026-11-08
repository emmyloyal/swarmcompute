/**
 * Coalition Formation Agent (spec Sections 5, 6, 10).
 *
 * Collects BUYER_REQUIREMENT and SELLER_AVAILABILITY, runs deterministic
 * formation rounds, sends BUYER_DISCOVERY + COALITION_PROPOSAL to members, and
 * tracks acceptances. A coalition becomes ACTIVE once every remaining member
 * accepted. Rejections and leaves (allowed only before FUNDED) re-validate the
 * coalition; below its minimum it FAILS. A buyer who rejected or left is not
 * regrouped until it publishes a new requirement, so rounds can't loop.
 *
 * On-chain registration and the auction start are done by the auction engine
 * (Phase 5) through the `onActive` / `onChanged` / `onFailed` hooks and
 * `requestAuction`.
 */
import {
  createMessage,
  nearToYocto,
  SYSTEM_AGENTS,
  type AgentMessage,
  type GpuModel,
  type PayloadOf,
} from "@swarmcompute/shared";
import { formCoalitions, revalidate, type FormationResult, type Offer, type PlannedCoalition, type Requirement } from "../coalition/form.js";
import type { MessageBus } from "../messaging/bus.js";

export type CoalitionStatus = "PROPOSED" | "ACTIVE" | "FUNDED" | "CLOSED" | "FAILED";
export type MemberStatus = "PROPOSED" | "ACCEPTED" | "REJECTED" | "LEFT";

export interface TrackedCoalition {
  plan: PlannedCoalition;
  status: CoalitionStatus;
  members: Map<string, MemberStatus>;
  failureReason?: string;
}

/** Persistence port (Postgres in production, no-op in unit tests). */
export interface CoalitionStore {
  saveProposed(plan: PlannedCoalition): Promise<void>;
  setMember(coalitionId: string, buyerId: string, status: MemberStatus): Promise<void>;
  setStatus(coalitionId: string, status: CoalitionStatus, plan: PlannedCoalition, failureReason?: string): Promise<void>;
}

export interface CoalitionHooks {
  onActive?(c: TrackedCoalition): Promise<void> | void;
  /** Membership changed while ACTIVE (a member left): on-chain leave in Phase 5. */
  onChanged?(c: TrackedCoalition, buyerId: string): Promise<void> | void;
  onFailed?(c: TrackedCoalition): Promise<void> | void;
}

export interface CoalitionAgentOptions {
  seed: string;
  clock?: () => Date;
  referencePricePerHour?: Record<GpuModel, bigint>;
  minLeadMs?: number;
  store?: CoalitionStore;
  hooks?: CoalitionHooks;
  /** First formation round number (part of coalition IDs). Use a run-unique value across processes. */
  firstRound?: number;
}

/** Public market reference prices (configurable; never seller-private minimums). */
export const DEFAULT_REFERENCE_PRICE: Record<GpuModel, bigint> = {
  A100: nearToYocto("0.0005"),
  H100: nearToYocto("0.0008"),
};

const LIVE: CoalitionStatus[] = ["PROPOSED", "ACTIVE", "FUNDED"];

export class CoalitionAgent {
  readonly id = SYSTEM_AGENTS.COALITION;
  private readonly requirements = new Map<string, Requirement>();
  private readonly offers = new Map<string, Offer>();
  readonly coalitions = new Map<string, TrackedCoalition>();
  private round = 0;
  private readonly clock: () => Date;

  constructor(
    private readonly key: Buffer,
    private readonly opts: CoalitionAgentOptions,
  ) {
    this.clock = opts.clock ?? (() => new Date());
    this.round = opts.firstRound ?? 0;
  }

  get offerList(): Offer[] {
    return [...this.offers.values()];
  }

  /** Buyer IDs currently in a live coalition. */
  private engaged(): Set<string> {
    const s = new Set<string>();
    for (const c of this.coalitions.values()) {
      if (!LIVE.includes(c.status)) continue;
      for (const [b, st] of c.members) if (st === "PROPOSED" || st === "ACCEPTED") s.add(b);
    }
    return s;
  }

  readonly handle = async (msg: AgentMessage, _bus: MessageBus): Promise<void> => {
    switch (msg.type) {
      case "BUYER_REQUIREMENT": {
        const p = (msg as AgentMessage<"BUYER_REQUIREMENT">).payload;
        this.requirements.set(p.buyer_id, {
          buyerId: p.buyer_id,
          gpuModel: p.gpu_model,
          minVramGb: p.min_vram_gb,
          requiredHours: p.required_hours,
          maxBudgetYocto: BigInt(p.max_budget_yocto),
          maxPricePerHourYocto: BigInt(p.max_price_per_hour_yocto),
          latestDeliveryAt: new Date(p.latest_delivery_at),
        });
        return;
      }
      case "SELLER_AVAILABILITY": {
        const p = (msg as AgentMessage<"SELLER_AVAILABILITY">).payload;
        this.offers.set(`${p.seller_id}/${p.gpu_model}/${p.vram_gb}`, {
          sellerId: p.seller_id,
          gpuModel: p.gpu_model,
          vramGb: p.vram_gb,
          capacityHours: p.capacity_hours,
        });
        return;
      }
      case "COALITION_ACCEPTANCE": {
        const p = (msg as AgentMessage<"COALITION_ACCEPTANCE">).payload;
        const c = this.require(p.coalition_id);
        if (c.members.get(p.buyer_id) !== "PROPOSED") throw new Error(`${p.buyer_id} has no pending proposal for ${p.coalition_id}`);
        await this.setMember(c, p.buyer_id, "ACCEPTED");
        return this.maybeActivate(c);
      }
      case "COALITION_REJECTION": {
        const p = (msg as AgentMessage<"COALITION_REJECTION">).payload;
        const c = this.require(p.coalition_id);
        if (c.members.get(p.buyer_id) !== "PROPOSED") throw new Error(`${p.buyer_id} has no pending proposal for ${p.coalition_id}`);
        await this.setMember(c, p.buyer_id, "REJECTED");
        this.requirements.delete(p.buyer_id);
        return this.shrink(c, p.buyer_id);
      }
      case "COALITION_LEAVE": {
        const p = (msg as AgentMessage<"COALITION_LEAVE">).payload;
        const c = this.require(p.coalition_id);
        if (c.status !== "PROPOSED" && c.status !== "ACTIVE") {
          throw new Error(`cannot leave ${p.coalition_id} in status ${c.status} (only before FUNDED)`);
        }
        const st = c.members.get(p.buyer_id);
        if (st !== "PROPOSED" && st !== "ACCEPTED") throw new Error(`${p.buyer_id} is not a member of ${p.coalition_id}`);
        await this.setMember(c, p.buyer_id, "LEFT");
        this.requirements.delete(p.buyer_id);
        return this.shrink(c, p.buyer_id);
      }
      default:
        throw new Error(`coalition agent does not handle ${msg.type}`);
    }
  };

  /** One deterministic formation round over buyers not already in a live coalition. */
  async formRound(bus: MessageBus): Promise<FormationResult> {
    const engaged = this.engaged();
    const pool = [...this.requirements.values()].filter((r) => !engaged.has(r.buyerId));
    const result = formCoalitions({
      seed: this.opts.seed,
      round: this.round++,
      now: this.clock(),
      requirements: pool,
      offers: this.offerList,
      referencePricePerHour: this.opts.referencePricePerHour ?? DEFAULT_REFERENCE_PRICE,
      minLeadMs: this.opts.minLeadMs ?? 2 * 3_600_000,
    });
    for (const plan of result.coalitions) {
      const tracked: TrackedCoalition = {
        plan,
        status: "PROPOSED",
        members: new Map(plan.members.map((m) => [m.buyerId, "PROPOSED" as MemberStatus])),
      };
      this.coalitions.set(plan.coalitionId, tracked);
      await this.opts.store?.saveProposed(plan);
      const ids = plan.members.map((m) => m.buyerId);
      for (const m of plan.members) {
        await bus.send(
          this.msg("BUYER_DISCOVERY", m.buyerId, {
            buyer_id: m.buyerId,
            gpu_model: plan.gpuModel,
            compatible_buyer_ids: ids.filter((x) => x !== m.buyerId),
          }),
        );
        await bus.send(this.msg("COALITION_PROPOSAL", m.buyerId, proposalPayload(plan)));
      }
    }
    return result;
  }

  /**
   * Phase 5 calls this after registering the coalition and opening bidding
   * on-chain, with the on-chain deadlines. Sent to the auction coordinator and
   * to every seller (only the coalition agent may send AUCTION_REQUEST).
   */
  async requestAuction(
    bus: MessageBus,
    coalitionId: string,
    a: { auctionId: string; purchaseId: string; commitDeadline: Date; revealDeadline: Date },
    sellerIds: readonly string[],
  ): Promise<void> {
    const c = this.require(coalitionId);
    if (c.status !== "ACTIVE") throw new Error(`coalition ${coalitionId} is ${c.status}, not ACTIVE`);
    const payload: PayloadOf<"AUCTION_REQUEST"> = {
      auction_id: a.auctionId,
      purchase_id: a.purchaseId,
      coalition_id: coalitionId,
      gpu_model: c.plan.gpuModel,
      min_vram_gb: c.plan.vramGb,
      total_hours: c.plan.totalHours,
      price_ceiling_per_hour_yocto: c.plan.priceCeilingPerHourYocto.toString(),
      total_budget_yocto: c.plan.totalBudgetYocto.toString(),
      commit_deadline: a.commitDeadline.toISOString(),
      reveal_deadline: a.revealDeadline.toISOString(),
    };
    for (const to of [SYSTEM_AGENTS.AUCTION_COORDINATOR, ...sellerIds]) await bus.send(this.msg("AUCTION_REQUEST", to, payload));
  }

  /**
   * System-initiated removal before FUNDED: a member whose simulated
   * contribution approval was negative leaves the coalition. Re-validates like
   * a COALITION_LEAVE. Returns the coalition's status afterwards.
   */
  async removeMember(coalitionId: string, buyerId: string): Promise<CoalitionStatus> {
    const c = this.require(coalitionId);
    if (c.status !== "PROPOSED" && c.status !== "ACTIVE") throw new Error(`cannot remove a member from ${coalitionId} in status ${c.status}`);
    if (c.members.get(buyerId) !== "ACCEPTED" && c.members.get(buyerId) !== "PROPOSED") throw new Error(`${buyerId} is not a member of ${coalitionId}`);
    await this.setMember(c, buyerId, "LEFT");
    this.requirements.delete(buyerId);
    await this.shrinkQuiet(c);
    return c.status;
  }

  /** Like shrink, without the onChanged hook (the caller already handles the on-chain side). */
  private async shrinkQuiet(c: TrackedCoalition): Promise<void> {
    const remaining = c.plan.members.filter((m) => {
      const st = c.members.get(m.buyerId);
      return st === "PROPOSED" || st === "ACCEPTED";
    });
    const v = remaining.length ? revalidate(c.plan, remaining, this.offerList) : ({ ok: false, reason: "no members left" } as const);
    if (!v.ok) {
      c.failureReason = v.reason;
      await this.setStatus(c, "FAILED", v.reason);
      return;
    }
    c.plan = v.coalition;
    await this.setStatus(c, c.status);
  }

  async markFunded(coalitionId: string): Promise<void> {
    const c = this.require(coalitionId);
    if (c.status !== "ACTIVE") throw new Error(`cannot fund coalition in status ${c.status}`);
    await this.setStatus(c, "FUNDED");
  }

  async markClosed(coalitionId: string): Promise<void> {
    await this.setStatus(this.require(coalitionId), "CLOSED");
  }

  /** Auction failed with no eligible bid etc.: the coalition fails, holding no funds. */
  async markFailed(coalitionId: string, reason: string): Promise<void> {
    const c = this.require(coalitionId);
    if (c.status === "FUNDED" || c.status === "CLOSED") throw new Error(`cannot fail coalition in status ${c.status}`);
    c.failureReason = reason;
    await this.setStatus(c, "FAILED", reason);
    for (const [b, st] of c.members) if (st === "ACCEPTED" || st === "PROPOSED") this.requirements.delete(b);
    await this.opts.hooks?.onFailed?.(c);
  }

  private async shrink(c: TrackedCoalition, buyerId: string): Promise<void> {
    const remaining = c.plan.members.filter((m) => {
      const st = c.members.get(m.buyerId);
      return st === "PROPOSED" || st === "ACCEPTED";
    });
    const v = remaining.length ? revalidate(c.plan, remaining, this.offerList) : ({ ok: false, reason: "no members left" } as const);
    if (!v.ok) {
      c.failureReason = v.reason;
      await this.setStatus(c, "FAILED", v.reason);
      // Remaining members go back to the pool for the next round.
      await this.opts.hooks?.onFailed?.(c);
      return;
    }
    c.plan = v.coalition;
    if (c.status === "ACTIVE") {
      await this.setStatus(c, "ACTIVE");
      await this.opts.hooks?.onChanged?.(c, buyerId);
    } else {
      await this.maybeActivate(c);
    }
  }

  private async maybeActivate(c: TrackedCoalition): Promise<void> {
    if (c.status !== "PROPOSED") return;
    const sts = [...c.members.values()].filter((s) => s === "PROPOSED" || s === "ACCEPTED");
    if (sts.length === 0 || sts.some((s) => s === "PROPOSED")) return;
    await this.setStatus(c, "ACTIVE");
    await this.opts.hooks?.onActive?.(c);
  }

  private async setMember(c: TrackedCoalition, buyerId: string, st: MemberStatus): Promise<void> {
    c.members.set(buyerId, st);
    await this.opts.store?.setMember(c.plan.coalitionId, buyerId, st);
  }

  private async setStatus(c: TrackedCoalition, st: CoalitionStatus, reason?: string): Promise<void> {
    c.status = st;
    await this.opts.store?.setStatus(c.plan.coalitionId, st, c.plan, reason);
  }

  private require(id: string): TrackedCoalition {
    const c = this.coalitions.get(id);
    if (!c) throw new Error(`unknown coalition ${id}`);
    return c;
  }

  private msg<T extends Parameters<typeof createMessage>[0]["type"]>(type: T, to: string, payload: PayloadOf<T>): AgentMessage<T> {
    return createMessage({ type, sender_id: this.id, receiver_id: to, payload, timestamp: this.clock().toISOString() }, this.key);
  }
}

export function proposalPayload(plan: PlannedCoalition): PayloadOf<"COALITION_PROPOSAL"> {
  return {
    coalition_id: plan.coalitionId,
    gpu_model: plan.gpuModel,
    vram_gb: plan.vramGb,
    members: plan.members.map((m) => ({
      buyer_id: m.buyerId,
      hours: m.hours,
      max_price_per_hour_yocto: m.maxPricePerHourYocto.toString(),
      max_budget_yocto: m.maxBudgetYocto.toString(),
    })),
    min_members: plan.minMembers,
    total_hours: plan.totalHours,
    price_ceiling_per_hour_yocto: plan.priceCeilingPerHourYocto.toString(),
    total_budget_yocto: plan.totalBudgetYocto.toString(),
    delivery_deadline: plan.deliveryDeadline.toISOString(),
    formation_seed: plan.formationSeed,
  };
}
