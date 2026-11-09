/**
 * Market host: the long-running process that runs every agent whose key it
 * holds, and coordinates rounds (RULES.md R22, R24).
 *
 * Each tick:
 *   1. read agents and purchases from the contract (the contract is authoritative, R15);
 *   2. advance every live purchase one step, from its on-chain state:
 *        CREATED     buyer agents prepay (own key); one that can't afford it is removed;
 *                    bidding opens once every member prepaid; expire after the deadline
 *        BIDDING     seller agents commit (own key), then reveal; then close
 *        FUNDED …    simulated delivery and verification (R12), payout retry, expiry
 *   3. group waiting buyer agents with compatible open requests into coalitions,
 *      but only where at least one seller agent's on-chain terms let it bid.
 *
 * Every step is derived from chain state, so a restart picks up where it left
 * off. Nothing here invents activity: with no seller able to serve a request,
 * the request just waits (R25).
 */
import { createHash, randomBytes } from "node:crypto";
import { computeCommitment, type GpuModel } from "@swarmcompute/shared";
import {
  TERMINAL_STATES,
  type ContractBuyer,
  type ContractCoalition,
  type ContractConfig,
  type ContractPurchase,
  type ContractSeller,
  type ContractWindows,
  type MarketplaceContract,
} from "../chain/marketplace.js";
import type { TxResult } from "../chain/types.js";
import { formCoalitions, type Offer, type Requirement } from "../coalition/form.js";
import type { BidVault } from "../crypto/bid-vault.js";
import { planBid, type BidStore } from "./bids.js";

export interface AgentKeys {
  keyFor(agentId: string): Promise<string | null>;
}

export interface ActivityEntry {
  level: "INFO" | "WARN" | "ERROR";
  kind: string;
  message: string;
  purchaseId?: string;
  agentId?: string;
  txHash?: string;
  simulated?: boolean;
}

export interface ActivitySink {
  add(e: ActivityEntry): Promise<void>;
}

export type WaitReason =
  | "NOT_HOSTED"
  | "INSUFFICIENT_BALANCE"
  | "DEADLINE_TOO_SOON"
  | "RETRY_COOLDOWN"
  | "NO_SELLER_FOR_SPEC"
  | "EXCEEDS_CAPACITY"
  | "PRICE_BELOW_MARKET"
  | "NO_SELLER_AT_PRICE";

export interface MarketSnapshot {
  updatedAt: string;
  chainTimeNs: string;
  tick: number;
  config: ContractConfig | null;
  buyers: ContractBuyer[];
  sellers: ContractSeller[];
  /** Live purchases, then the most recent finished ones. */
  purchases: ContractPurchase[];
  coalitions: Record<string, ContractCoalition>;
  /** Why each open request isn't in a coalition yet. */
  waiting: Record<string, WaitReason>;
  /** Agents this host holds keys for (it acts for them). */
  hosted: string[];
  lastError: string | null;
}

export interface HostOptions {
  contract: MarketplaceContract;
  keys: AgentKeys;
  bids: BidStore;
  vault: BidVault;
  windows: ContractWindows;
  retryCooldownSecs: number;
  activity?: ActivitySink;
  log?: (line: string) => void;
  nonce?: () => Buffer;
  /** How many finished purchases to keep in the snapshot. */
  recentFinished?: number;
}

const NS = 1_000_000_000n;
const COMMIT_MARGIN_NS = 5n * NS;
const nsToDate = (ns: bigint | string) => new Date(Number(BigInt(ns) / 1_000_000n));
const short = (id: string) => id.split(".")[0];

export class MarketHost {
  private scanned = 0;
  private readonly purchases = new Map<string, ContractPurchase>();
  private readonly coalitions = new Map<string, ContractCoalition>();
  private readonly live = new Set<string>();
  private readonly finishedOrder: string[] = [];
  /** buyer → when it may be regrouped after a failed attempt, and the seller market it failed against. */
  private readonly cooldown = new Map<string, { untilNs: bigint; sellers: string }>();
  private tickNo = 0;
  private snap: MarketSnapshot = {
    updatedAt: new Date(0).toISOString(),
    chainTimeNs: "0",
    tick: 0,
    config: null,
    buyers: [],
    sellers: [],
    purchases: [],
    coalitions: {},
    waiting: {},
    hosted: [],
    lastError: null,
  };

  constructor(private readonly o: HostOptions) {}

  private get c() {
    return this.o.contract;
  }

  snapshot(): MarketSnapshot {
    return this.snap;
  }

