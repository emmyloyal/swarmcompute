/**
 * In-memory stand-in for the marketplace contract, following its rules closely
 * enough to drive the market host through whole rounds in unit tests. The real
 * contract is tested in contracts/marketplace (unit) and on testnet.
 */
import { computeCommitment, type GpuModel } from "@swarmcompute/shared";
import type {
  BuyerRequest,
  ContractBuyer,
  ContractCoalition,
  ContractConfig,
  ContractPurchase,
  ContractSeller,
  ContractWindows,
  GpuOffer,
  MarketplaceContract,
  SellerStrategy,
} from "../src/chain/marketplace.js";
import type { TxResult } from "../src/chain/types.js";

const NS = 1_000_000_000n;
let txn = 0;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function fakeHash(): string {
  let n = ++txn;
  let s = "";
  for (let i = 0; i < 44; i++) {
    s += B58[n % 58];
    n = Math.floor(n / 58) + i * 7 + 3;
  }
  return s;
}

export class FakeContract implements MarketplaceContract {
  readonly contractId = "market.test.testnet";
  nowNs = 1_700_000_000n * NS;
  readonly buyers = new Map<string, ContractBuyer>();
  readonly sellers = new Map<string, ContractSeller>();
  readonly coalitions = new Map<string, ContractCoalition>();
  readonly purchases = new Map<string, ContractPurchase>();
  readonly purchaseIds: string[] = [];
  /** agent id → the public "key" on its account (here the private key string itself). */
  readonly agentKeys = new Map<string, string>();
  readonly paidTo: { account: string; amount: bigint }[] = [];
  readonly calls: { method: string; signer: string }[] = [];

  advance(secs: number) {
    this.nowNs += BigInt(secs) * NS;
  }
  private tx(method: string, signer: string): TxResult {
    this.calls.push({ method, signer });
    return { txHash: fakeHash(), signerId: signer, receiverId: this.contractId, method, ok: true, callSucceeded: true, failedReceipts: 0, logs: [], events: [], gasBurnt: 0n };
  }
  private agentCall(key: string, agentId: string) {
    if (this.agentKeys.get(agentId) !== key) throw new Error(`only the agent's own key can sign for ${agentId}`);
  }

  // ---- test setup: what owners do from their wallets
  openBuyer(name: string, owner: string, key: string | null, available: bigint, request: BuyerRequest | null): string {
    const id = `${name}.${this.contractId}`;
    this.buyers.set(id, { buyer_id: id, owner, opened: true, created_at: this.nowNs.toString(), request, coalition_id: null, available: available.toString(), reserved: "0", spent: "0", withdrawing: "0" });
    if (key) this.agentKeys.set(id, key);
    return id;
  }
  openSeller(name: string, owner: string, key: string | null, offers: GpuOffer[], min: bigint, strategy: SellerStrategy = { kind: "AT_MINIMUM" }): string {
    const id = `${name}.${this.contractId}`;
    this.sellers.set(id, {
      seller_id: id,
      owner,
      opened: true,
      created_at: this.nowNs.toString(),
      active: true,
      offers,
      min_price_per_hour: min.toString(),
      strategy,
      reputation: { wins: 0, completed_deliveries: 0, failed_deliveries: 0, non_reveals: 0 },
    });
    if (key) this.agentKeys.set(id, key);
    return id;
  }
  request(model: GpuModel, vram: number, hours: number, max: bigint, deadlineSecs = 86_400): BuyerRequest {
    return { gpu_model: model, vram_gb: vram, hours, max_price_per_hour: max.toString(), deadline: (this.nowNs + BigInt(deadlineSecs) * NS).toString() };
  }

  // ---- views
  async blockTimestampNs() {
    return this.nowNs;
  }
  async getConfig(): Promise<ContractConfig> {
    return {
      owner: "op.testnet",
      operator: "op.testnet",
      verifier: "op.testnet",
      paused: false,
      total_escrowed: [...this.purchases.values()].reduce((s, p) => s + BigInt(p.held), 0n).toString(),
      total_balances: [...this.buyers.values()].reduce((s, b) => s + BigInt(b.available), 0n).toString(),
      buyer_count: this.buyers.size,
      seller_count: this.sellers.size,
      purchase_count: this.purchaseIds.length,
      open_fee: "100000000000000000000",
      agent_gas_fund: "100000000000000000000000",
      max_agents_per_owner: 5,
      sponsor_pool: "5000000000000000000000000",
    };
  }
  async listBuyers() {
    return [...this.buyers.values()].map((b) => structuredClone(b));
  }
  async listSellers() {
    return [...this.sellers.values()].map((s) => structuredClone(s));
  }
  async listPurchaseIds(from: number, limit: number) {
    return this.purchaseIds.slice(from, from + limit);
  }
  async getPurchase(id: string) {
    const p = this.purchases.get(id);
    return p ? structuredClone(p) : null;
  }
  async getCoalition(id: string) {
    const c = this.coalitions.get(id);
    return c ? structuredClone(c) : null;
  }
  async accessKeys(accountId: string) {
    const k = this.agentKeys.get(accountId);
    return k === undefined ? null : [{ publicKey: k, fullAccess: false, receiverId: this.contractId }];
  }

