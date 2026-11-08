/**
 * TEST-ONLY contract double for the engines. Mirrors the contract rules the
 * engines depend on: prepay exactly hours × own max from the buyer's own wallet,
 * deadlines in chain time, commitment verification, eligibility, one clearing
 * price for every member with excess credited back, guarded payouts and
 * withdrawals. Its tx hashes are synthetic and exist only inside tests;
 * production code talks to NEAR Testnet through NearChain (RULES.md R2).
 */
import { createHash } from "node:crypto";
import { mulPriceHours, verifyCommitment, type GpuModel } from "@swarmcompute/shared";
import type { CoalitionMemberInput, ContractBuyer, ContractPurchase, ContractWindows, MarketplaceContract } from "../src/chain/marketplace.js";
import { ChainCallError, type TxResult } from "../src/chain/types.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
type Ev = { event: string; data: Record<string, unknown> };

interface Coal {
  gpuModel: GpuModel;
  vramGb: number;
  min: number;
  members: { buyer_id: string; hours: number; max_price_per_hour: string }[];
}

export class FakeMarketplace implements MarketplaceContract {
  nowNs = 1_800_000_000_000_000_000n;
  height = 1000;
  calls: string[] = [];
  failNext?: string;
  rpcDownFor?: string;
  private n = 0;
  readonly buyers = new Map<string, ContractBuyer>();
  readonly sellers = new Map<string, { payout: string; offers: { gpu_model: GpuModel; vram_gb: number; capacity_hours: number }[] }>();
  readonly coalitions = new Map<string, Coal>();
  readonly purchases = new Map<string, ContractPurchase & { windows: ContractWindows }>();
  /** Accounts that "don't exist": transfers to them fail like a real missing account. */
  readonly missingAccounts = new Set<string>();
  readonly received = new Map<string, bigint>();
  totalEscrowed = 0n;
  totalBalances = 0n;

  advance(secs: number) {
    this.nowNs += BigInt(secs) * 1_000_000_000n;
  }

  private tx(method: string, events: Ev[] = [], transferFailed = false): TxResult {
    if (this.rpcDownFor === method) throw new Error(`RPC unavailable during ${method}`);
    this.calls.push(method);
    this.height++;
    const h = createHash("sha256").update(`${method}${this.n++}`).digest();
    let hash = "";
    for (let i = 0; i < 44; i++) hash += B58[h[i % 32]! % 58];
    return {
      txHash: hash, signerId: "op.testnet", receiverId: "mkt.testnet", method,
      ok: !transferFailed, callSucceeded: true, failedReceipts: transferFailed ? 1 : 0, logs: [],
      events: events.map((e) => ({ standard: "swarmcompute", version: "1.0.0", event: e.event, data: [e.data] })),
      gasBurnt: 1n,
    };
  }
  /** A failed tx changes no state: callers check before mutating. */
  private fail(method: string, msg: string): never {
    this.calls.push(method);
    const r: TxResult = { txHash: "F".repeat(44), signerId: "op.testnet", receiverId: "mkt.testnet", method, ok: false, callSucceeded: false, failedReceipts: 1, logs: [], events: [], gasBurnt: 1n, error: msg };
    throw new ChainCallError(`${method} failed: ${msg}`, r);
  }
  private guard(method: string) {
    if (this.failNext === method) {
      this.failNext = undefined;
      this.fail(method, "forced failure");
    }
  }
  private p(id: string) {
    const p = this.purchases.get(id);
    if (!p) throw new Error("purchase not found");
    return p;
  }
  private credit(p: ContractPurchase, buyerId: string, amount: bigint, reason: string, ev: Ev[]) {
    if (amount === 0n) return;
    const b = this.buyers.get(buyerId)!;
    b.reserved = (BigInt(b.reserved) - amount).toString();
    b.balance = (BigInt(b.balance) + amount).toString();
    p.held = (BigInt(p.held) - amount).toString();
    this.totalEscrowed -= amount;
    this.totalBalances += amount;
    ev.push({ event: "balance_credited", data: { buyer_id: buyerId, purchase_id: p.purchase_id, amount: amount.toString(), reason } });
  }
  private refundAll(p: ContractPurchase, reason: string, ev: Ev[]) {
    const awarded = p.clearing_price_per_hour !== null;
    let total = 0n;
    for (const a of p.allocations) {
      const amt = BigInt(awarded ? a.owed : a.prepaid);
      this.credit(p, a.buyer_id, amt, reason, ev);
      a.refunded = amt.toString();
      total += amt;
    }
    if (total > 0n) {
      ev.push({ event: "refund_succeeded", data: { purchase_id: p.purchase_id, amount: total.toString(), reason, lines: p.allocations.map((a) => ({ buyer_id: a.buyer_id, amount: a.refunded })) } });
      p.state = "REFUNDED";
    }
  }