  private async note(e: ActivityEntry): Promise<void> {
    this.o.log?.(`[${e.level}] ${e.kind}${e.purchaseId ? ` ${e.purchaseId}` : ""}: ${e.message}${e.txHash ? ` (${e.txHash})` : ""}`);
    await this.o.activity?.add(e).catch(() => undefined);
  }

  private async tx(kind: string, message: string, ctx: { purchaseId?: string; agentId?: string; simulated?: boolean }, send: () => Promise<TxResult>): Promise<TxResult | null> {
    try {
      const r = await send();
      await this.note({ level: r.ok ? "INFO" : "WARN", kind, message, txHash: r.txHash, ...ctx });
      return r;
    } catch (err) {
      const msg = (err as Error).message;
      await this.note({ level: "ERROR", kind, message: `${message} failed: ${msg.slice(0, 300)}`, txHash: (err as { result?: TxResult }).result?.txHash, ...ctx });
      return null;
    }
  }

  async tick(): Promise<MarketSnapshot> {
    this.tickNo++;
    let lastError: string | null = null;
    const now = await this.c.blockTimestampNs();
    let [buyers, sellers] = await Promise.all([this.c.listBuyers(), this.c.listSellers()]);
    await this.scanPurchases();

    const byBuyer = () => new Map(buyers.map((b) => [b.buyer_id, b]));
    let bm = byBuyer();
    for (const id of [...this.live]) {
      try {
        await this.advance(id, now, bm, sellers);
      } catch (err) {
        lastError = (err as Error).message;
        await this.note({ level: "ERROR", kind: "host", message: `advancing ${id}: ${lastError.slice(0, 300)}`, purchaseId: id });
      }
    }

    // Membership and balances may have changed while advancing.
    [buyers, sellers] = await Promise.all([this.c.listBuyers(), this.c.listSellers()]);
    bm = byBuyer();
    let waiting: Record<string, WaitReason> = {};
    try {
      waiting = await this.form(now, buyers, sellers);
    } catch (err) {
      lastError = (err as Error).message;
      await this.note({ level: "ERROR", kind: "host", message: `forming coalitions: ${lastError.slice(0, 300)}` });
    }
    if (this.live.size) [buyers] = await Promise.all([this.c.listBuyers()]);

    const hosted: string[] = [];
    for (const a of [...buyers.map((b) => b.buyer_id), ...sellers.map((s) => s.seller_id)]) if (await this.o.keys.keyFor(a)) hosted.push(a);
    const recent = this.finishedOrder.slice(-(this.o.recentFinished ?? 50)).reverse();
    this.snap = {
      updatedAt: new Date().toISOString(),
      chainTimeNs: now.toString(),
      tick: this.tickNo,
      config: await this.c.getConfig().catch(() => this.snap.config),
      buyers,
      sellers,
      purchases: [...[...this.live].reverse(), ...recent].map((id) => this.purchases.get(id)!).filter(Boolean),
      coalitions: Object.fromEntries(this.coalitions),
      waiting,
      hosted,
      lastError,
    };
    return this.snap;
  }

  /** Pick up purchases created since the last scan (by this host or anyone else). */
  private async scanPurchases(): Promise<void> {
    for (;;) {
      const ids = await this.c.listPurchaseIds(this.scanned, 100);
      for (const id of ids) {
        const p = await this.c.getPurchase(id);
        if (!p) continue;
        this.purchases.set(id, p);
        await this.loadCoalition(p.coalition_id);
        if (TERMINAL_STATES.includes(p.state)) this.finishedOrder.push(id);
        else this.live.add(id);
      }
      this.scanned += ids.length;
      if (ids.length < 100) return;
    }
  }

  private async loadCoalition(id: string): Promise<ContractCoalition> {
    const c = await this.c.getCoalition(id);
    if (!c) throw new Error(`coalition ${id} not found`);
    this.coalitions.set(id, c);
    return c;
  }

  private async refresh(id: string): Promise<ContractPurchase> {
    const p = await this.c.getPurchase(id);
    if (!p) throw new Error(`purchase ${id} not found`);
    this.purchases.set(id, p);
    return p;
  }

