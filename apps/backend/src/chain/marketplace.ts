/**
 * Typed wrapper over the marketplace contract (contracts/marketplace).
 * Money crosses the boundary as decimal strings (RULES.md R3).
 */
import type { GpuModel } from "@swarmcompute/shared";
import { ChainCallError, type ChainCaller, type TxResult } from "./types.js";

export interface ContractWindows {
  prepay_secs: number;
  commit_secs: number;
  reveal_secs: number;
  delivery_secs: number;
  verification_secs: number;
}

export interface ContractBid {
  seller_id: string;
  commitment_hex: string;
  commit_block_height: string;
  revealed_price_per_hour: string | null;
  eligible: boolean | null;
  ineligibility_reason: string | null;
}

export interface ContractAllocation {
  buyer_id: string;
  hours: number;
  max_price_per_hour: string;
  prepaid: string;
  owed: string;
  excess: string;
  refunded: string;
}

export interface ContractPurchase {
  purchase_id: string;
  auction_id: string;
  coalition_id: string;
  state: "CREATED" | "BIDDING" | "FUNDED" | "DELIVERING" | "VERIFYING" | "COMPLETED" | "FAILED" | "EXPIRED" | "REFUNDED";
  prepay_deadline: string;
  commit_deadline: string | null;
  reveal_deadline: string | null;
  delivery_deadline: string | null;
  verification_deadline: string | null;
  bids: ContractBid[];
  winner_seller_id: string | null;
  clearing_price_per_hour: string | null;
  required_total: string | null;
  allocations: ContractAllocation[];
  deposited: string;
  held: string;
  delivery_report_hash?: string | null;
  verified_success?: boolean | null;
  payout_in_flight?: boolean;
  paid_out?: string;
}

export interface ContractBuyer {
  buyer_id: string;
  max_budget: string;
  wallet: string;
  reserved: string;
  spent: string;
  balance: string;
  withdrawing: string;
}

export interface CoalitionMemberInput {
  buyer_id: string;
  hours: number;
  max_price_per_hour: bigint;
}

export interface MarketplaceContract {
  getBuyer(buyerId: string): Promise<ContractBuyer | null>;
  getSeller(sellerId: string): Promise<unknown | null>;
  getCoalition(coalitionId: string): Promise<{ members: { buyer_id: string; hours: number; max_price_per_hour: string }[] } | null>;
  getPurchase(purchaseId: string): Promise<ContractPurchase | null>;
  blockTimestampNs(): Promise<bigint>;

  registerBuyer(buyerId: string, maxBudget: bigint, wallet: string): Promise<TxResult>;
  registerSeller(sellerId: string, payoutAccountId: string, offers: { gpu_model: GpuModel; vram_gb: number; capacity_hours: number }[]): Promise<TxResult>;
  registerCoalition(c: { coalitionId: string; gpuModel: GpuModel; vramGb: number; minMembers: number; members: CoalitionMemberInput[] }): Promise<TxResult>;
  leaveCoalition(coalitionId: string, buyerId: string, purchaseId?: string): Promise<TxResult>;
  createPurchase(purchaseId: string, auctionId: string, coalitionId: string, windows: ContractWindows): Promise<TxResult>;
  /** Signed by the buyer's own wallet; exactly hours × own max price. */
  prepay(wallet: string, purchaseId: string, buyerId: string, amount: bigint): Promise<TxResult>;
  openBidding(purchaseId: string): Promise<TxResult>;
  commitBid(purchaseId: string, sellerId: string, commitmentHex: string): Promise<TxResult>;
  revealBid(purchaseId: string, sellerId: string, pricePerHour: bigint, nonceHex: string): Promise<TxResult>;
  /** Lowest eligible bid becomes the clearing price; excess is credited to each member. */
  closeAuction(purchaseId: string): Promise<TxResult>;
  startDelivery(purchaseId: string): Promise<TxResult>;
  submitDeliveryReport(purchaseId: string, reportHashHex: string): Promise<TxResult>;
  /** Signed by the verifier only. Success starts the payout; failure credits members back. */
  verify(purchaseId: string, success: boolean, reason: string): Promise<TxResult>;
  /** Retry a payout (anyone may call; destination fixed on-chain). */
  payout(purchaseId: string): Promise<TxResult>;
  /** Expire a purchase whose deadline passed; held money is credited back to members. */
  expire(purchaseId: string): Promise<TxResult>;
  /** Send a buyer's credited balance to its own wallet (anyone may call). */
  withdrawBalance(buyerId: string): Promise<TxResult>;
}

function must(r: TxResult): TxResult {
  if (!r.ok) throw new ChainCallError(`${r.method} failed in tx ${r.txHash}: ${JSON.stringify(r.error)}`, r);
  return r;
}

/** Like `must`, but a failed transfer receipt inside a successful call is a result, not an error. */
function mustCall(r: TxResult): TxResult {
  if (!r.callSucceeded) throw new ChainCallError(`${r.method} failed in tx ${r.txHash}: ${JSON.stringify(r.error)}`, r);
  return r;
}

export class Marketplace implements MarketplaceContract {
  constructor(private readonly chain: ChainCaller) {}

