/**
 * Typed wrapper over the marketplace contract (contracts/marketplace).
 * Money crosses the boundary as decimal strings (RULES.md R3).
 *
 * Who signs what (RULES.md R8):
 *   operator  register_coalition, create_purchase, open_bidding, close_auction,
 *             leave_coalition (for an agent that can't afford its prepayment),
 *             start_delivery, submit_delivery_report, payout retry, expire
 *   verifier  verify
 *   agent     prepay (buyer), commit_bid / reveal_bid (seller), each with its own key
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

export interface BuyerRequest {
  gpu_model: GpuModel;
  vram_gb: number;
  hours: number;
  max_price_per_hour: string;
  /** ns since epoch */
  deadline: string;
}

export interface ContractBuyer {
  buyer_id: string;
  owner: string;
  opened: boolean;
  created_at: string;
  request: BuyerRequest | null;
  coalition_id: string | null;
  available: string;
  reserved: string;
  spent: string;
  withdrawing: string;
}

export interface GpuOffer {
  gpu_model: GpuModel;
  vram_gb: number;
  capacity_hours: number;
}

export type SellerStrategy = { kind: "AT_MINIMUM" } | { kind: "BELOW_CEILING"; discount_bps: number };

export interface Reputation {
  wins: number;
  completed_deliveries: number;
  failed_deliveries: number;
  non_reveals: number;
}

export interface ContractSeller {
  seller_id: string;
  owner: string;
  opened: boolean;
  created_at: string;
  active: boolean;
  offers: GpuOffer[];
  min_price_per_hour: string;
  strategy: SellerStrategy;
  reputation: Reputation;
}

export interface CoalitionMember {
  buyer_id: string;
  hours: number;
  max_price_per_hour: string;
}

export interface ContractCoalition {
  coalition_id: string;
  gpu_model: GpuModel;
  vram_gb: number;
  min_members: number;
  members: CoalitionMember[];
  closed: boolean;
  live_purchase_id: string | null;
}

export interface ContractBid {
  seller_id: string;
  commitment_hex: string;
  commit_block_height: string;
  revealed_price_per_hour: string | null;
  reveal_block_height: string | null;
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

export type PurchaseState = "CREATED" | "BIDDING" | "FUNDED" | "DELIVERING" | "VERIFYING" | "COMPLETED" | "FAILED" | "EXPIRED" | "REFUNDED";
export const TERMINAL_STATES: readonly PurchaseState[] = ["COMPLETED", "FAILED", "EXPIRED", "REFUNDED"];

export interface ContractPurchase {
  purchase_id: string;
  auction_id: string;
  coalition_id: string;
  state: PurchaseState;
  windows: ContractWindows;
  created_at: string;
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
  delivery_report_hash: string | null;
  verified_success: boolean | null;
  verification_reason: string | null;
  payout_in_flight: boolean;
  paid_out: string;
}

export interface ContractConfig {
  owner: string;
  operator: string;
  verifier: string;
  paused: boolean;
  total_escrowed: string;
  total_balances: string;
  buyer_count: number;
  seller_count: number;
  purchase_count: number;
  open_fee: string;
  agent_gas_fund: string;
}

export interface MarketplaceContract {
  readonly contractId: string;
  blockTimestampNs(): Promise<bigint>;
  getConfig(): Promise<ContractConfig>;
  listBuyers(): Promise<ContractBuyer[]>;
  listSellers(): Promise<ContractSeller[]>;
  listPurchaseIds(fromIndex: number, limit: number): Promise<string[]>;
  getPurchase(purchaseId: string): Promise<ContractPurchase | null>;
  getCoalition(coalitionId: string): Promise<ContractCoalition | null>;
  accessKeys(accountId: string): ReturnType<ChainCaller["accessKeys"]>;

  registerCoalition(coalitionId: string, buyerIds: string[], minMembers: number): Promise<TxResult>;
  createPurchase(purchaseId: string, auctionId: string, coalitionId: string, windows: ContractWindows): Promise<TxResult>;
  /** Operator removes a member that can't afford its prepayment (before funding). */
  leaveCoalition(coalitionId: string, buyerId: string, purchaseId?: string): Promise<TxResult>;
  openBidding(purchaseId: string): Promise<TxResult>;
  closeAuction(purchaseId: string): Promise<TxResult>;
  startDelivery(purchaseId: string): Promise<TxResult>;
  submitDeliveryReport(purchaseId: string, reportHashHex: string): Promise<TxResult>;
  verify(purchaseId: string, success: boolean, reason: string): Promise<TxResult>;
  payout(purchaseId: string): Promise<TxResult>;
  expire(purchaseId: string): Promise<TxResult>;