  async getBuyer(id: string) {
    const b = this.buyers.get(id);
    return b ? { ...b } : null;
  }
  async getSeller(id: string) {
    return this.sellers.get(id) ?? null;
  }
  async getCoalition(id: string) {
    return this.coalitions.get(id) ?? null;
  }
  async getPurchase(id: string) {
    const p = this.purchases.get(id);
    return p ? structuredClone(p) : null;
  }
  async blockTimestampNs() {
    return this.nowNs;
  }

  async registerBuyer(id: string, budget: bigint, wallet: string) {
    this.buyers.set(id, { buyer_id: id, max_budget: budget.toString(), wallet, reserved: "0", spent: "0", balance: "0", withdrawing: "0" });
    return this.tx("register_buyer");
  }
  async registerSeller(id: string, payout: string, offers: { gpu_model: GpuModel; vram_gb: number; capacity_hours: number }[]) {
    this.sellers.set(id, { payout, offers });
    return this.tx("register_seller");
  }
  async registerCoalition(c: { coalitionId: string; gpuModel: GpuModel; vramGb: number; minMembers: number; members: CoalitionMemberInput[] }) {
    if (c.members.some((m) => !this.buyers.has(m.buyer_id))) this.fail("register_coalition", "member is not a registered buyer");
    this.coalitions.set(c.coalitionId, {
      gpuModel: c.gpuModel, vramGb: c.vramGb, min: c.minMembers,
      members: c.members.map((m) => ({ buyer_id: m.buyer_id, hours: m.hours, max_price_per_hour: m.max_price_per_hour.toString() })),
    });
    return this.tx("register_coalition");
  }
  async leaveCoalition(cid: string, buyerId: string) {
    const c = this.coalitions.get(cid)!;
    const ev: Ev[] = [];
    c.members = c.members.filter((m) => m.buyer_id !== buyerId);
    for (const p of this.purchases.values()) {
      if (p.coalition_id !== cid || !["CREATED", "BIDDING"].includes(p.state)) continue;
      const a = p.allocations.find((x) => x.buyer_id === buyerId);
      if (a) {
        p.allocations = p.allocations.filter((x) => x !== a);
        this.credit(p, buyerId, BigInt(a.prepaid), "left_coalition", ev);
      }
      if (c.members.length < c.min) {
        p.state = "FAILED";
        this.refundAll(p, "coalition_failed", ev);
      }
    }
    return this.tx("leave_coalition", ev);
  }
  async createPurchase(pid: string, aid: string, cid: string, windows: ContractWindows) {
    this.purchases.set(pid, {
      purchase_id: pid, auction_id: aid, coalition_id: cid, state: "CREATED", windows,
      prepay_deadline: (this.nowNs + BigInt(windows.prepay_secs) * 1_000_000_000n).toString(),
      commit_deadline: null, reveal_deadline: null, delivery_deadline: null, verification_deadline: null,
      bids: [], winner_seller_id: null, clearing_price_per_hour: null, required_total: null, allocations: [],
      deposited: "0", held: "0", payout_in_flight: false, paid_out: "0", verified_success: null,
    });
    return this.tx("create_purchase");
  }
  async prepay(wallet: string, pid: string, buyerId: string, amount: bigint) {
    this.guard("prepay");
    const p = this.p(pid);
    const b = this.buyers.get(buyerId)!;
    if (p.state !== "CREATED" || this.nowNs >= BigInt(p.prepay_deadline)) this.fail("prepay", "invalid state or prepay deadline passed");
    if (wallet !== b.wallet) this.fail("prepay", "only the buyer's own wallet can prepay");
    if (p.allocations.some((a) => a.buyer_id === buyerId)) this.fail("prepay", "already prepaid");
    const m = this.coalitions.get(p.coalition_id)!.members.find((x) => x.buyer_id === buyerId);
    if (!m) this.fail("prepay", "not a member");
    const expected = mulPriceHours(BigInt(m.max_price_per_hour), m.hours);
    if (amount !== expected) this.fail("prepay", "attached deposit must equal hours × own max price exactly");
    if (BigInt(b.reserved) + BigInt(b.spent) + amount > BigInt(b.max_budget)) this.fail("prepay", "prepayment exceeds buyer's remaining budget");
    b.reserved = (BigInt(b.reserved) + amount).toString();
    p.allocations.push({ buyer_id: buyerId, hours: m.hours, max_price_per_hour: m.max_price_per_hour, prepaid: amount.toString(), owed: "0", excess: "0", refunded: "0" });
    p.deposited = (BigInt(p.deposited) + amount).toString();
    p.held = (BigInt(p.held) + amount).toString();
    this.totalEscrowed += amount;
    return this.tx("prepay", [{ event: "prepaid", data: { purchase_id: pid, buyer_id: buyerId, amount: amount.toString() } }]);
  }
  async openBidding(pid: string) {
    const p = this.p(pid);
    if (p.state !== "CREATED") this.fail("open_bidding", "invalid state");
    const c = this.coalitions.get(p.coalition_id)!;
    if (!c.members.every((m) => p.allocations.some((a) => a.buyer_id === m.buyer_id))) this.fail("open_bidding", "every member must prepay before bidding opens");
    const cd = this.nowNs + BigInt(p.windows.commit_secs) * 1_000_000_000n;
    p.commit_deadline = cd.toString();
    p.reveal_deadline = (cd + BigInt(p.windows.reveal_secs) * 1_000_000_000n).toString();
    p.state = "BIDDING";
    return this.tx("open_bidding");
  }
  async commitBid(pid: string, sellerId: string, commitmentHex: string) {
    const p = this.p(pid);
    if (p.state !== "BIDDING" || this.nowNs >= BigInt(p.commit_deadline!)) this.fail("commit_bid", "commit phase is over");
    if (p.bids.some((b) => b.seller_id === sellerId)) this.fail("commit_bid", "seller already committed");
    p.bids.push({ seller_id: sellerId, commitment_hex: commitmentHex, commit_block_height: String(this.height), revealed_price_per_hour: null, eligible: null, ineligibility_reason: null });
    return this.tx("commit_bid");
  }
  async revealBid(pid: string, sellerId: string, price: bigint, nonceHex: string) {
    const p = this.p(pid);
    if (this.nowNs < BigInt(p.commit_deadline!)) this.fail("reveal_bid", "reveal phase has not started");
    if (this.nowNs >= BigInt(p.reveal_deadline!)) this.fail("reveal_bid", "reveal phase is over");
    const b = p.bids.find((x) => x.seller_id === sellerId)!;
    if (!verifyCommitment(b.commitment_hex, { auctionId: p.auction_id, sellerId, pricePerHourYocto: price, nonce: Buffer.from(nonceHex, "hex") })) this.fail("reveal_bid", "commitment mismatch");
    b.revealed_price_per_hour = price.toString();
    return this.tx("reveal_bid");
  }
  async closeAuction(pid: string) {
    this.guard("close_auction");
    const p = this.p(pid);
    if (this.nowNs < BigInt(p.reveal_deadline!)) this.fail("close_auction", "reveal phase is not over");
    const c = this.coalitions.get(p.coalition_id)!;
    const hours = c.members.reduce((s, m) => s + m.hours, 0);
    const ceiling = c.members.reduce((min, m) => (BigInt(m.max_price_per_hour) < min ? BigInt(m.max_price_per_hour) : min), BigInt(c.members[0]!.max_price_per_hour));
    const ok: { id: string; price: bigint }[] = [];
    for (const b of p.bids) {
      if (b.revealed_price_per_hour === null) {
        b.eligible = false;
        b.ineligibility_reason = "NOT_REVEALED";
        continue;
      }
      const price = BigInt(b.revealed_price_per_hour);
      const reason = price > ceiling ? "ABOVE_PRICE_CEILING" : null;
      b.eligible = reason === null;
      b.ineligibility_reason = reason;
      if (!reason) ok.push({ id: b.seller_id, price });
    }
    ok.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.id < b.id ? -1 : 1));
    const ev: Ev[] = [];
    if (ok.length === 0) {
      p.state = "FAILED";
      this.refundAll(p, "no_eligible_bid", ev);
      return this.tx("close_auction", ev);
    }
    const price = ok[0]!.price;
    let total = 0n;
    const members: Record<string, string | number>[] = [];
    for (const a of p.allocations) {
      const owed = mulPriceHours(price, a.hours);
      const excess = BigInt(a.prepaid) - owed;
      a.owed = owed.toString();
      a.excess = excess.toString();
      total += owed;
      members.push({ buyer_id: a.buyer_id, hours: a.hours, prepaid: a.prepaid, owed: a.owed, excess: a.excess });
    }
    for (const a of p.allocations) this.credit(p, a.buyer_id, BigInt(a.excess), "excess_over_clearing_price", ev);
    p.winner_seller_id = ok[0]!.id;
    p.clearing_price_per_hour = price.toString();
    p.required_total = total.toString();
    p.delivery_deadline = (this.nowNs + BigInt(p.windows.delivery_secs) * 1_000_000_000n).toString();
    p.state = "FUNDED";
    ev.push({ event: "purchase_funded", data: { purchase_id: pid, clearing_price_per_hour: price.toString(), amount: total.toString(), members } });
    return this.tx("close_auction", ev);
  }
  async startDelivery(pid: string) {
    const p = this.p(pid);
    if (p.state !== "FUNDED" || this.nowNs >= BigInt(p.delivery_deadline!)) this.fail("start_delivery", "invalid state or deadline passed");
    p.state = "DELIVERING";
    return this.tx("start_delivery");
  }
  async submitDeliveryReport(pid: string, hash: string) {
    const p = this.p(pid);
    if (p.state !== "DELIVERING" || this.nowNs >= BigInt(p.delivery_deadline!)) this.fail("submit_delivery_report", "invalid state or deadline passed");
    p.delivery_report_hash = hash;
    p.verification_deadline = (this.nowNs + BigInt(p.windows.verification_secs) * 1_000_000_000n).toString();
    p.state = "VERIFYING";
    return this.tx("submit_delivery_report");
  }
  private payoutTransfer(p: ContractPurchase, ev: Ev[]): boolean {
    const amount = BigInt(p.held);
    const to = this.sellers.get(p.winner_seller_id!)!.payout;
    if (this.missingAccounts.has(to)) {
      ev.push({ event: "payout_failed", data: { purchase_id: p.purchase_id, amount: amount.toString() } });
      return false;
    }
    this.received.set(to, (this.received.get(to) ?? 0n) + amount);
    this.totalEscrowed -= amount;
    p.held = "0";
    p.paid_out = amount.toString();
    p.state = "COMPLETED";
    for (const a of p.allocations) {
      const b = this.buyers.get(a.buyer_id)!;
      b.reserved = (BigInt(b.reserved) - BigInt(a.owed)).toString();
      b.spent = (BigInt(b.spent) + BigInt(a.owed)).toString();
    }
    ev.push({ event: "payout_succeeded", data: { purchase_id: p.purchase_id, seller_id: p.winner_seller_id, payout_account_id: to, amount: amount.toString() } });
    return true;
  }
  async verify(pid: string, success: boolean) {
    const p = this.p(pid);
    if (p.state !== "VERIFYING" || p.verified_success != null) this.fail("verify", "invalid state");
    p.verified_success = success;
    const ev: Ev[] = [{ event: "delivery_verified", data: { purchase_id: pid, success } }];
    if (success) return this.tx("verify", ev, !this.payoutTransfer(p, ev));
    p.state = "FAILED";
    this.refundAll(p, "delivery_failed", ev);
    return this.tx("verify", ev);
  }
  async payout(pid: string) {
    const p = this.p(pid);
    if (p.state !== "VERIFYING" || p.verified_success !== true) this.fail("payout", "invalid state");
    const ev: Ev[] = [];
    return this.tx("payout", ev, !this.payoutTransfer(p, ev));
  }
  async expire(pid: string) {
    const p = this.p(pid);
    const t = this.nowNs;
    const ok =
      (p.state === "CREATED" && t >= BigInt(p.prepay_deadline)) ||
      ((p.state === "FUNDED" || p.state === "DELIVERING") && t >= BigInt(p.delivery_deadline!)) ||
      (p.state === "VERIFYING" && p.verified_success == null && t >= BigInt(p.verification_deadline!));
    if (!ok) this.fail("expire", "deadline not reached");
    p.state = "EXPIRED";
    const ev: Ev[] = [];
    this.refundAll(p, "deadline", ev);
    return this.tx("expire", ev);
  }
  async withdrawBalance(buyerId: string) {
    const b = this.buyers.get(buyerId)!;
    const amount = BigInt(b.balance);
    if (amount === 0n) this.fail("withdraw_balance", "no balance to withdraw");
    if (this.missingAccounts.has(b.wallet)) {
      return this.tx("withdraw_balance", [{ event: "withdrawal_failed", data: { buyer_id: buyerId, wallet: b.wallet, amount: amount.toString() } }], true);
    }
    b.balance = "0";
    this.totalBalances -= amount;
    this.received.set(b.wallet, (this.received.get(b.wallet) ?? 0n) + amount);
    return this.tx("withdraw_balance", [{ event: "withdrawal_succeeded", data: { buyer_id: buyerId, wallet: b.wallet, amount: amount.toString() } }]);
  }
}
