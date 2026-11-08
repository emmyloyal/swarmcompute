/**
 * Buyer Agent: a simulated identity with its OWN testnet wallet.
 *
 * Collective buying at one fair price:
 * - publishes its requirement (BUYER_REQUIREMENT);
 * - accepts a coalition proposal only if its own prepayment (hours × its own
 *   max price) fits its remaining budget and the coalition respects its limits;
 * - prepays that amount from its own wallet before bidding (PREPAYMENT);
 * - is charged hours × the clearing price, the same rate as every other member
 *   (FUNDING_CONFIRMATION shows prepaid / owed / excess);
 * - gets its excess, and any refund, sent back to its wallet (BALANCE_RETURNED);
 * - may leave before FUNDED (its prepayment is returned).
 *
 * Decisions are deterministic functions of the profile and messages; no LLM (RULES.md R5).
 */
import { createMessage, mulPriceHours, SYSTEM_AGENTS, type AgentMessage, type PayloadOf } from "@swarmcompute/shared";
import type { MessageBus } from "../messaging/bus.js";
import type { BuyerProfile } from "../sim/profiles.js";

export type MembershipState = "PROPOSED" | "ACCEPTED" | "FUNDED" | "LEFT" | "CLOSED";

export interface Membership {
  coalitionId: string;
  hours: number;
  state: MembershipState;
  purchaseId?: string;
}

export interface FairnessRecord {
  purchaseId: string;
  clearingPricePerHour: bigint;
  hours: number;
  prepaid: bigint;
  owed: bigint;
  excess: bigint;
}

export type ProposalDecision =
  | { accept: true }
  | { accept: false; code: PayloadOf<"COALITION_REJECTION">["reason_code"]; reason: string };

export type PrepayDecision = { prepay: true; amount: bigint } | { prepay: false; reason: string };

type Proposal = PayloadOf<"COALITION_PROPOSAL">;

export class BuyerAgent {
  readonly id: string;
  private readonly memberships = new Map<string, Membership>();
  /** Money of this buyer currently held for live purchases (prepaid, then owed). */
  private readonly committed = new Map<string, bigint>();
  private spentYocto = 0n;
  private chainReserved = 0n;
  /** Per purchase: what this buyer prepaid, owed and got back (from FUNDING_CONFIRMATION). */
  readonly fairness: FairnessRecord[] = [];
  /** Total actually returned to this buyer's wallet (BALANCE_RETURNED). */
  returnedToWallet = 0n;
  readonly discoveredPeers = new Set<string>();

  constructor(
    readonly profile: BuyerProfile,
    private readonly key: Buffer,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.id = profile.agentId;
  }

  /** Load on-chain budget usage from earlier runs (contract get_buyer is authoritative). */
  syncFromChain(reservedYocto: bigint, spentYocto: bigint): void {
    if (reservedYocto < 0n || spentYocto < 0n) throw new Error("negative on-chain amounts");
    this.chainReserved = reservedYocto;
    this.spentYocto = spentYocto;
  }

  remainingBudget(): bigint {
    let c = 0n;
    for (const v of this.committed.values()) c += v;
    return this.profile.maxBudgetYocto - this.spentYocto - this.chainReserved - c;
  }

  membership(coalitionId: string): Membership | undefined {
    const m = this.memberships.get(coalitionId);
    return m && { ...m };
  }

  activeCoalition(): Membership | undefined {
    for (const m of this.memberships.values()) if (m.state === "ACCEPTED" || m.state === "FUNDED") return { ...m };
    return undefined;
  }

  /** What this buyer prepays for `hours`: always its own max price. */
  prepayAmount(hours: number): bigint {
    return mulPriceHours(this.profile.maxPricePerHourYocto, hours);
  }

  requirementMessage(): AgentMessage<"BUYER_REQUIREMENT"> {
    const p = this.profile;
    return this.msg("BUYER_REQUIREMENT", SYSTEM_AGENTS.COALITION, {
      buyer_id: p.buyerId,
      gpu_model: p.gpuModel,
      min_vram_gb: p.minVramGb,
      required_hours: p.requiredHours,
      max_budget_yocto: p.maxBudgetYocto.toString(),
      max_price_per_hour_yocto: p.maxPricePerHourYocto.toString(),
      latest_delivery_at: p.latestDeliveryAt.toISOString(),
    });
  }