  /** Signed by the buyer agent's own key. */
  prepay(agentKey: string, purchaseId: string, buyerId: string): Promise<TxResult>;
  /** Signed by the seller agent's own key. */
  commitBid(agentKey: string, purchaseId: string, sellerId: string, commitmentHex: string): Promise<TxResult>;
  revealBid(agentKey: string, purchaseId: string, sellerId: string, pricePerHour: bigint, nonceHex: string): Promise<TxResult>;
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

const PAGE = 100;

export class Marketplace implements MarketplaceContract {
  constructor(private readonly chain: ChainCaller) {}

  get contractId() {
    return this.chain.contractId;
  }
  blockTimestampNs() {
    return this.chain.blockTimestampNs();
  }
  getConfig() {
    return this.chain.view<ContractConfig>("get_config", {});
  }
  private async all<T>(method: string): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += PAGE) {
      const page = await this.chain.view<T[]>(method, { from_index: from, limit: PAGE });
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }
  listBuyers() {
    return this.all<ContractBuyer>("list_buyers");
  }
  listSellers() {
    return this.all<ContractSeller>("list_sellers");
  }
  listPurchaseIds(fromIndex: number, limit: number) {
    return this.chain.view<string[]>("list_purchase_ids", { from_index: fromIndex, limit });
  }
  getPurchase(purchaseId: string) {
    return this.chain.view<ContractPurchase | null>("get_purchase", { purchase_id: purchaseId });
  }
  getCoalition(coalitionId: string) {
    return this.chain.view<ContractCoalition | null>("get_coalition", { coalition_id: coalitionId });
  }
  accessKeys(accountId: string) {
    return this.chain.accessKeys(accountId);
  }

  async registerCoalition(coalitionId: string, buyerIds: string[], minMembers: number) {
    return must(
      await this.chain.call("operator", "register_coalition", { coalition_id: coalitionId, buyer_ids: buyerIds, min_members: minMembers }, { purpose: "register_coalition", gasTera: 150 }),
    );
  }
  async createPurchase(purchaseId: string, auctionId: string, coalitionId: string, windows: ContractWindows) {
    return must(
      await this.chain.call("operator", "create_purchase", { purchase_id: purchaseId, auction_id: auctionId, coalition_id: coalitionId, windows }, { purpose: "create_purchase", purchaseId }),
    );
  }
  async leaveCoalition(coalitionId: string, buyerId: string, purchaseId?: string) {
    return must(await this.chain.call("operator", "leave_coalition", { coalition_id: coalitionId, buyer_id: buyerId }, { purpose: "leave_coalition", purchaseId, gasTera: 150 }));
  }
  async openBidding(purchaseId: string) {
    return must(await this.chain.call("operator", "open_bidding", { purchase_id: purchaseId }, { purpose: "open_bidding", purchaseId }));
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

  private agentId(args: { buyer_id?: string; seller_id?: string }) {
    return (args.buyer_id ?? args.seller_id)!;
  }
  async prepay(agentKey: string, purchaseId: string, buyerId: string) {
    const args = { purchase_id: purchaseId, buyer_id: buyerId };
    return must(await this.chain.callAsAgent(this.agentId(args), agentKey, "prepay", args, { purpose: "prepay", purchaseId }));
  }
  async commitBid(agentKey: string, purchaseId: string, sellerId: string, commitmentHex: string) {
    const args = { purchase_id: purchaseId, seller_id: sellerId, commitment_hex: commitmentHex };
    return must(await this.chain.callAsAgent(sellerId, agentKey, "commit_bid", args, { purpose: "commit_bid", purchaseId }));
  }
  async revealBid(agentKey: string, purchaseId: string, sellerId: string, pricePerHour: bigint, nonceHex: string) {
    const args = { purchase_id: purchaseId, seller_id: sellerId, price_per_hour: pricePerHour.toString(), nonce_hex: nonceHex };
    return must(await this.chain.callAsAgent(sellerId, agentKey, "reveal_bid", args, { purpose: "reveal_bid", purchaseId }));
  }
}
