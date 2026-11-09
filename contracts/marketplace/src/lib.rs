//! SwarmCompute marketplace contract: real users' agents buying GPU time together
//! at one fair price.
//!
//! Agents (RULES.md R19–R25): a user opens a buyer or seller agent from their own
//! wallet. The contract creates the agent's sub-account `<name>.<this contract>`
//! with one function-call key that can only call this contract's agent methods.
//! The opening wallet is the agent's owner: every payout, refund and withdrawal
//! goes to an owner wallet, never anywhere else.
//!
//! Every coalition purchase is one escrow:
//!
//! ```text
//! CREATED  members prepay hours × their OWN max price, from their available balance
//!    │ open_bidding (all members prepaid)
//! BIDDING  sealed commit → reveal, each signed by the seller agent's own account
//!    │ close_auction: lowest eligible bid wins = the clearing price
//!    ├── winner ──▶ FUNDED   every member owes hours × clearing price (one rate);
//!    │                       prepaid − owed goes back to the member's available balance
//!    └── none ────▶ FAILED ─▶ REFUNDED  (all prepayments credited back)
//! FUNDED ─start_delivery─▶ DELIVERING ─submit_delivery_report─▶ VERIFYING
//! VERIFYING ─verify(ok) + payout callback ok─▶ COMPLETED (seller's owner paid)
//! VERIFYING ─verify(fail)─▶ FAILED ─▶ REFUNDED   (each member's owed credited back)
//! CREATED (prepay deadline) | FUNDED/DELIVERING (delivery deadline) |
//! VERIFYING (verification deadline) ─expire (anyone)─▶ EXPIRED ─▶ REFUNDED
//! ```
//!
//! Fairness guarantees, all checked on-chain:
//!   1. No member pays more than its own max price (ceiling = lowest member max).
//!   2. Every member of a purchase pays the same clearing price per hour.
//!   3. The clearing price is the lowest eligible revealed bid.
//!   4. Everything a member prepaid beyond hours × clearing price comes back to it.
//!   5. A failed or expired purchase returns each member's money to that member.
//!   6. Members' terms are the ones their owners stored; the operator can't change them.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PublicKey};

mod commitment;
mod events;
mod types;
mod validate;

use events::emit;
pub use types::*;
use validate::{is_agent_name, is_entity_id, parse_hex32, to_hex};

pub const MAX_MEMBERS: usize = 32;
pub const MAX_OFFERS: usize = 4;
pub const MAX_HOURS: u32 = 1_000_000;
pub const MAX_WINDOW_SECS: u32 = 30 * 24 * 3600;
pub const MAX_REASON_LEN: usize = 256;
pub const MAX_DISCOUNT_BPS: u16 = 9_999;
/// Sent to each new agent account so it can pay for its own transactions. NEAR charges
/// attached gas upfront at a pessimistic price (~0.03 NEAR for a 30 Tgas call, refunded
/// after), so this must cover that, not just the gas burnt. Anyone can top an agent
/// account up with a plain transfer.
pub const AGENT_GAS_FUND: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
/// Kept by the contract to cover the agent's record in contract storage.
pub const AGENT_STORAGE_FEE: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
pub const OPEN_FEE: u128 = AGENT_GAS_FUND + AGENT_STORAGE_FEE;
/// The only methods an agent's function-call key may call (RULES.md R19).
pub const AGENT_METHODS: &str = "prepay,commit_bid,reveal_bid,withdraw,leave_coalition";
const NS_PER_SEC: u64 = 1_000_000_000;
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_FOR_OPEN_CALLBACK: Gas = Gas::from_tgas(20);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Buyers,
    BuyerIds,
    Sellers,
    SellerIds,
    Coalitions,
    Purchases,
    PurchaseIds,
    Auctions,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Marketplace {
    owner: AccountId,
    operator: AccountId,
    verifier: AccountId,
    paused: bool,
    /// Sum of `held` over all purchases.
    total_escrowed: u128,
    /// Sum of buyer agents' `available` balances.
    total_balances: u128,
    buyers: LookupMap<String, Buyer>,
    buyer_ids: Vector<String>,
    sellers: LookupMap<String, Seller>,
    seller_ids: Vector<String>,
    coalitions: LookupMap<String, Coalition>,
    purchases: LookupMap<String, Purchase>,
    purchase_ids: Vector<String>,
    auctions: LookupMap<String, String>,
}

fn now() -> u64 {
    env::block_timestamp()
}

fn secs(s: u32) -> u64 {
    s as u64 * NS_PER_SEC
}

fn mul_price_hours(price: u128, hours: u32) -> u128 {
    price.checked_mul(hours as u128).unwrap_or_else(|| env::panic_str("amount overflows u128"))
}

fn validate_request(r: &BuyerRequest) {
    require!(r.vram_gb > 0, "vram_gb must be positive");
    require!(r.hours > 0 && r.hours <= MAX_HOURS, "invalid hours");
    require!(r.max_price_per_hour.0 > 0, "max_price_per_hour must be positive");
    mul_price_hours(r.max_price_per_hour.0, r.hours);
    require!(r.deadline.0 > now(), "request deadline must be in the future");
}

fn validate_offers(offers: &[GpuOffer]) {
    require!(!offers.is_empty() && offers.len() <= MAX_OFFERS, "1..=4 offers required");
    for o in offers {
        require!(o.vram_gb > 0, "vram_gb must be positive");
        require!(o.capacity_hours > 0 && o.capacity_hours <= MAX_HOURS, "invalid capacity_hours");
    }
}

fn validate_pricing(min_price_per_hour: U128, strategy: &SellerStrategy) {
    require!(min_price_per_hour.0 > 0, "min_price_per_hour must be positive");
    if let SellerStrategy::BelowCeiling { discount_bps } = strategy {
        require!(*discount_bps <= MAX_DISCOUNT_BPS, "discount_bps must be below 10000");
    }
}

#[near]
impl Marketplace {
    #[init]
    pub fn new(owner: AccountId, operator: AccountId, verifier: AccountId) -> Self {
        let me = env::current_account_id();
        require!(operator != me && verifier != me, "a role cannot be the contract account");
        emit("contract_initialized", json!({ "owner": owner, "operator": operator, "verifier": verifier }));
        Self {
            owner,
            operator,
            verifier,
            paused: false,
            total_escrowed: 0,
            total_balances: 0,
            buyers: LookupMap::new(StorageKey::Buyers),
            buyer_ids: Vector::new(StorageKey::BuyerIds),
            sellers: LookupMap::new(StorageKey::Sellers),
            seller_ids: Vector::new(StorageKey::SellerIds),
            coalitions: LookupMap::new(StorageKey::Coalitions),
            purchases: LookupMap::new(StorageKey::Purchases),
            purchase_ids: Vector::new(StorageKey::PurchaseIds),
            auctions: LookupMap::new(StorageKey::Auctions),
        }
    }

