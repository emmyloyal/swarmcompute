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

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Buyer {
    pub buyer_id: String,
    pub max_budget: U128,
    /// The buyer agent's own testnet wallet: it prepays from here and every
    /// balance (excess over the clearing price, refunds) is sent back here.
    pub wallet: AccountId,
    /// Prepaid/owed in purchases that are still live.
    pub reserved: U128,
    /// Paid to sellers in completed purchases.
    pub spent: U128,
    /// Credited to this buyer and not yet withdrawn to its wallet.
    pub balance: U128,
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

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seller {
    pub seller_id: String,
    /// REAL testnet account. Immutable after registration (RULES.md R11).
    pub payout_account_id: AccountId,
    pub offers: Vec<GpuOffer>,
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
    pub failed: bool,
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
/// `excess = prepaid − owed` is returned to the member's own wallet.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Allocation {
    pub buyer_id: String,
    pub hours: u32,
    pub max_price_per_hour: U128,
    pub prepaid: U128,
    /// Set at award: hours × clearing price.
    pub owed: U128,
    /// Set at award: prepaid − owed, credited to the buyer's balance.
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
    pub seller_count: u32,
    pub purchase_count: u32,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Solvency {
    pub account_balance: U128,
    pub storage_cost: U128,
    pub total_escrowed: U128,
    pub total_balances: U128,
}
