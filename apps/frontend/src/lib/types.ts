/** Shapes served by the market host API (mirrors apps/backend/src/chain/marketplace.ts). Money is yocto strings. */
export type GpuModel = "A100" | "H100";
export const GPU_MODELS: GpuModel[] = ["A100", "H100"];

export interface BuyerRequest {
  gpu_model: GpuModel;
  vram_gb: number;
  hours: number;
  max_price_per_hour: string;
  deadline: string;
}

export interface Buyer {
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

export interface Seller {
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

export interface Coalition {
  coalition_id: string;
  gpu_model: GpuModel;
  vram_gb: number;
  min_members: number;
  members: { buyer_id: string; hours: number; max_price_per_hour: string }[];
  closed: boolean;
  live_purchase_id: string | null;
}

export interface Bid {
  seller_id: string;
  commitment_hex: string;
  commit_block_height: string;
  revealed_price_per_hour: string | null;
  eligible: boolean | null;
  ineligibility_reason: string | null;
}

export interface Allocation {
  buyer_id: string;
  hours: number;
  max_price_per_hour: string;
  prepaid: string;
  owed: string;
  excess: string;
  refunded: string;
}

export type PurchaseState = "CREATED" | "BIDDING" | "FUNDED" | "DELIVERING" | "VERIFYING" | "COMPLETED" | "FAILED" | "EXPIRED" | "REFUNDED";
export const FINISHED: PurchaseState[] = ["COMPLETED", "FAILED", "EXPIRED", "REFUNDED"];

export interface Purchase {
  purchase_id: string;
  auction_id: string;
  coalition_id: string;
  state: PurchaseState;
  created_at: string;
  prepay_deadline: string;
  commit_deadline: string | null;
  reveal_deadline: string | null;
  delivery_deadline: string | null;
  verification_deadline: string | null;
  bids: Bid[];
  winner_seller_id: string | null;
  clearing_price_per_hour: string | null;
  required_total: string | null;
  allocations: Allocation[];
  held: string;
  verified_success: boolean | null;
  paid_out: string;
}

export interface Config {
  total_escrowed: string;
  total_balances: string;
  buyer_count: number;
  seller_count: number;
  purchase_count: number;
  open_fee: string;
  agent_gas_fund: string;
  max_agents_per_owner: number;
  sponsor_pool: string;
  paused: boolean;
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

export interface Market {
  updatedAt: string;
  chainTimeNs: string;
  tick: number;
  config: Config | null;
  buyers: Buyer[];
  sellers: Seller[];
  purchases: Purchase[];
  coalitions: Record<string, Coalition>;
  waiting: Record<string, WaitReason>;
  hosted: string[];
  lastError: string | null;
  /** "chain": read straight from the contract because the market host is offline. */
  source?: "host" | "chain";
}

export interface Activity {
  id: string;
  at: string;
  level: "INFO" | "WARN" | "ERROR";
  kind: string;
  message: string;
  purchase_id: string | null;
  agent_id: string | null;
  tx_hash: string | null;
  simulated: boolean;
}

export interface Windows {
  prepay_secs: number;
  commit_secs: number;
  reveal_secs: number;
  delivery_secs: number;
  verification_secs: number;
}
