//! Stored and JSON types. Money is `U128` (decimal string in JSON, RULES.md R3);
//! timestamps and block heights are `U64` (decimal string, they exceed 2^53).

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpuModel {
    A100,
    H100,
}

/// Escrow state machine (fair-price prepay model, see lib.rs).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PurchaseState {
    /// Members prepay their maximum.
    Created,
    Bidding,
    /// Settled at the clearing price; escrow holds exactly what members owe.
    Funded,
    Delivering,
    Verifying,
    Completed,
    Failed,
    Expired,
    /// Everything held for this purchase was credited back to the buyers.
    Refunded,
}

impl PurchaseState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Created => "CREATED",
            Self::Bidding => "BIDDING",
            Self::Funded => "FUNDED",
            Self::Delivering => "DELIVERING",
            Self::Verifying => "VERIFYING",
            Self::Completed => "COMPLETED",
            Self::Failed => "FAILED",
            Self::Expired => "EXPIRED",
            Self::Refunded => "REFUNDED",
        }
    }
}

/// What a buyer agent's owner wants to buy. Stored on chain (RULES.md R22):
/// the operator can group this agent into a coalition, but only on these terms.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BuyerRequest {
    pub gpu_model: GpuModel,
    /// Minimum VRAM per GPU.
    pub vram_gb: u32,
    pub hours: u32,
    /// The most this agent will pay per GPU-hour; it prepays hours × this.
    pub max_price_per_hour: U128,
    /// Nanoseconds since epoch. The agent isn't grouped after this.
    pub deadline: U64,
}

/// A buyer agent: its own sub-account of the marketplace, opened by `owner` (RULES.md R19–R21).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Buyer {
    /// The agent's account id, `<name>.<marketplace contract>`.
    pub buyer_id: String,
    /// The wallet that opened the agent. Every refund and withdrawal goes here (R11).
    pub owner: AccountId,
    /// False until the agent's account and key exist on chain.
    pub opened: bool,
    pub created_at: U64,
    /// The open request, if any. Cleared when a purchase for it completes.
    pub request: Option<BuyerRequest>,
    /// The coalition this agent is in, while that coalition is live.
    pub coalition_id: Option<String>,
    /// Deposited and credited money, free to reserve or withdraw.
    pub available: U128,
    /// Prepaid/owed in purchases that are still live.
    pub reserved: U128,
    /// Paid to sellers in completed purchases.
    pub spent: U128,
    /// Amount of the withdrawal currently in flight (0 when none).
    pub withdrawing: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GpuOffer {
    pub gpu_model: GpuModel,
    pub vram_gb: u32,
    pub capacity_hours: u32,
}

/// Updated only by contract transitions.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reputation {
    pub wins: u32,
    pub completed_deliveries: u32,
    pub failed_deliveries: u32,
    pub non_reveals: u32,
}

impl Reputation {
    /// Tie-break score: higher is better.
    pub fn score(&self) -> i64 {
        self.completed_deliveries as i64 - self.failed_deliveries as i64 - self.non_reveals as i64
    }
}

/// How the agent host prices this seller's bids (RULES.md R24). The contract
/// enforces only the floor: no revealed price below `min_price_per_hour`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SellerStrategy {
    /// Bid the minimum price.
    AtMinimum,
    /// Bid `discount_bps` below the coalition's price ceiling, but never below the minimum.
    BelowCeiling { discount_bps: u16 },
}