  private async finish(p: ContractPurchase, sellers: ContractSeller[]): Promise<void> {
    this.live.delete(p.purchase_id);
    this.finishedOrder.push(p.purchase_id);
    const c = await this.loadCoalition(p.coalition_id);
    if (p.state !== "COMPLETED") {
      // Don't regroup the same buyers against the same sellers straight away.
      const fp = sellerFingerprint(sellers);
      const until = (await this.c.blockTimestampNs()) + BigInt(this.o.retryCooldownSecs) * NS;
      for (const id of new Set([...c.members.map((m) => m.buyer_id), ...p.allocations.map((a) => a.buyer_id)])) this.cooldown.set(id, { untilNs: until, sellers: fp });
    }
    const outcome =
      p.state === "COMPLETED"
        ? `completed: ${short(p.winner_seller_id!)} paid at ${p.clearing_price_per_hour} yocto/h`
        : `${p.state.toLowerCase()}: every member's money is back in its available balance`;
    await this.note({ level: "INFO", kind: "purchase_finished", message: outcome, purchaseId: p.purchase_id });
  }

  private async advance(id: string, now: bigint, buyers: Map<string, ContractBuyer>, sellers: ContractSeller[]): Promise<void> {
    let p = await this.refresh(id);
    if (TERMINAL_STATES.includes(p.state)) return this.finish(p, sellers);
    const pid = p.purchase_id;

    switch (p.state) {
      case "CREATED": {
        if (now >= BigInt(p.prepay_deadline)) {
          await this.tx("expire", "prepay deadline passed", { purchaseId: pid }, () => this.c.expire(pid));
          break;
        }
        let c = await this.loadCoalition(p.coalition_id);
        const pending = c.members.filter((m) => !p.allocations.some((a) => a.buyer_id === m.buyer_id));
        await Promise.all(
          pending.map(async (m) => {
            const key = await this.o.keys.keyFor(m.buyer_id);
            if (!key) return; // an agent its owner runs: it prepays itself
            const b = buyers.get(m.buyer_id);
            const amount = BigInt(m.max_price_per_hour) * BigInt(m.hours);
            if (b && BigInt(b.available) >= amount) {
              await this.tx("prepay", `${short(m.buyer_id)} reserves ${amount} yocto (hours × own max)`, { purchaseId: pid, agentId: m.buyer_id }, () => this.c.prepay(key, pid, m.buyer_id));
            }
          }),
        );
        // Members that still can't cover their prepayment are removed (operator), so the rest can proceed.
        p = await this.refresh(id);
        c = await this.loadCoalition(p.coalition_id);
        for (const m of c.members) {
          if (p.allocations.some((a) => a.buyer_id === m.buyer_id)) continue;
          const b = buyers.get(m.buyer_id);
          if (!(await this.o.keys.keyFor(m.buyer_id))) continue;
          if (b && BigInt(b.available) >= BigInt(m.max_price_per_hour) * BigInt(m.hours)) continue;
          await this.tx("leave_coalition", `${short(m.buyer_id)} can't cover its prepayment`, { purchaseId: pid, agentId: m.buyer_id }, () => this.c.leaveCoalition(c.coalition_id, m.buyer_id, pid));
        }
        p = await this.refresh(id);
        c = await this.loadCoalition(p.coalition_id);
        if (p.state === "CREATED" && c.members.length > 0 && c.members.every((m) => p.allocations.some((a) => a.buyer_id === m.buyer_id))) {
          await this.tx("open_bidding", `all ${c.members.length} member(s) prepaid; sealed bidding opens`, { purchaseId: pid }, () => this.c.openBidding(pid));
        }
        break;
      }

      case "BIDDING": {
        const c = await this.loadCoalition(p.coalition_id);
        if (now + COMMIT_MARGIN_NS < BigInt(p.commit_deadline!)) await this.commitBids(p, c, sellers);
        else if (now >= BigInt(p.commit_deadline!) && now < BigInt(p.reveal_deadline!)) await this.revealBids(p);
        else if (now >= BigInt(p.reveal_deadline!)) {
          await this.tx("close_auction", "reveal phase over: lowest eligible bid sets one price for every member", { purchaseId: pid }, () => this.c.closeAuction(pid));
        }
        break;
      }

      case "FUNDED":
      case "DELIVERING": {
        if (now >= BigInt(p.delivery_deadline!)) {
          await this.tx("expire", "delivery deadline passed", { purchaseId: pid }, () => this.c.expire(pid));
        } else if (p.state === "FUNDED") {
          await this.tx("start_delivery", `simulated delivery by ${short(p.winner_seller_id!)} starts`, { purchaseId: pid, simulated: true }, () => this.c.startDelivery(pid));
        } else {
          const c = this.coalitions.get(p.coalition_id)!;
          const hours = c.members.reduce((s, m) => s + m.hours, 0);
          const report = `SIMULATED delivery - no real compute ran\npurchase=${pid} seller=${p.winner_seller_id} gpu=${c.gpu_model}/${c.vram_gb}GB hours=${hours}\n`;
          const hash = createHash("sha256").update(report).digest("hex");
          await this.tx("submit_delivery_report", `simulated report: ${hours} h delivered`, { purchaseId: pid, simulated: true }, () => this.c.submitDeliveryReport(pid, hash));
        }
        break;
      }

      case "VERIFYING": {
        if (p.verified_success === null) {
          if (now >= BigInt(p.verification_deadline!)) {
            await this.tx("expire", "verification deadline passed", { purchaseId: pid }, () => this.c.expire(pid));
          } else {
            await this.tx("verify", "simulated verification: all hours delivered; escrow pays the seller's owner", { purchaseId: pid, simulated: true }, () =>
              this.c.verify(pid, true, "simulated delivery: all hours delivered"),
            );
          }
        } else if (p.verified_success && !p.payout_in_flight) {
          await this.tx("payout", "retrying the payout to the seller's owner", { purchaseId: pid }, () => this.c.payout(pid));
        }
        break;
      }
    }

    p = await this.refresh(id);
    if (TERMINAL_STATES.includes(p.state)) await this.finish(p, sellers);
  }