  // ---- operator
  async registerCoalition(coalitionId: string, buyerIds: string[], minMembers: number) {
    if (this.coalitions.has(coalitionId)) throw new Error("coalition already registered");
    const members = buyerIds.map((id) => {
      const b = this.buyers.get(id)!;
      if (b.coalition_id) throw new Error("buyer is already in a coalition");
      if (!b.request) throw new Error("buyer has no open request");
      return { buyer_id: id, hours: b.request.hours, max_price_per_hour: b.request.max_price_per_hour };
    });
    const models = new Set(buyerIds.map((id) => this.buyers.get(id)!.request!.gpu_model));
    if (models.size !== 1) throw new Error("members want different GPU models");
    for (const id of buyerIds) this.buyers.get(id)!.coalition_id = coalitionId;
    this.coalitions.set(coalitionId, {
      coalition_id: coalitionId,
      gpu_model: [...models][0]!,
      vram_gb: Math.max(...buyerIds.map((id) => this.buyers.get(id)!.request!.vram_gb)),
      min_members: minMembers,
      members,
      closed: false,
      live_purchase_id: null,
    });
    return this.tx("register_coalition", "op.testnet");
  }
  async createPurchase(purchaseId: string, auctionId: string, coalitionId: string, windows: ContractWindows) {
    const c = this.coalitions.get(coalitionId)!;
    if (c.closed || c.live_purchase_id) throw new Error("coalition not available");
    c.live_purchase_id = purchaseId;
    this.purchases.set(purchaseId, {
      purchase_id: purchaseId,
      auction_id: auctionId,
      coalition_id: coalitionId,
      state: "CREATED",
      windows,
      created_at: this.nowNs.toString(),
      prepay_deadline: (this.nowNs + BigInt(windows.prepay_secs) * NS).toString(),
      commit_deadline: null,
      reveal_deadline: null,
      delivery_deadline: null,
      verification_deadline: null,
      bids: [],
      winner_seller_id: null,
      clearing_price_per_hour: null,
      required_total: null,
      allocations: [],
      deposited: "0",
      held: "0",
      delivery_report_hash: null,
      verified_success: null,
      verification_reason: null,
      payout_in_flight: false,
      paid_out: "0",
    });
    this.purchaseIds.push(purchaseId);
    return this.tx("create_purchase", "op.testnet");
  }
  private credit(p: ContractPurchase, buyerId: string, amount: bigint) {
    const b = this.buyers.get(buyerId)!;
    b.reserved = (BigInt(b.reserved) - amount).toString();
    b.available = (BigInt(b.available) + amount).toString();
    p.held = (BigInt(p.held) - amount).toString();
  }
  private close(c: ContractCoalition, fulfilled: boolean) {
    if (c.closed) return;
    c.closed = true;
    c.live_purchase_id = null;
    for (const m of c.members) {
      const b = this.buyers.get(m.buyer_id)!;
      b.coalition_id = null;
      if (fulfilled) b.request = null;
    }
  }
  private refundAll(p: ContractPurchase) {
    const awarded = p.clearing_price_per_hour !== null;
    for (const a of p.allocations) {
      const amt = BigInt(awarded ? a.owed : a.prepaid);
      if (amt > 0n) {
        this.credit(p, a.buyer_id, amt);
        a.refunded = amt.toString();
      }
    }
    if (p.allocations.some((a) => a.refunded !== "0")) p.state = "REFUNDED";
    this.close(this.coalitions.get(p.coalition_id)!, false);
  }
  async leaveCoalition(coalitionId: string, buyerId: string) {
    const c = this.coalitions.get(coalitionId)!;
    c.members = c.members.filter((m) => m.buyer_id !== buyerId);
    this.buyers.get(buyerId)!.coalition_id = null;
    const p = c.live_purchase_id ? this.purchases.get(c.live_purchase_id) : undefined;
    if (p) {
      const a = p.allocations.find((x) => x.buyer_id === buyerId);
      if (a) {
        p.allocations = p.allocations.filter((x) => x !== a);
        this.credit(p, buyerId, BigInt(a.prepaid));
      }
    }
    if (c.members.length < c.min_members) {
      if (p) {
        p.state = "FAILED";
        this.refundAll(p);
      }
      this.close(c, false);
    }
    return this.tx("leave_coalition", "op.testnet");
  }
  async openBidding(pid: string) {
    const p = this.purchases.get(pid)!;
    const c = this.coalitions.get(p.coalition_id)!;
    if (p.state !== "CREATED") throw new Error("invalid state");
    if (!c.members.every((m) => p.allocations.some((a) => a.buyer_id === m.buyer_id))) throw new Error("every member must prepay");
    p.commit_deadline = (this.nowNs + BigInt(p.windows.commit_secs) * NS).toString();
    p.reveal_deadline = (BigInt(p.commit_deadline) + BigInt(p.windows.reveal_secs) * NS).toString();
    p.state = "BIDDING";
    return this.tx("open_bidding", "op.testnet");
  }
  async closeAuction(pid: string) {
    const p = this.purchases.get(pid)!;
    if (p.state !== "BIDDING" || this.nowNs < BigInt(p.reveal_deadline!)) throw new Error("reveal phase is not over");
    const c = this.coalitions.get(p.coalition_id)!;
    const hours = c.members.reduce((s, m) => s + m.hours, 0);
    const ceiling = c.members.reduce((m, x) => (BigInt(x.max_price_per_hour) < m ? BigInt(x.max_price_per_hour) : m), BigInt(c.members[0]!.max_price_per_hour));
    const eligible: { price: bigint; seller: string; h: bigint }[] = [];
    for (const b of p.bids) {
      const s = this.sellers.get(b.seller_id)!;
      if (b.revealed_price_per_hour === null) {
        b.eligible = false;
        b.ineligibility_reason = "NOT_REVEALED";
        s.reputation.non_reveals++;
        continue;
      }
      const price = BigInt(b.revealed_price_per_hour);
      const ok = s.offers.some((o) => o.gpu_model === c.gpu_model && o.vram_gb >= c.vram_gb && o.capacity_hours >= hours) && price <= ceiling;
      b.eligible = ok;
      if (ok) eligible.push({ price, seller: b.seller_id, h: BigInt(b.commit_block_height) });
      else b.ineligibility_reason = "INELIGIBLE";
    }
    eligible.sort((a, b) => (a.price !== b.price ? (a.price < b.price ? -1 : 1) : a.h < b.h ? -1 : 1));
    const w = eligible[0];
    if (!w) {
      p.state = "FAILED";
      this.refundAll(p);
      return this.tx("close_auction", "op.testnet");
    }
    let total = 0n;
    for (const a of p.allocations) {
      const owed = w.price * BigInt(a.hours);
      a.owed = owed.toString();
      a.excess = (BigInt(a.prepaid) - owed).toString();
      total += owed;
      this.credit(p, a.buyer_id, BigInt(a.excess));
    }
    p.winner_seller_id = w.seller;
    p.clearing_price_per_hour = w.price.toString();
    p.required_total = total.toString();
    p.delivery_deadline = (this.nowNs + BigInt(p.windows.delivery_secs) * NS).toString();
    this.sellers.get(w.seller)!.reputation.wins++;
    p.state = "FUNDED";
    return this.tx("close_auction", "op.testnet");
  }
  async startDelivery(pid: string) {
    const p = this.purchases.get(pid)!;
    if (p.state !== "FUNDED") throw new Error("invalid state");
    p.state = "DELIVERING";
    return this.tx("start_delivery", "op.testnet");
  }
  async submitDeliveryReport(pid: string, hash: string) {
    const p = this.purchases.get(pid)!;
    if (p.state !== "DELIVERING") throw new Error("invalid state");
    p.delivery_report_hash = hash;
    p.verification_deadline = (this.nowNs + BigInt(p.windows.verification_secs) * NS).toString();
    p.state = "VERIFYING";
    return this.tx("submit_delivery_report", "op.testnet");
  }
  /** Set to make the next payout transfer fail (like a deleted owner account). */
  failNextPayout = false;
  verifySuccess = true;
  async verify(pid: string, success: boolean) {
    const p = this.purchases.get(pid)!;
    if (p.state !== "VERIFYING") throw new Error("invalid state");
    const ok = success && this.verifySuccess;
    p.verified_success = ok;
    if (ok) return this.doPayout(p, "verify");
    this.sellers.get(p.winner_seller_id!)!.reputation.failed_deliveries++;
    p.state = "FAILED";
    this.refundAll(p);
    return this.tx("verify", "op.testnet");
  }
  private doPayout(p: ContractPurchase, method: string) {
    const r = this.tx(method, "op.testnet");
    if (this.failNextPayout) {
      this.failNextPayout = false;
      return { ...r, ok: false, failedReceipts: 1 };
    }
    const s = this.sellers.get(p.winner_seller_id!)!;
    this.paidTo.push({ account: s.owner, amount: BigInt(p.held) });
    for (const a of p.allocations) {
      const b = this.buyers.get(a.buyer_id)!;
      b.reserved = (BigInt(b.reserved) - BigInt(a.owed)).toString();
      b.spent = (BigInt(b.spent) + BigInt(a.owed)).toString();
    }
    p.paid_out = p.held;
    p.held = "0";
    s.reputation.completed_deliveries++;
    p.state = "COMPLETED";
    this.close(this.coalitions.get(p.coalition_id)!, true);
    return r;
  }
  async payout(pid: string) {
    const p = this.purchases.get(pid)!;
    if (p.state !== "VERIFYING" || !p.verified_success) throw new Error("invalid state");
    return this.doPayout(p, "payout");
  }
  async expire(pid: string) {
    const p = this.purchases.get(pid)!;
    const due = { CREATED: p.prepay_deadline, FUNDED: p.delivery_deadline, DELIVERING: p.delivery_deadline, VERIFYING: p.verification_deadline }[p.state as "CREATED"];
    if (!due || this.nowNs < BigInt(due)) throw new Error("deadline not reached");
    p.state = "EXPIRED";
    this.refundAll(p);
    return this.tx("expire", "op.testnet");
  }