  evaluateProposal(prop: Proposal): ProposalDecision {
    const p = this.profile;
    const me = prop.members.find((m) => m.buyer_id === p.buyerId);
    if (!me) return { accept: false, code: "OTHER", reason: "proposal does not include this buyer" };
    const active = this.activeCoalition();
    if (active && active.coalitionId !== prop.coalition_id) return { accept: false, code: "OTHER", reason: `already in coalition ${active.coalitionId}` };
    if (prop.gpu_model !== p.gpuModel) return { accept: false, code: "OTHER", reason: "GPU model mismatch" };
    if (prop.vram_gb < p.minVramGb) return { accept: false, code: "VRAM", reason: `VRAM ${prop.vram_gb} < required ${p.minVramGb}` };
    if (me.hours !== p.requiredHours) return { accept: false, code: "OTHER", reason: "hours do not match requirement" };
    if (BigInt(me.max_price_per_hour_yocto) !== p.maxPricePerHourYocto || BigInt(me.max_budget_yocto) !== p.maxBudgetYocto) {
      return { accept: false, code: "OTHER", reason: "proposal misstates this buyer's limits" };
    }
    if (Date.parse(prop.delivery_deadline) > p.latestDeliveryAt.getTime()) {
      return { accept: false, code: "DEADLINE", reason: "coalition delivery deadline is later than this buyer's" };
    }
    if (BigInt(prop.price_ceiling_per_hour_yocto) > p.maxPricePerHourYocto) {
      return { accept: false, code: "PRICE_CEILING", reason: "coalition price ceiling exceeds this buyer's max price" };
    }
    // The buyer prepays its own max for its hours; that must fit its budget.
    if (this.prepayAmount(me.hours) > this.remainingBudget()) {
      return { accept: false, code: "BUDGET", reason: "prepayment (hours × own max price) exceeds remaining budget" };
    }
    return { accept: true };
  }

  /** Simulated decision to prepay; the prepayment itself is a real tx from this buyer's wallet. */
  decidePrepay(hours: number): PrepayDecision {
    const amount = this.prepayAmount(hours);
    if (amount > this.remainingBudget()) return { prepay: false, reason: "prepayment exceeds remaining budget" };
    return { prepay: true, amount };
  }

  /** Record a confirmed on-chain prepayment and build the PREPAYMENT message. */
  prepaid(coalitionId: string, purchaseId: string, hours: number, txHash: string): AgentMessage<"PREPAYMENT"> {
    const m = this.memberships.get(coalitionId);
    if (!m) throw new Error(`${this.id} is not in ${coalitionId}`);
    const amount = this.prepayAmount(hours);
    m.purchaseId = purchaseId;
    this.committed.set(purchaseId, amount);
    return this.msg("PREPAYMENT", SYSTEM_AGENTS.TREASURY, {
      purchase_id: purchaseId,
      coalition_id: coalitionId,
      buyer_id: this.id,
      wallet: this.profile.wallet,
      hours,
      max_price_per_hour_yocto: this.profile.maxPricePerHourYocto.toString(),
      amount_yocto: amount.toString(),
      tx_hash: txHash,
    });
  }

  /** COALITION_LEAVE, allowed only before FUNDED (spec Section 5). */
  leaveMessage(coalitionId: string, reason: string): AgentMessage<"COALITION_LEAVE"> {
    const m = this.memberships.get(coalitionId);
    if (!m || (m.state !== "ACCEPTED" && m.state !== "PROPOSED")) {
      throw new Error(`${this.id} cannot leave ${coalitionId} in state ${m?.state ?? "NOT_MEMBER"}`);
    }
    const msg = this.msg("COALITION_LEAVE", SYSTEM_AGENTS.COALITION, { coalition_id: coalitionId, buyer_id: this.id, reason });
    this.markLeft(coalitionId);
    return msg;
  }