  /** Every seller agent we run bids by its owner's strategy, with its own key. */
  private async commitBids(p: ContractPurchase, c: ContractCoalition, sellers: ContractSeller[]): Promise<void> {
    await Promise.all(
      sellers.map(async (s) => {
        if (p.bids.some((b) => b.seller_id === s.seller_id)) return;
        const plan = planBid(s, c);
        if (!plan.bid) return;
        const key = await this.o.keys.keyFor(s.seller_id);
        if (!key) return;
        let stored = await this.o.bids.get(p.purchase_id, s.seller_id);
        if (!stored) {
          const nonce = (this.o.nonce ?? (() => randomBytes(32)))();
          const commitmentHex = computeCommitment({ auctionId: p.auction_id, sellerId: s.seller_id, pricePerHourYocto: plan.pricePerHour, nonce });
          stored = { auctionId: p.auction_id, commitmentHex, sealed: this.o.vault.seal(p.auction_id, s.seller_id, plan.pricePerHour, nonce) };
          nonce.fill(0);
          // Saved before the commit is sent, so it can always be revealed.
          await this.o.bids.save(p.purchase_id, s.seller_id, stored);
        }
        const r = await this.tx("commit_bid", `${short(s.seller_id)} commits a sealed bid`, { purchaseId: p.purchase_id, agentId: s.seller_id }, () =>
          this.c.commitBid(key, p.purchase_id, s.seller_id, stored!.commitmentHex),
        );
        if (r?.ok) await this.o.bids.committed(p.purchase_id, s.seller_id, r.txHash);
      }),
    );
  }

  private async revealBids(p: ContractPurchase): Promise<void> {
    await Promise.all(
      p.bids
        .filter((b) => b.revealed_price_per_hour === null)
        .map(async (b) => {
          const key = await this.o.keys.keyFor(b.seller_id);
          const stored = await this.o.bids.get(p.purchase_id, b.seller_id);
          if (!key || !stored) return;
          const { pricePerHourYocto, nonce } = this.o.vault.open(stored.auctionId, b.seller_id, stored.sealed);
          const r = await this.tx("reveal_bid", `${short(b.seller_id)} reveals ${pricePerHourYocto} yocto/h`, { purchaseId: p.purchase_id, agentId: b.seller_id }, () =>
            this.c.revealBid(key, p.purchase_id, b.seller_id, pricePerHourYocto, nonce.toString("hex")),
          );
          nonce.fill(0);
          if (r?.ok) await this.o.bids.revealed(p.purchase_id, b.seller_id, r.txHash);
        }),
    );
  }