  // ---- agents (own keys)
  async prepay(key: string, pid: string, buyerId: string) {
    this.agentCall(key, buyerId);
    const p = this.purchases.get(pid)!;
    if (p.state !== "CREATED") throw new Error("invalid state");
    const b = this.buyers.get(buyerId)!;
    const m = this.coalitions.get(p.coalition_id)!.members.find((x) => x.buyer_id === buyerId);
    if (!m) throw new Error("not a member");
    if (p.allocations.some((a) => a.buyer_id === buyerId)) throw new Error("already prepaid");
    const amount = BigInt(m.max_price_per_hour) * BigInt(m.hours);
    if (BigInt(b.available) < amount) throw new Error("available balance is below hours × own max price");
    b.available = (BigInt(b.available) - amount).toString();
    b.reserved = (BigInt(b.reserved) + amount).toString();
    p.allocations.push({ buyer_id: buyerId, hours: m.hours, max_price_per_hour: m.max_price_per_hour, prepaid: amount.toString(), owed: "0", excess: "0", refunded: "0" });
    p.held = (BigInt(p.held) + amount).toString();
    p.deposited = (BigInt(p.deposited) + amount).toString();
    return this.tx("prepay", buyerId);
  }
  private height = 100;
  async commitBid(key: string, pid: string, sellerId: string, commitmentHex: string) {
    this.agentCall(key, sellerId);
    const p = this.purchases.get(pid)!;
    if (p.state !== "BIDDING" || this.nowNs >= BigInt(p.commit_deadline!)) throw new Error("commit phase is over");
    if (p.bids.some((b) => b.seller_id === sellerId)) throw new Error("seller already committed");
    p.bids.push({ seller_id: sellerId, commitment_hex: commitmentHex, commit_block_height: String(this.height++), revealed_price_per_hour: null, reveal_block_height: null, eligible: null, ineligibility_reason: null });
    return this.tx("commit_bid", sellerId);
  }
  async revealBid(key: string, pid: string, sellerId: string, price: bigint, nonceHex: string) {
    this.agentCall(key, sellerId);
    const p = this.purchases.get(pid)!;
    if (this.nowNs < BigInt(p.commit_deadline!) || this.nowNs >= BigInt(p.reveal_deadline!)) throw new Error("not in reveal phase");
    if (price < BigInt(this.sellers.get(sellerId)!.min_price_per_hour)) throw new Error("price is below the seller's own minimum");
    const b = p.bids.find((x) => x.seller_id === sellerId)!;
    const c = computeCommitment({ auctionId: p.auction_id, sellerId, pricePerHourYocto: price, nonce: Buffer.from(nonceHex, "hex") });
    if (c !== b.commitment_hex) throw new Error("commitment mismatch");
    b.revealed_price_per_hour = price.toString();
    return this.tx("reveal_bid", sellerId);
  }
}