  getBuyer(buyerId: string) {
    return this.chain.view<ContractBuyer | null>("get_buyer", { buyer_id: buyerId });
  }
  getSeller(sellerId: string) {
    return this.chain.view<unknown | null>("get_seller", { seller_id: sellerId });
  }
  getCoalition(coalitionId: string) {
    return this.chain.view<{ members: { buyer_id: string; hours: number; max_price_per_hour: string }[] } | null>("get_coalition", { coalition_id: coalitionId });
  }
  getPurchase(purchaseId: string) {
    return this.chain.view<ContractPurchase | null>("get_purchase", { purchase_id: purchaseId });
  }
  blockTimestampNs() {
    return this.chain.blockTimestampNs();
  }

  async registerBuyer(buyerId: string, maxBudget: bigint, wallet: string) {
    return must(await this.chain.call("operator", "register_buyer", { buyer_id: buyerId, max_budget: maxBudget.toString(), wallet }, { purpose: "register_buyer" }));
  }
  async registerSeller(sellerId: string, payoutAccountId: string, offers: { gpu_model: GpuModel; vram_gb: number; capacity_hours: number }[]) {
    return must(await this.chain.call("operator", "register_seller", { seller_id: sellerId, payout_account_id: payoutAccountId, offers }, { purpose: "register_seller" }));
  }
  async registerCoalition(c: Parameters<MarketplaceContract["registerCoalition"]>[0]) {
    return must(
      await this.chain.call(
        "operator",
        "register_coalition",
        {
          coalition_id: c.coalitionId,
          gpu_model: c.gpuModel,
          vram_gb: c.vramGb,
          min_members: c.minMembers,
          members: c.members.map((m) => ({ buyer_id: m.buyer_id, hours: m.hours, max_price_per_hour: m.max_price_per_hour.toString() })),
        },
        { purpose: "register_coalition", gasTera: 150 },
      ),
    );
  }
  async leaveCoalition(coalitionId: string, buyerId: string, purchaseId?: string) {
    return must(await this.chain.call("operator", "leave_coalition", { coalition_id: coalitionId, buyer_id: buyerId }, { purpose: "leave_coalition", purchaseId, gasTera: 150 }));
  }
  async createPurchase(purchaseId: string, auctionId: string, coalitionId: string, windows: ContractWindows) {
    return must(
      await this.chain.call("operator", "create_purchase", { purchase_id: purchaseId, auction_id: auctionId, coalition_id: coalitionId, windows }, { purpose: "create_purchase", purchaseId }),
    );
  }
  async prepay(wallet: string, purchaseId: string, buyerId: string, amount: bigint) {
    // 20 Tgas: the sender must hold deposit + gas allowance at max gas price; prepay is a small call.
    return must(await this.chain.callAsBuyerWallet(wallet, "prepay", { purchase_id: purchaseId, buyer_id: buyerId }, { purpose: "prepay", purchaseId, deposit: amount, gasTera: 20 }));
  }
  async openBidding(purchaseId: string) {
    return must(await this.chain.call("operator", "open_bidding", { purchase_id: purchaseId }, { purpose: "open_bidding", purchaseId }));
  }
  async commitBid(purchaseId: string, sellerId: string, commitmentHex: string) {
    return must(await this.chain.call("operator", "commit_bid", { purchase_id: purchaseId, seller_id: sellerId, commitment_hex: commitmentHex }, { purpose: "commit_bid", purchaseId }));
  }
  async revealBid(purchaseId: string, sellerId: string, pricePerHour: bigint, nonceHex: string) {
    return must(
      await this.chain.call(
        "operator",
        "reveal_bid",
        { purchase_id: purchaseId, seller_id: sellerId, price_per_hour: pricePerHour.toString(), nonce_hex: nonceHex },
        { purpose: "reveal_bid", purchaseId },
      ),
    );
  }
  async closeAuction(purchaseId: string) {
    return must(await this.chain.call("operator", "close_auction", { purchase_id: purchaseId }, { purpose: "close_auction", purchaseId, gasTera: 200 }));
  }
  async startDelivery(purchaseId: string) {
    return must(await this.chain.call("operator", "start_delivery", { purchase_id: purchaseId }, { purpose: "start_delivery", purchaseId }));
  }
  async submitDeliveryReport(purchaseId: string, reportHashHex: string) {
    return must(
      await this.chain.call("operator", "submit_delivery_report", { purchase_id: purchaseId, report_hash_hex: reportHashHex }, { purpose: "submit_delivery_report", purchaseId }),
    );
  }
  async verify(purchaseId: string, success: boolean, reason: string) {
    return mustCall(
      await this.chain.call("verifier", "verify", { purchase_id: purchaseId, success, reason }, { purpose: success ? "verify_success" : "verify_failure", purchaseId, gasTera: 200 }),
    );
  }
  async payout(purchaseId: string) {
    return mustCall(await this.chain.call("operator", "payout", { purchase_id: purchaseId }, { purpose: "payout_retry", purchaseId, gasTera: 200 }));
  }
  async expire(purchaseId: string) {
    return mustCall(await this.chain.call("operator", "expire", { purchase_id: purchaseId }, { purpose: "expire", purchaseId, gasTera: 200 }));
  }
  async withdrawBalance(buyerId: string) {
    return mustCall(await this.chain.call("operator", "withdraw_balance", { buyer_id: buyerId }, { purpose: "withdraw_balance", gasTera: 100 }));
  }
}