  /** Group waiting buyer agents; returns why each open request is still waiting. */
  private async form(now: bigint, buyers: ContractBuyer[], sellers: ContractSeller[]): Promise<Record<string, WaitReason>> {
    const waiting: Record<string, WaitReason> = {};
    const w = this.o.windows;
    const leadSecs = w.prepay_secs + w.commit_secs + w.reveal_secs + w.delivery_secs;
    const fp = sellerFingerprint(sellers);

    // A coalition registered without a purchase (a create that failed): give it one.
    for (const b of buyers) {
      if (!b.coalition_id || [...this.live].some((id) => this.purchases.get(id)?.coalition_id === b.coalition_id)) continue;
      const c = await this.loadCoalition(b.coalition_id);
      if (c.closed || c.live_purchase_id) continue;
      await this.startPurchase(c.coalition_id);
    }

    const candidates: Requirement[] = [];
    for (const b of buyers) {
      const r = b.request;
      if (!b.opened || !r || b.coalition_id) continue;
      if (!(await this.o.keys.keyFor(b.buyer_id))) {
        waiting[b.buyer_id] = "NOT_HOSTED";
        continue;
      }
      const amount = BigInt(r.max_price_per_hour) * BigInt(r.hours);
      if (BigInt(b.available) < amount) {
        waiting[b.buyer_id] = "INSUFFICIENT_BALANCE";
        continue;
      }
      if (BigInt(r.deadline) < now + BigInt(leadSecs) * NS) {
        waiting[b.buyer_id] = "DEADLINE_TOO_SOON";
        continue;
      }
      const cd = this.cooldown.get(b.buyer_id);
      if (cd && now < cd.untilNs && cd.sellers === fp) {
        waiting[b.buyer_id] = "RETRY_COOLDOWN";
        continue;
      }
      candidates.push({
        buyerId: b.buyer_id,
        gpuModel: r.gpu_model,
        minVramGb: r.vram_gb,
        requiredHours: r.hours,
        maxBudgetYocto: amount,
        maxPricePerHourYocto: BigInt(r.max_price_per_hour),
        latestDeliveryAt: nsToDate(r.deadline),
      });
    }
    if (candidates.length === 0) return waiting;

    const active = sellers.filter((s) => s.opened && s.active);
    const offers: Offer[] = active.flatMap((s) => s.offers.map((o) => ({ sellerId: s.seller_id, gpuModel: o.gpu_model, vramGb: o.vram_gb, capacityHours: o.capacity_hours })));
    // A buyer whose max is below every capable seller's minimum would only sink its coalition.
    const reference: Record<GpuModel, bigint> = { A100: 0n, H100: 0n };
    for (const model of Object.keys(reference) as GpuModel[]) {
      const mins = active.filter((s) => s.offers.some((o) => o.gpu_model === model)).map((s) => BigInt(s.min_price_per_hour));
      reference[model] = mins.length ? mins.reduce((a, b) => (a < b ? a : b)) : 0n;
    }
    const nowDate = nsToDate(now);
    const plan = formCoalitions({
      seed: this.c.contractId,
      round: Number(now / NS),
      now: nowDate,
      requirements: candidates,
      offers,
      referencePricePerHour: reference,
      minLeadMs: 0, // deadlines already checked against the full round length, in chain time
    });
    for (const u of plan.unserved) waiting[u.buyerId] = u.reason;

    for (const pc of plan.coalitions) {
      // Only start an auction that at least one seller's own terms let it bid on.
      const hypothetical: ContractCoalition = {
        coalition_id: pc.coalitionId,
        gpu_model: pc.gpuModel,
        vram_gb: pc.vramGb,
        min_members: pc.minMembers,
        members: pc.members.map((m) => ({ buyer_id: m.buyerId, hours: m.hours, max_price_per_hour: m.maxPricePerHourYocto.toString() })),
        closed: false,
        live_purchase_id: null,
      };
      if (!active.some((s) => planBid(s, hypothetical).bid)) {
        for (const m of pc.members) waiting[m.buyerId] = "NO_SELLER_AT_PRICE";
        continue;
      }
      const ids = pc.members.map((m) => m.buyerId);
      const reg = await this.tx(
        "register_coalition",
        `${ids.length} buyer agent(s) grouped: ${pc.gpuModel} ≥${pc.vramGb} GB, ${pc.totalHours} h, ceiling ${pc.priceCeilingPerHourYocto} yocto/h`,
        {},
        () => this.c.registerCoalition(pc.coalitionId, ids, pc.minMembers),
      );
      if (reg?.ok) await this.startPurchase(pc.coalitionId);
    }
    return waiting;
  }

  private async startPurchase(coalitionId: string): Promise<void> {
    const suffix = coalitionId.replace(/^coalition-/, "");
    const purchaseId = `purchase-${suffix}`;
    const r = await this.tx("create_purchase", `round opens for ${coalitionId}: members prepay their own max`, { purchaseId }, () =>
      this.c.createPurchase(purchaseId, `auction-${suffix}`, coalitionId, this.o.windows),
    );
    if (r?.ok) {
      await this.scanPurchases();
    }
  }
}

/** Changes whenever any seller's terms or availability change. */
export function sellerFingerprint(sellers: readonly ContractSeller[]): string {
  const h = createHash("sha256");
  for (const s of [...sellers].sort((a, b) => (a.seller_id < b.seller_id ? -1 : 1))) {
    h.update(JSON.stringify([s.seller_id, s.opened, s.active, s.offers, s.min_price_per_hour, s.strategy]));
  }
  return h.digest("hex");
}