  /** Left (or was removed) before funding: any prepayment is credited back on-chain. */
  markLeft(coalitionId: string): void {
    const m = this.memberships.get(coalitionId);
    if (!m) return;
    m.state = "LEFT";
    if (m.purchaseId) this.committed.delete(m.purchaseId);
  }

  readonly handle = async (msg: AgentMessage, bus: MessageBus): Promise<void> => {
    switch (msg.type) {
      case "BUYER_DISCOVERY":
        for (const b of (msg as AgentMessage<"BUYER_DISCOVERY">).payload.compatible_buyer_ids) this.discoveredPeers.add(b);
        return;
      case "COALITION_PROPOSAL":
        return this.onProposal(msg as AgentMessage<"COALITION_PROPOSAL">, bus);
      case "AUCTION_RESULT": {
        const r = (msg as AgentMessage<"AUCTION_RESULT">).payload;
        const m = this.memberships.get(r.coalition_id);
        if (m) m.purchaseId = r.purchase_id;
        return;
      }
      case "FUNDING_CONFIRMATION": {
        const f = (msg as AgentMessage<"FUNDING_CONFIRMATION">).payload;
        if (f.buyer_id !== this.id) throw new Error(`${this.id} received ${f.buyer_id}'s funding confirmation`);
        // Escrow now holds only what this buyer owes at the clearing price; the excess is coming back.
        this.committed.set(f.purchase_id, BigInt(f.owed_yocto));
        this.fairness.push({
          purchaseId: f.purchase_id,
          clearingPricePerHour: BigInt(f.clearing_price_per_hour_yocto),
          hours: f.hours,
          prepaid: BigInt(f.prepaid_yocto),
          owed: BigInt(f.owed_yocto),
          excess: BigInt(f.excess_yocto),
        });
        const m = this.byPurchase(f.purchase_id);
        if (m && m.state === "ACCEPTED") m.state = "FUNDED";
        return;
      }
      case "BALANCE_RETURNED":
        this.returnedToWallet += BigInt((msg as AgentMessage<"BALANCE_RETURNED">).payload.amount_yocto);
        return;
      case "SETTLEMENT_CONFIRMATION": {
        const pid = (msg as AgentMessage<"SETTLEMENT_CONFIRMATION">).payload.purchase_id;
        const amount = this.committed.get(pid);
        if (amount !== undefined) {
          this.spentYocto += amount;
          this.committed.delete(pid);
        }
        const m = this.byPurchase(pid);
        if (m) m.state = "CLOSED";
        return;
      }
      case "REFUND_CONFIRMATION": {
        const pid = (msg as AgentMessage<"REFUND_CONFIRMATION">).payload.purchase_id;
        this.committed.delete(pid);
        const m = this.byPurchase(pid);
        if (m) m.state = "CLOSED";
        return;
      }
      default:
        throw new Error(`${this.id} does not handle ${msg.type}`);
    }
  };

  private async onProposal(msg: AgentMessage<"COALITION_PROPOSAL">, bus: MessageBus): Promise<void> {
    const prop = msg.payload;
    const d = this.evaluateProposal(prop);
    if (d.accept) {
      const me = prop.members.find((m) => m.buyer_id === this.id)!;
      this.memberships.set(prop.coalition_id, { coalitionId: prop.coalition_id, hours: me.hours, state: "ACCEPTED" });
      await bus.send(this.msg("COALITION_ACCEPTANCE", msg.sender_id, { coalition_id: prop.coalition_id, buyer_id: this.id }));
    } else {
      await bus.send(this.msg("COALITION_REJECTION", msg.sender_id, { coalition_id: prop.coalition_id, buyer_id: this.id, reason_code: d.code, reason: d.reason }));
    }
  }

  private byPurchase(purchaseId: string): Membership | undefined {
    for (const m of this.memberships.values()) if (m.purchaseId === purchaseId) return m;
    return undefined;
  }

  private msg<T extends Parameters<typeof createMessage>[0]["type"]>(type: T, to: string, payload: PayloadOf<T>): AgentMessage<T> {
    return createMessage({ type, sender_id: this.id, receiver_id: to, payload, timestamp: this.clock().toISOString() }, this.key);
  }
}