    // ------------------------------------------------------------------ owner

    pub fn set_roles(&mut self, operator: Option<AccountId>, verifier: Option<AccountId>) {
        self.assert_owner();
        let me = env::current_account_id();
        if let Some(a) = operator {
            require!(a != me, "a role cannot be the contract account");
            self.operator = a;
        }
        if let Some(a) = verifier {
            require!(a != me, "a role cannot be the contract account");
            self.verifier = a;
        }
        emit("roles_updated", json!({ "operator": self.operator, "verifier": self.verifier }));
    }

    pub fn set_owner(&mut self, new_owner: AccountId) {
        self.assert_owner();
        emit("owner_updated", json!({ "old_owner": self.owner, "new_owner": new_owner }));
        self.owner = new_owner;
    }

    /// Pause blocks opening agents, deposits, prepay, bidding, delivery, verification and payouts.
    /// It never blocks `expire`, `withdraw` or callbacks: owners' money can't be trapped.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit("paused_updated", json!({ "paused": paused }));
    }

    // ------------------------------------------------------------------ opening agents (R19, R20)

    /// Open a buyer agent. Attach `OPEN_FEE` plus whatever budget to deposit now.
    /// Creates `<name>.<this contract>` with a function-call key for `public_key`.
    #[payable]
    pub fn open_buyer_agent(&mut self, name: String, public_key: PublicKey, request: Option<BuyerRequest>) {
        self.assert_not_paused();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= OPEN_FEE, "attached deposit must cover the open fee");
        if let Some(r) = &request {
            validate_request(r);
        }
        let (agent_id, owner) = self.new_agent_id(&name);
        let budget = deposit - OPEN_FEE;
        emit(
            "agent_open_started",
            json!({ "agent_id": agent_id, "role": "BUYER", "owner": owner, "public_key": public_key, "budget": U128(budget), "request": request }),
        );
        self.buyers.insert(
            agent_id.to_string(),
            Buyer {
                buyer_id: agent_id.to_string(),
                owner,
                opened: false,
                created_at: U64(now()),
                request,
                coalition_id: None,
                available: U128(0),
                reserved: U128(0),
                spent: U128(0),
                withdrawing: U128(0),
            },
        );
        self.create_agent_account(agent_id, public_key, budget);
    }

    /// Open a seller agent. Attach exactly `OPEN_FEE`. Payouts for its wins go to the opening wallet.
    #[payable]
    pub fn open_seller_agent(&mut self, name: String, public_key: PublicKey, offers: Vec<GpuOffer>, min_price_per_hour: U128, strategy: SellerStrategy) {
        self.assert_not_paused();
        require!(env::attached_deposit().as_yoctonear() == OPEN_FEE, "attached deposit must equal the open fee exactly");
        validate_offers(&offers);
        validate_pricing(min_price_per_hour, &strategy);
        let (agent_id, owner) = self.new_agent_id(&name);
        emit(
            "agent_open_started",
            json!({
                "agent_id": agent_id, "role": "SELLER", "owner": owner, "public_key": public_key,
                "offers": offers, "min_price_per_hour": min_price_per_hour, "strategy": strategy,
            }),
        );
        self.sellers.insert(
            agent_id.to_string(),
            Seller {
                seller_id: agent_id.to_string(),
                owner,
                opened: false,
                created_at: U64(now()),
                active: true,
                offers,
                min_price_per_hour,
                strategy,
                reputation: Reputation::default(),
            },
        );
        self.create_agent_account(agent_id, public_key, 0);
    }

    /// Completes `open_*_agent`. On failure the record is removed and the owner gets everything back.
    #[private]
    pub fn on_agent_opened(&mut self, agent_id: String, budget: U128) -> bool {
        let ok = Self::promise_succeeded();
        if let Some(mut b) = self.buyers.get(&agent_id).cloned() {
            require!(!b.opened, "agent already opened");
            if ok {
                b.opened = true;
                b.available = U128(budget.0);
                self.total_balances += budget.0;
                self.buyer_ids.push(agent_id.clone());
                emit("agent_opened", json!({ "agent_id": agent_id, "role": "BUYER", "owner": b.owner, "available": b.available }));
                self.buyers.insert(agent_id, b);
            } else {
                self.buyers.remove(&agent_id);
                self.refund_failed_open(&agent_id, "BUYER", b.owner, budget.0 + OPEN_FEE);
            }
        } else if let Some(mut s) = self.sellers.get(&agent_id).cloned() {
            require!(!s.opened, "agent already opened");
            if ok {
                s.opened = true;
                self.seller_ids.push(agent_id.clone());
                emit("agent_opened", json!({ "agent_id": agent_id, "role": "SELLER", "owner": s.owner }));
                self.sellers.insert(agent_id, s);
            } else {
                self.sellers.remove(&agent_id);
                self.refund_failed_open(&agent_id, "SELLER", s.owner, OPEN_FEE);
            }
        } else {
            env::panic_str("agent not found");
        }
        ok
    }

    // ------------------------------------------------------------------ buyer agents (owner)

    /// Add budget to a buyer agent. Owner only.
    #[payable]
    pub fn deposit(&mut self, buyer_id: String) {
        self.assert_not_paused();
        let mut b = self.opened_buyer(&buyer_id);
        Self::assert_owner_of(&b.owner);
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "attach the amount to deposit");
        b.available = U128(b.available.0 + amount);
        self.total_balances += amount;
        emit("buyer_deposited", json!({ "buyer_id": buyer_id, "owner": b.owner, "amount": U128(amount), "available": b.available }));
        self.buyers.insert(buyer_id, b);
    }

    /// Set, replace or close (`None`) a buyer agent's request. Owner only, and not while in a coalition.
    pub fn set_request(&mut self, buyer_id: String, request: Option<BuyerRequest>) {
        self.assert_not_paused();
        let mut b = self.opened_buyer(&buyer_id);
        Self::assert_owner_of(&b.owner);
        require!(b.coalition_id.is_none(), "leave the coalition before changing the request");
        if let Some(r) = &request {
            validate_request(r);
        }
        emit("buyer_request_updated", json!({ "buyer_id": buyer_id, "request": request }));
        b.request = request;
        self.buyers.insert(buyer_id, b);
    }

    /// Send some (`amount`) or all of a buyer agent's available balance to its owner.
    /// The agent or its owner may call; the destination is always the owner (R11).
    /// One withdrawal in flight per agent. Never blocked by pause.
    pub fn withdraw(&mut self, buyer_id: String, amount: Option<U128>) {
        let mut b = self.opened_buyer(&buyer_id);
        let caller = env::predecessor_account_id();
        require!(caller == b.owner || caller.as_str() == b.buyer_id, "only the agent or its owner");
        require!(b.withdrawing.0 == 0, "withdrawal already in flight");
        let amount = amount.map_or(b.available.0, |a| a.0);
        require!(amount > 0, "nothing to withdraw");
        require!(amount <= b.available.0, "amount exceeds available balance");
        self.assert_solvent();
        b.available = U128(b.available.0 - amount);
        b.withdrawing = U128(amount);
        self.total_balances -= amount;
        let to = b.owner.clone();
        emit("withdrawal_started", json!({ "buyer_id": buyer_id, "owner": to, "amount": U128(amount), "available": b.available }));
        self.buyers.insert(buyer_id.clone(), b);
        Promise::new(to)
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_withdraw(buyer_id))
            .detach();
    }

    #[private]
    pub fn on_withdraw(&mut self, buyer_id: String) -> bool {
        let mut b = self.buyer(&buyer_id);
        let amount = b.withdrawing.0;
        require!(amount > 0, "no withdrawal in flight");
        b.withdrawing = U128(0);
        let ok = Self::promise_succeeded();
        if ok {
            emit("withdrawal_succeeded", json!({ "buyer_id": buyer_id, "owner": b.owner, "amount": U128(amount), "available": b.available }));
        } else {
            // The transfer bounced: the money is back in the contract, so it's available again.
            b.available = U128(b.available.0 + amount);
            self.total_balances += amount;
            emit("withdrawal_failed", json!({ "buyer_id": buyer_id, "owner": b.owner, "amount": U128(amount), "available": b.available, "retryable": true }));
        }
        self.buyers.insert(buyer_id, b);
        ok
    }

    // ------------------------------------------------------------------ seller agents (owner)

    /// Change a seller agent's offers, pricing or whether it takes new auctions. Owner only.
    /// The payout destination (the owner) can't change.
    pub fn update_seller(
        &mut self,
        seller_id: String,
        offers: Option<Vec<GpuOffer>>,
        min_price_per_hour: Option<U128>,
        strategy: Option<SellerStrategy>,
        active: Option<bool>,
    ) {
        self.assert_not_paused();
        let mut s = self.opened_seller(&seller_id);
        Self::assert_owner_of(&s.owner);
        if let Some(o) = offers {
            validate_offers(&o);
            s.offers = o;
        }
        if let Some(p) = min_price_per_hour {
            s.min_price_per_hour = p;
        }
        if let Some(st) = strategy {
            s.strategy = st;
        }
        validate_pricing(s.min_price_per_hour, &s.strategy);
        if let Some(a) = active {
            s.active = a;
        }
        emit(
            "seller_updated",
            json!({ "seller_id": seller_id, "offers": s.offers, "min_price_per_hour": s.min_price_per_hour, "strategy": s.strategy, "active": s.active }),
        );
        self.sellers.insert(seller_id, s);
    }

    // ------------------------------------------------------------------ coalitions (R22)

    /// Group buyer agents with open, compatible requests. Every member's hours and max
    /// price come from its own stored request; GPU model and VRAM are derived from them.
    pub fn register_coalition(&mut self, coalition_id: String, buyer_ids: Vec<String>, min_members: u32) {
        self.assert_operator();
        self.assert_not_paused();
        require!(is_entity_id(&coalition_id), "invalid coalition_id");
        require!(!self.coalitions.contains_key(&coalition_id), "coalition already registered");
        require!(min_members >= 1, "min_members must be >= 1");
        require!(!buyer_ids.is_empty() && buyer_ids.len() <= MAX_MEMBERS, "1..=32 members required");
        require!(buyer_ids.len() as u32 >= min_members, "fewer members than min_members");
        let mut members = Vec::with_capacity(buyer_ids.len());
        let mut gpu_model = None;
        let mut vram_gb = 0;
        let mut total_hours: u64 = 0;
        for (i, id) in buyer_ids.iter().enumerate() {
            require!(!buyer_ids[..i].contains(id), "duplicate member");
            let b = self.opened_buyer(id);
            require!(b.coalition_id.is_none(), "buyer is already in a coalition");
            let r = b.request.clone().unwrap_or_else(|| env::panic_str("buyer has no open request"));
            require!(r.deadline.0 > now(), "buyer's request deadline has passed");
            match gpu_model {
                None => gpu_model = Some(r.gpu_model),
                Some(m) => require!(m == r.gpu_model, "members want different GPU models"),
            }
            vram_gb = vram_gb.max(r.vram_gb);
            total_hours += r.hours as u64;
            members.push(CoalitionMember { buyer_id: id.clone(), hours: r.hours, max_price_per_hour: r.max_price_per_hour });
        }
        require!(total_hours <= MAX_HOURS as u64, "total hours too large");
        // Every check passed: only now mark the members as grouped.
        for id in &buyer_ids {
            let mut b = self.buyer(id);
            b.coalition_id = Some(coalition_id.clone());
            self.buyers.insert(id.clone(), b);
        }
        let gpu_model = gpu_model.unwrap();
        let c = Coalition { coalition_id: coalition_id.clone(), gpu_model, vram_gb, min_members, members, closed: false, live_purchase_id: None };
        emit(
            "coalition_registered",
            json!({
                "coalition_id": coalition_id, "gpu_model": gpu_model, "vram_gb": vram_gb, "min_members": min_members,
                "members": c.members, "total_hours": total_hours,
                "price_ceiling_per_hour": U128(c.price_ceiling()), "total_budget": U128(c.total_budget()),
            }),
        );
        self.coalitions.insert(coalition_id, c);
    }

    /// Leave before FUNDED. The operator, the buyer agent or its owner may call.
    /// Anything the member prepaid goes back to its available balance.
    /// Below min_members the coalition closes and everyone's prepayment is credited back.
    pub fn leave_coalition(&mut self, coalition_id: String, buyer_id: String) {
        self.assert_not_paused();
        let b = self.buyer(&buyer_id);
        let caller = env::predecessor_account_id();
        require!(caller == self.operator || caller == b.owner || caller.as_str() == b.buyer_id, "only the operator, the agent or its owner");
        let mut c = self.coalition(&coalition_id);
        require!(!c.closed, "coalition is closed");
        let idx = c.members.iter().position(|m| m.buyer_id == buyer_id).unwrap_or_else(|| env::panic_str("buyer is not a member"));
        let mut live = c.live_purchase_id.as_ref().map(|id| self.purchase(id));
        if let Some(p) = &live {
            require!(matches!(p.state, PurchaseState::Created | PurchaseState::Bidding), "cannot leave after funding");
        }
        c.members.remove(idx);
        self.release_member(&buyer_id, false);
        let below_min = (c.members.len() as u32) < c.min_members;
        emit(
            "coalition_member_left",
            json!({ "coalition_id": coalition_id, "buyer_id": buyer_id, "remaining_members": c.members.len(), "coalition_closed": below_min }),
        );
        self.coalitions.insert(coalition_id.clone(), c);
        if let Some(p) = live.as_mut() {
            if let Some(pos) = p.allocations.iter().position(|a| a.buyer_id == buyer_id) {
                let a = p.allocations.remove(pos);
                self.credit_from(p, &a.buyer_id, a.prepaid.0, "left_coalition");
            }
            if below_min {
                self.transition(p, PurchaseState::Failed, "coalition_below_min_members");
                self.refund_all(p, "coalition_failed");
            }
        }
        if below_min {
            self.close_coalition(&coalition_id, false);
        }
        if let Some(p) = live {
            self.purchases.insert(p.purchase_id.clone(), p);
        }
    }

    // ------------------------------------------------------------------ purchase + prepay

    pub fn create_purchase(&mut self, purchase_id: String, auction_id: String, coalition_id: String, windows: Windows) {
        self.assert_operator();
        self.assert_not_paused();
        require!(is_entity_id(&purchase_id), "invalid purchase_id");
        require!(is_entity_id(&auction_id), "invalid auction_id");
        require!(!self.purchases.contains_key(&purchase_id), "purchase already exists");
        require!(!self.auctions.contains_key(&auction_id), "auction_id already used");
        for w in [windows.prepay_secs, windows.commit_secs, windows.reveal_secs, windows.delivery_secs, windows.verification_secs] {
            require!(w >= 1 && w <= MAX_WINDOW_SECS, "window out of range");
        }
        let mut c = self.coalition(&coalition_id);
        require!(!c.closed, "coalition is closed");
        require!(c.live_purchase_id.is_none(), "coalition already has a live purchase");
        c.live_purchase_id = Some(purchase_id.clone());
        self.coalitions.insert(coalition_id.clone(), c);
        let prepay_deadline = now() + secs(windows.prepay_secs);
        emit(
            "purchase_created",
            json!({ "purchase_id": purchase_id, "auction_id": auction_id, "coalition_id": coalition_id, "windows": windows, "prepay_deadline": U64(prepay_deadline) }),
        );
        let p = Purchase {
            purchase_id: purchase_id.clone(),
            auction_id: auction_id.clone(),
            coalition_id,
            state: PurchaseState::Created,
            windows,
            created_at: U64(now()),
            prepay_deadline: U64(prepay_deadline),
            commit_deadline: None,
            reveal_deadline: None,
            delivery_deadline: None,
            verification_deadline: None,
            bids: vec![],
            winner_seller_id: None,
            clearing_price_per_hour: None,
            required_total: None,
            allocations: vec![],
            deposited: U128(0),
            held: U128(0),
            delivery_report_hash: None,
            verified_success: None,
            verification_reason: None,
            payout_in_flight: false,
            paid_out: U128(0),
        };
        self.auctions.insert(auction_id, purchase_id.clone());
        self.purchase_ids.push(purchase_id.clone());
        self.purchases.insert(purchase_id, p);
    }

    /// A member agent reserves exactly hours × its own max price from its available
    /// balance. Signed by the buyer agent's own account (R8).
    pub fn prepay(&mut self, purchase_id: String, buyer_id: String) {
        self.assert_not_paused();
        let mut p = self.purchase(&purchase_id);
        Self::require_state(&p, PurchaseState::Created);
        require!(now() < p.prepay_deadline.0, "prepay deadline passed");
        let mut b = self.opened_buyer(&buyer_id);
        require!(env::predecessor_account_id().as_str() == b.buyer_id, "only the buyer agent's own account can prepay");
        require!(b.coalition_id.as_deref() == Some(p.coalition_id.as_str()), "not a member of this coalition");
        require!(!p.allocations.iter().any(|a| a.buyer_id == buyer_id), "already prepaid");
        let c = self.coalition(&p.coalition_id);
        let m = c.members.iter().find(|m| m.buyer_id == buyer_id).unwrap_or_else(|| env::panic_str("not a member of this coalition"));
        let amount = mul_price_hours(m.max_price_per_hour.0, m.hours);
        require!(amount <= b.available.0, "available balance is below hours × own max price");
        b.available = U128(b.available.0 - amount);
        b.reserved = U128(b.reserved.0 + amount);
        self.buyers.insert(buyer_id.clone(), b);
        self.total_balances -= amount;
        p.allocations.push(Allocation {
            buyer_id: buyer_id.clone(),
            hours: m.hours,
            max_price_per_hour: m.max_price_per_hour,
            prepaid: U128(amount),
            owed: U128(0),
            excess: U128(0),
            refunded: U128(0),
        });
        p.deposited = U128(p.deposited.0 + amount);
        p.held = U128(p.held.0 + amount);
        self.total_escrowed += amount;
        self.assert_solvent();
        emit(
            "prepaid",
            json!({ "purchase_id": purchase_id, "buyer_id": buyer_id, "hours": m.hours, "max_price_per_hour": m.max_price_per_hour, "amount": U128(amount), "held": p.held }),
        );
        self.purchases.insert(purchase_id, p);
    }

    /// Bidding opens only when every current member has prepaid.
    pub fn open_bidding(&mut self, purchase_id: String) {
        self.assert_operator();
        self.assert_not_paused();
        let mut p = self.purchase(&purchase_id);
        Self::require_state(&p, PurchaseState::Created);
        let c = self.coalition(&p.coalition_id);
        require!(
            c.members.iter().all(|m| p.allocations.iter().any(|a| a.buyer_id == m.buyer_id)),
            "every member must prepay before bidding opens"
        );
        let commit_deadline = now() + secs(p.windows.commit_secs);
        let reveal_deadline = commit_deadline + secs(p.windows.reveal_secs);
        p.commit_deadline = Some(U64(commit_deadline));
        p.reveal_deadline = Some(U64(reveal_deadline));
        self.transition(&mut p, PurchaseState::Bidding, "open_bidding");
        emit(
            "bidding_opened",
            json!({ "purchase_id": purchase_id, "auction_id": p.auction_id, "commit_deadline": U64(commit_deadline), "reveal_deadline": U64(reveal_deadline), "held": p.held }),
        );
        self.purchases.insert(purchase_id, p);
    }

    // ------------------------------------------------------------------ auction (R23)

    /// Signed by the seller agent's own account.
    pub fn commit_bid(&mut self, purchase_id: String, seller_id: String, commitment_hex: String) {
        self.assert_not_paused();
        let mut p = self.purchase(&purchase_id);
        Self::require_state(&p, PurchaseState::Bidding);
        require!(now() < p.commit_deadline.unwrap().0, "commit phase is over");
        let s = self.opened_seller(&seller_id);
        require!(env::predecessor_account_id().as_str() == s.seller_id, "only the seller agent's own account can bid");
        require!(s.active, "seller agent is not active");
        require!(parse_hex32(&commitment_hex).is_some(), "commitment must be 32 bytes lowercase hex");
        require!(!p.bids.iter().any(|b| b.seller_id == seller_id), "seller already committed");
        let height = env::block_height();
        emit(
            "bid_committed",
            json!({ "purchase_id": purchase_id, "auction_id": p.auction_id, "seller_id": seller_id, "commitment": commitment_hex, "block_height": U64(height) }),
        );
        p.bids.push(Bid {
            seller_id,
            commitment_hex,
            commit_block_height: U64(height),
            revealed_price_per_hour: None,
            reveal_block_height: None,
            eligible: None,
            ineligibility_reason: None,
        });
        self.purchases.insert(purchase_id, p);
    }

    /// Signed by the seller agent's own account. The price can't be below its own minimum.
    pub fn reveal_bid(&mut self, purchase_id: String, seller_id: String, price_per_hour: U128, nonce_hex: String) {
        self.assert_not_paused();
        let mut p = self.purchase(&purchase_id);
        Self::require_state(&p, PurchaseState::Bidding);
        let t = now();
        require!(t >= p.commit_deadline.unwrap().0, "reveal phase has not started");
        require!(t < p.reveal_deadline.unwrap().0, "reveal phase is over");
        let s = self.opened_seller(&seller_id);
        require!(env::predecessor_account_id().as_str() == s.seller_id, "only the seller agent's own account can reveal");
        require!(price_per_hour.0 >= s.min_price_per_hour.0, "price is below the seller's own minimum");
        let nonce = parse_hex32(&nonce_hex).unwrap_or_else(|| env::panic_str("nonce must be 32 bytes lowercase hex"));
        let auction_id = p.auction_id.clone();
        let bid = p.bids.iter_mut().find(|b| b.seller_id == seller_id).unwrap_or_else(|| env::panic_str("no commitment from this seller"));
        require!(bid.revealed_price_per_hour.is_none(), "already revealed");
        let computed = to_hex(&commitment::compute(&auction_id, &seller_id, price_per_hour.0, &nonce));
        require!(computed == bid.commitment_hex, "commitment mismatch");
        let height = env::block_height();
        bid.revealed_price_per_hour = Some(price_per_hour);
        bid.reveal_block_height = Some(U64(height));
        emit(
            "bid_revealed",
            json!({ "purchase_id": purchase_id, "auction_id": auction_id, "seller_id": seller_id, "price_per_hour": price_per_hour, "nonce": nonce_hex, "hash_verified": true, "block_height": U64(height) }),
        );
        self.purchases.insert(purchase_id, p);
    }

    /// Anyone may close after `reveal_deadline`. The lowest eligible bid becomes the
    /// clearing price for every member; each member's excess over it is credited back.
    pub fn close_auction(&mut self, purchase_id: String) {
        self.assert_not_paused();
        let mut p = self.purchase(&purchase_id);
        Self::require_state(&p, PurchaseState::Bidding);
        require!(now() >= p.reveal_deadline.unwrap().0, "reveal phase is not over");
        let c = self.coalition(&p.coalition_id);
        let hours = c.total_hours();
        let ceiling = c.price_ceiling();
        let budget = c.total_budget();

        let mut eligible: Vec<(u128, i64, u64, String)> = vec![];
        for bid in p.bids.iter_mut() {
            let mut seller = self.sellers.get(&bid.seller_id).unwrap().clone();
            let Some(price) = bid.revealed_price_per_hour else {
                seller.reputation.non_reveals += 1;
                bid.eligible = Some(false);
                bid.ineligibility_reason = Some("NOT_REVEALED".into());
                emit("reputation_updated", json!({ "seller_id": seller.seller_id, "purchase_id": purchase_id, "cause": "non_reveal", "reputation": seller.reputation }));
                self.sellers.insert(seller.seller_id.clone(), seller);
                continue;
            };
            let reason = Self::ineligibility(&seller, &c, hours, ceiling, budget, price.0);
            bid.eligible = Some(reason.is_none());
            bid.ineligibility_reason = reason.map(str::to_string);
            if reason.is_none() {
                eligible.push((price.0, seller.reputation.score(), bid.commit_block_height.0, seller.seller_id.clone()));
            }
        }
        eligible.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)).then(a.2.cmp(&b.2)).then(a.3.cmp(&b.3)));
        let bids_json: Vec<_> = p
            .bids
            .iter()
            .map(|b| json!({ "seller_id": b.seller_id, "eligible": b.eligible, "ineligibility_reason": b.ineligibility_reason }))
            .collect();

        match eligible.first().cloned() {
            None => {
                emit("auction_closed", json!({ "purchase_id": purchase_id, "auction_id": p.auction_id, "outcome": "FAILED", "bids": bids_json }));
                self.transition(&mut p, PurchaseState::Failed, "no_eligible_bid");
                self.refund_all(&mut p, "no_eligible_bid");
            }
            Some((price, _, _, winner)) => {
                // One clearing price for every member.
                let mut lines = vec![];
                let mut total: u128 = 0;
                let allocations = std::mem::take(&mut p.allocations);
                let mut settled = Vec::with_capacity(allocations.len());
                for mut a in allocations {
                    let owed = mul_price_hours(price, a.hours);
                    require!(owed <= a.prepaid.0, "clearing price above a member's max");
                    let excess = a.prepaid.0 - owed;
                    a.owed = U128(owed);
                    a.excess = U128(excess);
                    total += owed;
                    lines.push(json!({ "buyer_id": a.buyer_id, "hours": a.hours, "prepaid": a.prepaid, "owed": U128(owed), "excess": U128(excess) }));
                    settled.push(a);
                }
                for a in &settled {
                    if a.excess.0 > 0 {
                        self.credit_from(&mut p, &a.buyer_id, a.excess.0, "excess_over_clearing_price");
                    }
                }
                p.allocations = settled;
                require!(p.held.0 == total, "escrow must equal the sum owed");
                let deadline = now() + secs(p.windows.delivery_secs);
                p.winner_seller_id = Some(winner.clone());
                p.clearing_price_per_hour = Some(U128(price));
                p.required_total = Some(U128(total));
                p.delivery_deadline = Some(U64(deadline));
                let mut s = self.sellers.get(&winner).unwrap().clone();
                s.reputation.wins += 1;
                emit(
                    "auction_closed",
                    json!({
                        "purchase_id": purchase_id, "auction_id": p.auction_id, "outcome": "AWARDED",
                        "winner_seller_id": winner, "winning_price_per_hour": U128(price), "clearing_price_per_hour": U128(price),
                        "total_hours": hours, "required_total": U128(total), "bids": bids_json,
                    }),
                );
                emit(
                    "purchase_funded",
                    json!({ "purchase_id": purchase_id, "clearing_price_per_hour": U128(price), "amount": U128(total), "members": lines, "total_escrowed": U128(self.total_escrowed), "delivery_deadline": U64(deadline) }),
                );
                emit("reputation_updated", json!({ "seller_id": winner, "purchase_id": purchase_id, "cause": "win", "reputation": s.reputation }));
                self.sellers.insert(winner, s);
                self.transition(&mut p, PurchaseState::Funded, "awarded_at_clearing_price");
            }
        }
        self.purchases.insert(purchase_id, p);
    }

    // ------------------------------------------------------------------ delivery + verification (SIMULATED off-chain)

    pub fn start_delivery(&mut self, purchase_id: String) {
        self.assert_operator();
        self.assert_not_paused();
        let mut p = self.purchase(&purchase_id);
        Self::require_state(&p, PurchaseState::Funded);
        require!(now() < p.delivery_deadline.unwrap().0, "delivery deadline passed");
        emit("delivery_started", json!({ "purchase_id": purchase_id, "seller_id": p.winner_seller_id, "simulated": true }));
        self.transition(&mut p, PurchaseState::Delivering, "start_delivery");
        self.purchases.insert(purchase_id, p);
    }

    pub fn submit_delivery_report(&mut self, purchase_id: String, report_hash_hex: String) {
        self.assert_operator();
        self.assert_not_paused();
        let mut p = self.purchase(&purchase_id);
        Self::require_state(&p, PurchaseState::Delivering);
        require!(now() < p.delivery_deadline.unwrap().0, "delivery deadline passed");
        require!(parse_hex32(&report_hash_hex).is_some(), "report hash must be 32 bytes lowercase hex");
        let deadline = now() + secs(p.windows.verification_secs);
        p.delivery_report_hash = Some(report_hash_hex.clone());
        p.verification_deadline = Some(U64(deadline));
        emit("delivery_reported", json!({ "purchase_id": purchase_id, "report_hash": report_hash_hex, "verification_deadline": U64(deadline), "simulated": true }));
        self.transition(&mut p, PurchaseState::Verifying, "submit_delivery_report");
        self.purchases.insert(purchase_id, p);
    }

    /// Verifier only. Success starts the payout to the awarded seller's owner. Failure
    /// (incl. partial delivery) credits each member's owed amount back to it.
    pub fn verify(&mut self, purchase_id: String, success: bool, reason: String) {
        self.assert_not_paused();
        require!(env::predecessor_account_id() == self.verifier, "only the verifier can verify");
        require!(reason.len() <= MAX_REASON_LEN, "reason too long");
        let mut p = self.purchase(&purchase_id);
        Self::require_state(&p, PurchaseState::Verifying);
        require!(p.verified_success.is_none(), "already verified");
        require!(now() < p.verification_deadline.unwrap().0, "verification deadline passed");
        p.verified_success = Some(success);
        p.verification_reason = Some(reason.clone());
        emit("delivery_verified", json!({ "purchase_id": purchase_id, "success": success, "reason": reason, "verifier": self.verifier, "simulated": true }));
        if success {
            self.start_payout(&mut p);
        } else {
            let seller_id = p.winner_seller_id.clone().unwrap();
            self.bump_failed(&seller_id, &purchase_id, "verification_failed");
            self.transition(&mut p, PurchaseState::Failed, "verify_failed");
            self.refund_all(&mut p, "delivery_failed");
        }
        self.purchases.insert(purchase_id, p);
    }

    /// Retry a payout after a failed callback. Destination is fixed: the awarded seller's owner.
    pub fn payout(&mut self, purchase_id: String) {
        self.assert_not_paused();
        let mut p = self.purchase(&purchase_id);
        self.start_payout(&mut p);
        self.purchases.insert(purchase_id, p);
    }

    /// Anyone may expire a purchase whose current deadline passed; held money goes back to the buyers.
    pub fn expire(&mut self, purchase_id: String) {
        let mut p = self.purchase(&purchase_id);
        let t = now();
        match p.state {
            PurchaseState::Created => {
                require!(t >= p.prepay_deadline.0, "prepay deadline not reached");
                self.transition(&mut p, PurchaseState::Expired, "prepay_deadline");
                self.refund_all(&mut p, "prepay_deadline");
            }
            PurchaseState::Funded | PurchaseState::Delivering => {
                require!(t >= p.delivery_deadline.unwrap().0, "delivery deadline not reached");
                if p.state == PurchaseState::Delivering {
                    let seller_id = p.winner_seller_id.clone().unwrap();
                    self.bump_failed(&seller_id, &purchase_id, "delivery_deadline");
                }
                self.transition(&mut p, PurchaseState::Expired, "delivery_deadline");
                self.refund_all(&mut p, "delivery_deadline");
            }
            PurchaseState::Verifying => {
                require!(p.verified_success.is_none(), "already verified; use payout");
                require!(t >= p.verification_deadline.unwrap().0, "verification deadline not reached");
                self.transition(&mut p, PurchaseState::Expired, "verification_deadline");
                self.refund_all(&mut p, "verification_deadline");
            }
            _ => env::panic_str(&format!("cannot expire from {}", p.state.as_str())),
        }
        self.purchases.insert(purchase_id, p);
    }

    #[private]
    pub fn on_payout(&mut self, purchase_id: String) -> bool {
        let mut p = self.purchase(&purchase_id);
        require!(p.payout_in_flight, "no payout in flight");
        p.payout_in_flight = false;
        let ok = Self::promise_succeeded();
        let seller_id = p.winner_seller_id.clone().unwrap();
        if ok {
            let amount = p.held.0;
            self.total_escrowed -= amount;
            p.held = U128(0);
            p.paid_out = U128(amount);
            for a in &p.allocations {
                let mut b = self.buyer(&a.buyer_id);
                b.reserved = U128(b.reserved.0 - a.owed.0);
                b.spent = U128(b.spent.0 + a.owed.0);
                self.buyers.insert(b.buyer_id.clone(), b);
            }
            let mut s = self.sellers.get(&seller_id).unwrap().clone();
            s.reputation.completed_deliveries += 1;
            emit(
                "payout_succeeded",
                json!({ "purchase_id": purchase_id, "seller_id": seller_id, "payout_account_id": s.owner, "amount": U128(amount), "total_escrowed": U128(self.total_escrowed) }),
            );
            emit("reputation_updated", json!({ "seller_id": seller_id, "purchase_id": purchase_id, "cause": "completed_delivery", "reputation": s.reputation }));
            self.sellers.insert(seller_id, s);
            self.transition(&mut p, PurchaseState::Completed, "payout_succeeded");
            // Members got what they asked for: their requests are fulfilled.
            self.close_coalition(&p.coalition_id.clone(), true);
        } else {
            emit("payout_failed", json!({ "purchase_id": purchase_id, "seller_id": seller_id, "amount": p.held, "retryable": true }));
        }
        self.purchases.insert(purchase_id, p);
        ok
    }

    // ------------------------------------------------------------------ views

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            operator: self.operator.clone(),
            verifier: self.verifier.clone(),
            paused: self.paused,
            total_escrowed: U128(self.total_escrowed),
            total_balances: U128(self.total_balances),
            buyer_count: self.buyer_ids.len(),
            seller_count: self.seller_ids.len(),
            purchase_count: self.purchase_ids.len(),
            open_fee: U128(OPEN_FEE),
            agent_gas_fund: U128(AGENT_GAS_FUND),
        }
    }

    pub fn get_solvency(&self) -> Solvency {
        Solvency {
            account_balance: U128(env::account_balance().as_yoctonear()),
            storage_cost: U128(Self::storage_cost()),
            total_escrowed: U128(self.total_escrowed),
            total_balances: U128(self.total_balances),
        }
    }

    pub fn get_buyer(&self, buyer_id: String) -> Option<Buyer> {
        self.buyers.get(&buyer_id).cloned()
    }

    pub fn get_seller(&self, seller_id: String) -> Option<Seller> {
        self.sellers.get(&seller_id).cloned()
    }

    /// Opened buyer agents, in opening order.
    pub fn list_buyers(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Buyer> {
        let (from, limit) = Self::page(from_index, limit);
        self.buyer_ids.iter().skip(from).take(limit).filter_map(|id| self.buyers.get(id).cloned()).collect()
    }

    /// Opened seller agents, in opening order.
    pub fn list_sellers(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Seller> {
        let (from, limit) = Self::page(from_index, limit);
        self.seller_ids.iter().skip(from).take(limit).filter_map(|id| self.sellers.get(id).cloned()).collect()
    }

    pub fn get_coalition(&self, coalition_id: String) -> Option<Coalition> {
        self.coalitions.get(&coalition_id).cloned()
    }

    pub fn get_purchase(&self, purchase_id: String) -> Option<Purchase> {
        self.purchases.get(&purchase_id).cloned()
    }

    pub fn get_purchase_by_auction(&self, auction_id: String) -> Option<Purchase> {
        self.auctions.get(&auction_id).and_then(|pid| self.purchases.get(pid).cloned())
    }

    pub fn list_purchase_ids(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<String> {
        let (from, limit) = Self::page(from_index, limit);
        self.purchase_ids.iter().skip(from).take(limit).cloned().collect()
    }
}

// ---------------------------------------------------------------------- internal

impl Marketplace {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    fn assert_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "only the operator");
    }

    fn assert_owner_of(owner: &AccountId) {
        require!(&env::predecessor_account_id() == owner, "only the agent's owner");
    }

    fn assert_not_paused(&self) {
        require!(!self.paused, "contract is paused");
    }

    fn page(from_index: Option<u32>, limit: Option<u32>) -> (usize, usize) {
        (from_index.unwrap_or(0) as usize, limit.unwrap_or(50).min(100) as usize)
    }

    /// `<name>.<this contract>`, not yet used by any agent; the caller becomes the owner.
    fn new_agent_id(&self, name: &str) -> (AccountId, AccountId) {
        require!(is_agent_name(name), "invalid agent name: 2-32 chars of a-z, 0-9, single - or _ between them");
        let me = env::current_account_id();
        let agent_id: AccountId = format!("{name}.{me}").parse().unwrap_or_else(|_| env::panic_str("agent account id is too long"));
        require!(!self.buyers.contains_key(agent_id.as_str()) && !self.sellers.contains_key(agent_id.as_str()), "agent name already taken");
        let owner = env::predecessor_account_id();
        require!(owner != me, "the contract cannot own an agent");
        require!(!owner.is_sub_account_of(&me), "an agent cannot own an agent");
        (agent_id, owner)
    }

    /// Create the agent's account with a gas allowance and its one function-call key.
    fn create_agent_account(&self, agent_id: AccountId, public_key: PublicKey, budget: u128) {
        Promise::new(agent_id.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(AGENT_GAS_FUND))
            .add_access_key_allowance(public_key, Allowance::Unlimited, env::current_account_id(), AGENT_METHODS)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_OPEN_CALLBACK).on_agent_opened(agent_id.to_string(), U128(budget)))
            .detach();
    }

    fn refund_failed_open(&self, agent_id: &str, role: &str, owner: AccountId, amount: u128) {
        emit("agent_open_failed", json!({ "agent_id": agent_id, "role": role, "owner": owner, "refund": U128(amount) }));
        Promise::new(owner).transfer(NearToken::from_yoctonear(amount)).detach();
    }

    fn require_state(p: &Purchase, expected: PurchaseState) {
        if p.state != expected {
            env::panic_str(&format!("invalid state: expected {}, found {}", expected.as_str(), p.state.as_str()));
        }
    }

    fn purchase(&self, id: &str) -> Purchase {
        self.purchases.get(id).cloned().unwrap_or_else(|| env::panic_str("purchase not found"))
    }

    fn coalition(&self, id: &str) -> Coalition {
        self.coalitions.get(id).cloned().unwrap_or_else(|| env::panic_str("coalition not found"))
    }

    fn buyer(&self, id: &str) -> Buyer {
        self.buyers.get(id).cloned().unwrap_or_else(|| env::panic_str("buyer not found"))
    }

    fn opened_buyer(&self, id: &str) -> Buyer {
        let b = self.buyer(id);
        require!(b.opened, "buyer agent is still being opened");
        b
    }

    fn opened_seller(&self, id: &str) -> Seller {
        let s = self.sellers.get(id).cloned().unwrap_or_else(|| env::panic_str("seller not registered"));
        require!(s.opened, "seller agent is still being opened");
        s
    }

    fn transition(&self, p: &mut Purchase, to: PurchaseState, cause: &str) {
        emit("purchase_state_changed", json!({ "purchase_id": p.purchase_id, "from": p.state.as_str(), "to": to.as_str(), "cause": cause }));
        p.state = to;
    }

    /// Free a member to join another coalition; `fulfilled` also closes its request.
    fn release_member(&mut self, buyer_id: &str, fulfilled: bool) {
        let mut b = self.buyer(buyer_id);
        b.coalition_id = None;
        if fulfilled {
            b.request = None;
            emit("buyer_request_fulfilled", json!({ "buyer_id": buyer_id }));
        }
        self.buyers.insert(buyer_id.to_string(), b);
    }

    /// One coalition, one purchase attempt: when it ends, the coalition closes and its
    /// members go back to the pool (with their requests still open, unless fulfilled).
    fn close_coalition(&mut self, coalition_id: &str, fulfilled: bool) {
        let mut c = self.coalition(coalition_id);
        if c.closed {
            return;
        }
        c.closed = true;
        c.live_purchase_id = None;
        for m in &c.members {
            self.release_member(&m.buyer_id, fulfilled);
        }
        emit("coalition_closed", json!({ "coalition_id": coalition_id, "fulfilled": fulfilled }));
        self.coalitions.insert(coalition_id.to_string(), c);
    }

    /// Move `amount` of this purchase's escrow into the buyer agent's available balance.
    fn credit_from(&mut self, p: &mut Purchase, buyer_id: &str, amount: u128, reason: &str) {
        if amount == 0 {
            return;
        }
        require!(amount <= p.held.0, "credit exceeds escrow held");
        let mut b = self.buyer(buyer_id);
        b.reserved = U128(b.reserved.0.checked_sub(amount).unwrap_or_else(|| env::panic_str("reservation underflow")));
        b.available = U128(b.available.0 + amount);
        p.held = U128(p.held.0 - amount);
        self.total_escrowed -= amount;
        self.total_balances += amount;
        emit("balance_credited", json!({ "buyer_id": buyer_id, "purchase_id": p.purchase_id, "amount": U128(amount), "reason": reason, "available": b.available }));
        self.buyers.insert(buyer_id.to_string(), b);
    }

    /// Credit every member what this purchase still holds for it, then REFUNDED,
    /// and close the coalition so its members can be grouped again.
    fn refund_all(&mut self, p: &mut Purchase, reason: &str) {
        let awarded = p.clearing_price_per_hour.is_some();
        let mut allocations = std::mem::take(&mut p.allocations);
        let mut total = 0u128;
        for a in allocations.iter_mut() {
            let amount = if awarded { a.owed.0 } else { a.prepaid.0 };
            if amount > 0 {
                self.credit_from(p, &a.buyer_id, amount, reason);
                a.refunded = U128(amount);
                total += amount;
            }
        }
        p.allocations = allocations;
        require!(p.held.0 == 0, "refund must return everything held");
        if total > 0 {
            emit(
                "refund_succeeded",
                json!({
                    "purchase_id": p.purchase_id, "amount": U128(total), "reason": reason,
                    "lines": p.allocations.iter().map(|a| json!({ "buyer_id": a.buyer_id, "amount": a.refunded })).collect::<Vec<_>>(),
                }),
            );
            self.transition(p, PurchaseState::Refunded, reason);
        }
        self.close_coalition(&p.coalition_id.clone(), false);
    }

    fn bump_failed(&mut self, seller_id: &str, purchase_id: &str, cause: &str) {
        let mut s = self.sellers.get(seller_id).unwrap().clone();
        s.reputation.failed_deliveries += 1;
        emit("reputation_updated", json!({ "seller_id": seller_id, "purchase_id": purchase_id, "cause": cause, "reputation": s.reputation }));
        self.sellers.insert(seller_id.to_string(), s);
    }

    fn ineligibility(seller: &Seller, c: &Coalition, hours: u32, ceiling: u128, budget: u128, price: u128) -> Option<&'static str> {
        let same_model: Vec<&GpuOffer> = seller.offers.iter().filter(|o| o.gpu_model == c.gpu_model).collect();
        if same_model.is_empty() {
            return Some("GPU_MISMATCH");
        }
        let enough_vram: Vec<&&GpuOffer> = same_model.iter().filter(|o| o.vram_gb >= c.vram_gb).collect();
        if enough_vram.is_empty() {
            return Some("VRAM_TOO_LOW");
        }
        if !enough_vram.iter().any(|o| o.capacity_hours >= hours) {
            return Some("INSUFFICIENT_CAPACITY");
        }
        if price > ceiling {
            return Some("ABOVE_PRICE_CEILING");
        }
        match price.checked_mul(hours as u128) {
            Some(total) if total <= budget => None,
            _ => Some("ABOVE_BUDGET"),
        }
    }

    fn storage_cost() -> u128 {
        env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128
    }

    /// Escrow and buyer balances must always be covered by balance above the storage reserve.
    fn assert_solvent(&self) {
        let balance = env::account_balance().as_yoctonear();
        require!(
            balance.checked_sub(Self::storage_cost()).map_or(false, |free| free >= self.total_escrowed + self.total_balances),
            "insolvent: balance minus storage cost is below escrow plus buyer balances"
        );
    }

    fn start_payout(&mut self, p: &mut Purchase) {
        Self::require_state(p, PurchaseState::Verifying);
        require!(p.verified_success == Some(true), "delivery not verified as successful");
        require!(!p.payout_in_flight, "settlement already in flight");
        let amount = p.held.0;
        require!(amount > 0, "nothing held");
        self.assert_solvent();
        let seller = self.sellers.get(p.winner_seller_id.as_ref().unwrap()).unwrap();
        let to = seller.owner.clone();
        p.payout_in_flight = true;
        emit("payout_started", json!({ "purchase_id": p.purchase_id, "seller_id": seller.seller_id, "payout_account_id": to, "amount": U128(amount) }));
        Promise::new(to)
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_CALLBACK).on_payout(p.purchase_id.clone()))
            .detach();
    }

    fn promise_succeeded() -> bool {
        require!(env::promise_results_count() == 1, "expected one promise result");
        // These promises return no value; any successful result (bounded read) is success.
        env::promise_result_checked(0, 64).is_ok()
    }
}

#[cfg(test)]
mod tests;