/// A seller agent: its own sub-account of the marketplace, opened by `owner` (RULES.md R19, R20, R23).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seller {
    /// The agent's account id, `<name>.<marketplace contract>`.
    pub seller_id: String,
    /// The wallet that opened the agent. Payouts go here (R11). Fixed at opening.
    pub owner: AccountId,
    /// False until the agent's account and key exist on chain.
    pub opened: bool,
    pub created_at: U64,
    /// Whether the agent is taking new auctions.
    pub active: bool,
    pub offers: Vec<GpuOffer>,
    pub min_price_per_hour: U128,
    pub strategy: SellerStrategy,
    pub reputation: Reputation,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoalitionMember {
    pub buyer_id: String,
    pub hours: u32,
    /// This member's own maximum price per GPU-hour; it prepays hours × this.
    pub max_price_per_hour: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coalition {
    pub coalition_id: String,
    pub gpu_model: GpuModel,
    pub vram_gb: u32,
    pub min_members: u32,
    pub members: Vec<CoalitionMember>,
    /// True once the coalition's purchase ended or it fell below `min_members`.
    /// Its members are then free to join another coalition.
    pub closed: bool,
    pub live_purchase_id: Option<String>,
}

impl Coalition {
    pub fn total_hours(&self) -> u32 {
        self.members.iter().map(|m| m.hours).sum()
    }
    /// Lowest member max price: no member can be charged more than its own max.
    pub fn price_ceiling(&self) -> u128 {
        self.members.iter().map(|m| m.max_price_per_hour.0).min().unwrap_or(0)
    }
    /// Sum of members' prepayments (hours × own max price).
    pub fn total_budget(&self) -> u128 {
        self.members.iter().map(|m| m.max_price_per_hour.0 * m.hours as u128).sum()
    }
}

/// Phase lengths in seconds. Absolute deadlines are fixed when each phase starts.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Windows {
    pub prepay_secs: u32,
    pub commit_secs: u32,
    pub reveal_secs: u32,
    pub delivery_secs: u32,
    pub verification_secs: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bid {
    pub seller_id: String,
    pub commitment_hex: String,
    pub commit_block_height: U64,
    pub revealed_price_per_hour: Option<U128>,
    pub reveal_block_height: Option<U64>,
    pub eligible: Option<bool>,
    pub ineligibility_reason: Option<String>,
}

/// One member's money in one purchase. Fairness is visible field by field:
/// `owed = hours × clearing_price` for every member (same rate),
/// `excess = prepaid − owed` goes back to the member's available balance.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Allocation {
    pub buyer_id: String,
    pub hours: u32,
    pub max_price_per_hour: U128,
    pub prepaid: U128,
    /// Set at award: hours × clearing price.
    pub owed: U128,
    /// Set at award: prepaid − owed, credited to the buyer's available balance.
    pub excess: U128,
    /// Credited back after a failure (owed, or prepaid if never awarded).
    pub refunded: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Purchase {
    pub purchase_id: String,
    pub auction_id: String,
    pub coalition_id: String,
    pub state: PurchaseState,
    pub windows: Windows,
    pub created_at: U64,
    pub prepay_deadline: U64,
    pub commit_deadline: Option<U64>,
    pub reveal_deadline: Option<U64>,
    pub delivery_deadline: Option<U64>,
    pub verification_deadline: Option<U64>,
    pub bids: Vec<Bid>,
    pub winner_seller_id: Option<String>,
    /// The one price every member pays.
    pub clearing_price_per_hour: Option<U128>,
    pub required_total: Option<U128>,
    pub allocations: Vec<Allocation>,
    /// Total ever prepaid by members.
    pub deposited: U128,
    /// Escrow currently held for this purchase. Sum over purchases == total_escrowed.
    pub held: U128,
    pub delivery_report_hash: Option<String>,
    pub verified_success: Option<bool>,
    pub verification_reason: Option<String>,
    pub payout_in_flight: bool,
    pub paid_out: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub owner: AccountId,
    pub operator: AccountId,
    pub verifier: AccountId,
    pub paused: bool,
    pub total_escrowed: U128,
    pub total_balances: U128,
    pub buyer_count: u32,
    pub seller_count: u32,
    pub purchase_count: u32,
    /// What `open_buyer_agent` / `open_seller_agent` costs on top of a buyer's budget.
    pub open_fee: U128,
    /// The part of `open_fee` sent to the new agent account for its own gas.
    pub agent_gas_fund: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Solvency {
    pub account_balance: U128,
    pub storage_cost: U128,
    pub total_escrowed: U128,
    pub total_balances: U128,
}
