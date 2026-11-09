//! Unit tests (mocked chain). Real account creation, function-call keys, transfers,
//! failing receipts and real block time are covered by contracts/marketplace-testnet-tests.

use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseResult, RuntimeFeesConfig};

const MKT: &str = "market.testnet";
const OWNER: &str = "owner.testnet";
const OP: &str = "operator.testnet";
const VER: &str = "verifier.testnet";
const ANYONE: &str = "rando.testnet";
const PK: &str = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";

const NS: u64 = 1_000_000_000;
const START: u64 = 1_700_000_000 * NS;
const DAY: u64 = 24 * 3600 * NS;
const MILLI: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR
const NEAR: u128 = 1000 * MILLI;
const BUDGET: u128 = NEAR;

const P1: &str = "purchase-1";
const A1: &str = "auction-1";
const C1: &str = "coalition-1";

/// (agent name, owner wallet, hours, own max price per hour)
const BUYERS: [(&str, &str, u32, u128); 3] = [
    ("b1", "alice.testnet", 10, 10 * MILLI),
    ("b2", "bob.testnet", 10, 8 * MILLI),
    ("b3", "carol.testnet", 10, 6 * MILLI),
];
/// (agent name, owner wallet, offers, min price)
fn sellers() -> Vec<(&'static str, &'static str, Vec<GpuOffer>, u128)> {
    use GpuModel::*;
    vec![
        ("s1", "dave.testnet", vec![offer(A100, 80, 100)], MILLI),
        ("s2", "erin.testnet", vec![offer(A100, 80, 100)], MILLI),
        ("s3", "frank.testnet", vec![offer(H100, 80, 100)], MILLI),
        ("s4", "grace.testnet", vec![offer(A100, 40, 100)], MILLI),
        ("s5", "heidi.testnet", vec![offer(A100, 80, 5)], MILLI),
    ]
}
const PRICE_1: u128 = 4 * MILLI; // s1 bid
const PRICE_2: u128 = 5 * MILLI; // s2 bid
const HOURS: u128 = 30;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn id(name: &str) -> String {
    format!("{name}.{MKT}")
}

fn pk() -> PublicKey {
    PK.parse().unwrap()
}

fn prepay_of(i: usize) -> u128 {
    BUYERS[i].3 * BUYERS[i].2 as u128
}

fn panics<F: FnOnce()>(f: F, msg: &str) {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    let err = match r {
        Ok(()) => panic!("expected a panic containing {msg:?}"),
        Err(e) => e,
    };
    let s = err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    assert!(s.contains(msg), "panic {s:?} does not contain {msg:?}");
}

fn offer(m: GpuModel, vram: u32, cap: u32) -> GpuOffer {
    GpuOffer { gpu_model: m, vram_gb: vram, capacity_hours: cap }
}

fn windows() -> Windows {
    Windows { prepay_secs: 60, commit_secs: 60, reveal_secs: 60, delivery_secs: 60, verification_secs: 60 }
}

fn request(model: GpuModel, vram: u32, hours: u32, max: u128) -> BuyerRequest {
    BuyerRequest { gpu_model: model, vram_gb: vram, hours, max_price_per_hour: U128(max), deadline: U64(START + DAY) }
}

struct T {
    c: Option<Marketplace>,
    now: u64,
    height: u64,
    /// Mocked contract balance; the fixture mirrors deposits and transfers by hand.
    balance: u128,
}

impl T {
    fn builder(&mut self, who: &str, deposit: u128) -> VMContextBuilder {
        self.height += 1;
        let mut b = VMContextBuilder::new();
        b.current_account_id(acc(MKT))
            .predecessor_account_id(acc(who))
            .signer_account_id(acc(who))
            .block_timestamp(self.now)
            .block_height(self.height)
            .account_balance(NearToken::from_yoctonear(self.balance))
            .attached_deposit(NearToken::from_yoctonear(deposit));
        b
    }
    fn as_(&mut self, who: &str) -> &mut Marketplace {
        let b = self.builder(who, 0);
        testing_env!(b.build());
        self.c.as_mut().unwrap()
    }
    fn pay(&mut self, who: &str, deposit: u128) -> &mut Marketplace {
        let b = self.builder(who, deposit);
        testing_env!(b.build());
        self.c.as_mut().unwrap()
    }
    fn cb(&mut self, ok: bool) -> &mut Marketplace {
        let b = self.builder(MKT, 0);
        let r = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
        testing_env!(b.build(), near_sdk::test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![r]);
        self.c.as_mut().unwrap()
    }
    fn advance(&mut self, s: u64) {
        self.now += s * NS;
    }
    fn view(&mut self) -> &Marketplace {
        let b = self.builder(ANYONE, 0);
        testing_env!(b.build());
        self.c.as_ref().unwrap()
    }
    fn p(&mut self, id: &str) -> Purchase {
        self.view().get_purchase(id.into()).unwrap()
    }
    fn state(&mut self) -> PurchaseState {
        self.p(P1).state
    }
    fn seller(&mut self, name: &str) -> Seller {
        self.view().get_seller(id(name)).unwrap()
    }
    fn buyer(&mut self, name: &str) -> Buyer {
        self.view().get_buyer(id(name)).unwrap()
    }
    fn cfg(&mut self) -> Config {
        self.view().get_config()
    }

    /// Open a buyer agent and complete its account creation (`ok` = creation succeeded).
    fn open_buyer(&mut self, name: &str, owner: &str, budget: u128, req: Option<BuyerRequest>, ok: bool) {
        self.balance += OPEN_FEE + budget;
        self.pay(owner, OPEN_FEE + budget).open_buyer_agent(name.into(), pk(), req);
        self.balance -= AGENT_GAS_FUND;
        let opened = self.cb(ok).on_agent_opened(id(name), U128(budget));
        assert_eq!(opened, ok);
        if !ok {
            // The failed batch's transfer comes back, then the owner is refunded in full.
            self.balance += AGENT_GAS_FUND;
            self.balance -= OPEN_FEE + budget;
        }
    }
    fn open_seller(&mut self, name: &str, owner: &str, offers: Vec<GpuOffer>, min: u128) {
        self.balance += OPEN_FEE;
        self.pay(owner, OPEN_FEE).open_seller_agent(name.into(), pk(), offers, U128(min), SellerStrategy::AtMinimum);
        self.balance -= AGENT_GAS_FUND;
        assert!(self.cb(true).on_agent_opened(id(name), U128(0)));
    }

    /// Signed by the buyer agent's own account.
    fn prepay(&mut self, pid: &str, i: usize) {
        self.as_(&id(BUYERS[i].0)).prepay(pid.into(), id(BUYERS[i].0));
    }
    fn prepay_all(&mut self, pid: &str) {
        for i in 0..BUYERS.len() {
            self.prepay(pid, i);
        }
    }
    /// Signed by the seller agent's own account.
    fn commit(&mut self, pid: &str, aid: &str, seller: &str, price: u128, nonce: u8) {
        let s = id(seller);
        let h = to_hex(&commitment::compute(aid, &s, price, &[nonce; 32]));
        self.as_(&s).commit_bid(pid.into(), s.clone(), h);
    }
    fn reveal(&mut self, pid: &str, seller: &str, price: u128, nonce: u8) {
        let s = id(seller);
        self.as_(&s).reveal_bid(pid.into(), s.clone(), U128(price), to_hex(&[nonce; 32]));
    }
    /// Withdraw a buyer agent's whole available balance (signed by the agent) with a successful transfer.
    fn withdraw(&mut self, name: &str) -> u128 {
        let amount = self.buyer(name).available.0;
        self.as_(&id(name)).withdraw(id(name), None);
        self.balance -= amount;
        assert!(self.cb(true).on_withdraw(id(name)));
        amount
    }
    fn check_invariants(&mut self) {
        let cfg = self.cfg();
        let held: u128 = self.view().list_purchase_ids(None, None).into_iter().map(|id| self.p(&id).held.0).sum();
        assert_eq!(cfg.total_escrowed.0, held, "total_escrowed == Σ held");
        let available: u128 = self.view().list_buyers(None, None).iter().map(|b| b.available.0).sum();
        assert_eq!(cfg.total_balances.0, available, "total_balances == Σ available");
        let s = self.view().get_solvency();
        assert!(s.account_balance.0 - s.storage_cost.0 >= s.total_escrowed.0 + s.total_balances.0, "solvent");
    }
}

/// Contract only, no agents.
fn empty() -> T {
    let mut t = T { c: None, now: START, height: 100, balance: 10 * NEAR };
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    let b = t.builder(OWNER, 0);
    testing_env!(b.build());
    t.c = Some(Marketplace::new(acc(OWNER), acc(OP), acc(VER)));
    t
}

/// 3 buyer agents (A100 / 80 GB / 10 h each), 5 seller agents, coalition-1 (min 2), purchase-1 CREATED.
fn setup() -> T {
    let mut t = empty();
    for (name, owner, hours, max) in BUYERS {
        t.open_buyer(name, owner, BUDGET, Some(request(GpuModel::A100, 80, hours, max)), true);
    }
    for (name, owner, offers, min) in sellers() {
        t.open_seller(name, owner, offers, min);
    }
    t.as_(OP).register_coalition(C1.into(), BUYERS.iter().map(|b| id(b.0)).collect(), 2);
    t.as_(OP).create_purchase(P1.into(), A1.into(), C1.into(), windows());
    t
}

fn reach(target: PurchaseState) -> T {
    use PurchaseState::*;
    let mut t = setup();
    if target == Created {
        return t;
    }
    if target == Failed {
        // FAILED with nothing held: two members leave in CREATED before anyone prepaid, below min.
        t.as_(OP).leave_coalition(C1.into(), id("b1"));
        t.as_(OP).leave_coalition(C1.into(), id("b2"));
        assert_eq!(t.state(), Failed);
        return t;
    }
    if target == Expired {
        t.advance(61);
        t.as_(ANYONE).expire(P1.into());
        assert_eq!(t.state(), Expired);
        return t;
    }
    t.prepay_all(P1);
    t.as_(OP).open_bidding(P1.into());
    if target == Bidding {
        return t;
    }
    t.commit(P1, A1, "s1", PRICE_1, 1);
    t.commit(P1, A1, "s2", PRICE_2, 2);
    t.advance(61);
    t.reveal(P1, "s1", PRICE_1, 1);
    t.reveal(P1, "s2", PRICE_2, 2);
    t.advance(61);
    t.as_(ANYONE).close_auction(P1.into());
    if target == Funded {
        return t;
    }
    t.as_(OP).start_delivery(P1.into());
    if target == Delivering {
        return t;
    }
    t.as_(OP).submit_delivery_report(P1.into(), to_hex(&[9u8; 32]));
    if target == Verifying {
        return t;
    }
    if target == Completed {
        t.as_(VER).verify(P1.into(), true, "ok".into());
        t.balance -= PRICE_1 * HOURS;
        t.cb(true).on_payout(P1.into());
        return t;
    }
    assert_eq!(target, Refunded);
    t.as_(VER).verify(P1.into(), false, "partial delivery".into());
    t
}

// ---------------------------------------------------------------------- opening agents

#[test]
fn opening_an_agent_creates_its_account_with_a_function_call_key() {
    let mut t = empty();
    t.balance += OPEN_FEE + BUDGET;
    t.pay("alice.testnet", OPEN_FEE + BUDGET).open_buyer_agent("b1".into(), pk(), None);
    // Pending until the account exists: no balance yet, and the agent can't act.
    let b = t.buyer("b1");
    assert!(!b.opened);
    assert_eq!(b.owner, acc("alice.testnet"));
    assert_eq!(b.available.0, 0);
    assert_eq!(t.cfg().buyer_count, 0);
    panics(|| t.pay("alice.testnet", 1).deposit(id("b1")), "still being opened");

    t.balance -= AGENT_GAS_FUND;
    assert!(t.cb(true).on_agent_opened(id("b1"), U128(BUDGET)));
    let b = t.buyer("b1");
    assert!(b.opened);
    assert_eq!(b.available.0, BUDGET);
    let cfg = t.cfg();
    assert_eq!((cfg.buyer_count, cfg.total_balances.0), (1, BUDGET));
    assert_eq!(cfg.open_fee.0, OPEN_FEE);

    t.open_seller("s1", "dave.testnet", vec![offer(GpuModel::A100, 80, 100)], MILLI);
    assert!(get_logs().iter().any(|l| l.contains("\"agent_opened\"")));
    let s = t.seller("s1");
    assert!(s.opened && s.active);
    assert_eq!(s.owner, acc("dave.testnet"));
    assert_eq!(t.view().list_sellers(None, None).len(), 1);
    t.check_invariants();
}

#[test]
fn opening_rules() {
    let mut t = empty();
    let r = Some(request(GpuModel::A100, 80, 10, MILLI));
    panics(|| t.pay("alice.testnet", OPEN_FEE).open_buyer_agent("B1".into(), pk(), None), "invalid agent name");
    panics(|| t.pay("alice.testnet", OPEN_FEE).open_buyer_agent("a.b".into(), pk(), None), "invalid agent name");
    panics(|| t.pay("alice.testnet", OPEN_FEE - 1).open_buyer_agent("b1".into(), pk(), None), "open fee");
    panics(|| t.pay("dave.testnet", OPEN_FEE + 1).open_seller_agent("s1".into(), pk(), vec![offer(GpuModel::A100, 80, 1)], U128(1), SellerStrategy::AtMinimum), "exactly");
    panics(|| t.pay("dave.testnet", OPEN_FEE).open_seller_agent("s1".into(), pk(), vec![], U128(1), SellerStrategy::AtMinimum), "offers");
    panics(|| t.pay("dave.testnet", OPEN_FEE).open_seller_agent("s1".into(), pk(), vec![offer(GpuModel::A100, 80, 1)], U128(0), SellerStrategy::AtMinimum), "min_price");
    panics(
        || t.pay("dave.testnet", OPEN_FEE).open_seller_agent("s1".into(), pk(), vec![offer(GpuModel::A100, 80, 1)], U128(1), SellerStrategy::BelowCeiling { discount_bps: 10_000 }),
        "discount_bps",
    );
    let mut past = request(GpuModel::A100, 80, 10, MILLI);
    past.deadline = U64(START);
    panics(|| t.pay("alice.testnet", OPEN_FEE).open_buyer_agent("b1".into(), pk(), Some(past.clone())), "deadline");
    panics(|| t.pay("alice.testnet", OPEN_FEE).open_buyer_agent("b1".into(), pk(), Some(request(GpuModel::A100, 80, 0, MILLI))), "hours");

    t.open_buyer("b1", "alice.testnet", 0, r.clone(), true);
    // Names are unique across buyers and sellers.
    panics(|| t.pay("bob.testnet", OPEN_FEE).open_buyer_agent("b1".into(), pk(), None), "already taken");
    panics(|| t.pay("bob.testnet", OPEN_FEE).open_seller_agent("b1".into(), pk(), vec![offer(GpuModel::A100, 80, 1)], U128(1), SellerStrategy::AtMinimum), "already taken");
    // An agent can't own an agent.
    panics(|| t.pay(&id("b1"), OPEN_FEE).open_buyer_agent("b9".into(), pk(), None), "agent cannot own");
    // One wallet can own any number of agents of either role.
    t.open_buyer("b2", "alice.testnet", 0, None, true);
    t.open_seller("s1", "alice.testnet", vec![offer(GpuModel::A100, 80, 1)], MILLI);

    t.as_(OWNER).set_paused(true);
    panics(|| t.pay("bob.testnet", OPEN_FEE).open_buyer_agent("b3".into(), pk(), None), "paused");
}

#[test]
fn failed_account_creation_refunds_the_owner_and_frees_the_name() {
    let mut t = empty();
    t.open_buyer("b1", "alice.testnet", BUDGET, None, false);
    assert!(get_logs().iter().any(|l| l.contains("\"agent_open_failed\"") && l.contains(&(OPEN_FEE + BUDGET).to_string())));
    assert!(t.view().get_buyer(id("b1")).is_none());
    assert_eq!(t.cfg().total_balances.0, 0);
    t.open_buyer("b1", "alice.testnet", BUDGET, None, true);
    assert!(t.buyer("b1").opened);
    t.check_invariants();
}

// ---------------------------------------------------------------------- owner controls

#[test]
fn only_the_owner_manages_an_agent() {
    let mut t = setup();
    // deposit
    panics(|| t.pay("bob.testnet", NEAR).deposit(id("b1")), "only the agent's owner");
    panics(|| t.pay(&id("b1"), NEAR).deposit(id("b1")), "only the agent's owner");
    t.balance += NEAR;
    t.pay("alice.testnet", NEAR).deposit(id("b1"));
    assert_eq!(t.buyer("b1").available.0, BUDGET + NEAR);
    // update_seller
    panics(|| t.as_("alice.testnet").update_seller(id("s1"), None, Some(U128(2)), None, None), "only the agent's owner");
    t.as_("dave.testnet").update_seller(id("s1"), None, Some(U128(2 * MILLI)), Some(SellerStrategy::BelowCeiling { discount_bps: 500 }), Some(false));
    let s = t.seller("s1");
    assert_eq!((s.min_price_per_hour.0, s.active), (2 * MILLI, false));
    assert_eq!(s.strategy, SellerStrategy::BelowCeiling { discount_bps: 500 });
    // set_request: owner only, and not while grouped.
    panics(|| t.as_("bob.testnet").set_request(id("b1"), None), "only the agent's owner");
    panics(|| t.as_("alice.testnet").set_request(id("b1"), None), "leave the coalition");
    t.as_("alice.testnet").leave_coalition(C1.into(), id("b1"));
    t.as_("alice.testnet").set_request(id("b1"), Some(request(GpuModel::H100, 80, 3, MILLI)));
    assert_eq!(t.buyer("b1").request.unwrap().gpu_model, GpuModel::H100);
    t.check_invariants();
}

#[test]
fn withdrawals_go_only_to_the_owner() {
    let mut t = setup();
    panics(|| t.as_(ANYONE).withdraw(id("b1"), None), "only the agent or its owner");
    panics(|| t.as_("bob.testnet").withdraw(id("b1"), None), "only the agent or its owner");
    panics(|| t.as_("alice.testnet").withdraw(id("b1"), Some(U128(BUDGET + 1))), "exceeds available");
    // The owner takes part; the agent takes the rest. Both go to the owner.
    t.as_("alice.testnet").withdraw(id("b1"), Some(U128(NEAR / 4)));
    assert!(get_logs().iter().any(|l| l.contains("\"withdrawal_started\"") && l.contains("alice.testnet")));
    assert_eq!(t.buyer("b1").available.0, BUDGET - NEAR / 4);
    panics(|| t.as_("alice.testnet").withdraw(id("b1"), None), "already in flight");
    t.balance -= NEAR / 4;
    assert!(t.cb(true).on_withdraw(id("b1")));
    assert_eq!(t.withdraw("b1"), BUDGET - NEAR / 4);
    assert_eq!(t.buyer("b1").available.0, 0);
    panics(|| t.as_("alice.testnet").withdraw(id("b1"), None), "nothing to withdraw");
    t.check_invariants();
}

#[test]
fn failed_withdrawal_puts_the_money_back_and_can_be_retried() {
    let mut t = setup();
    t.as_(&id("b1")).withdraw(id("b1"), None);
    assert!(!t.cb(false).on_withdraw(id("b1")));
    let b = t.buyer("b1");
    assert_eq!((b.available.0, b.withdrawing.0), (BUDGET, 0));
    t.check_invariants();
    assert_eq!(t.withdraw("b1"), BUDGET);
    panics(|| { t.cb(true).on_withdraw(id("b1")); }, "no withdrawal in flight");
    t.check_invariants();
}

// ---------------------------------------------------------------------- coalitions

#[test]
fn coalition_terms_come_from_each_agents_own_request() {
    let mut t = setup();
    let c = t.view().get_coalition(C1.into()).unwrap();
    assert_eq!((c.gpu_model, c.vram_gb, c.total_hours()), (GpuModel::A100, 80, 30));
    for (m, b) in c.members.iter().zip(BUYERS) {
        assert_eq!((m.buyer_id.as_str(), m.hours, m.max_price_per_hour.0), (id(b.0).as_str(), b.2, b.3));
    }
    assert_eq!(t.buyer("b1").coalition_id.as_deref(), Some(C1));
    assert_eq!(c.price_ceiling(), 6 * MILLI);

    // Already grouped.
    panics(|| t.as_(OP).register_coalition("coal-2".into(), vec![id("b1")], 1), "already in a coalition");
    // Operator only.
    t.open_buyer("b4", "ivan.testnet", BUDGET, Some(request(GpuModel::A100, 40, 5, MILLI)), true);
    panics(|| t.as_("ivan.testnet").register_coalition("coal-2".into(), vec![id("b4")], 1), "only the operator");
    // No open request.
    t.open_buyer("b5", "judy.testnet", BUDGET, None, true);
    panics(|| t.as_(OP).register_coalition("coal-2".into(), vec![id("b5")], 1), "no open request");
    // Different GPU models can't be grouped.
    t.open_buyer("b6", "ken.testnet", BUDGET, Some(request(GpuModel::H100, 80, 5, MILLI)), true);
    panics(|| t.as_(OP).register_coalition("coal-2".into(), vec![id("b4"), id("b6")], 1), "different GPU models");
    panics(|| t.as_(OP).register_coalition("coal-2".into(), vec![id("b4"), id("b4")], 1), "duplicate member");
    panics(|| t.as_(OP).register_coalition("coal-2".into(), vec![id("b4")], 2), "fewer members");
    // VRAM is the strictest member's.
    t.open_buyer("b7", "leo.testnet", BUDGET, Some(request(GpuModel::A100, 80, 5, MILLI)), true);
    t.as_(OP).register_coalition("coal-2".into(), vec![id("b4"), id("b7")], 1);
    assert_eq!(t.view().get_coalition("coal-2".into()).unwrap().vram_gb, 80);
    // A request past its deadline isn't grouped.
    t.open_buyer("b8", "mia.testnet", BUDGET, Some(request(GpuModel::A100, 80, 5, MILLI)), true);
    t.now = START + DAY;
    panics(|| t.as_(OP).register_coalition("coal-3".into(), vec![id("b8")], 1), "deadline has passed");
}

#[test]
fn leaving_a_coalition() {
    let mut t = setup();
    t.prepay(P1, 0);
    panics(|| t.as_(ANYONE).leave_coalition(C1.into(), id("b1")), "only the operator, the agent or its owner");
    panics(|| t.as_("bob.testnet").leave_coalition(C1.into(), id("b1")), "only the operator, the agent or its owner");
    // The agent itself leaves and gets its prepayment back.
    t.as_(&id("b1")).leave_coalition(C1.into(), id("b1"));
    let b = t.buyer("b1");
    assert_eq!((b.available.0, b.reserved.0, b.coalition_id), (BUDGET, 0, None));
    assert_eq!(t.view().get_coalition(C1.into()).unwrap().members.len(), 2);
    t.check_invariants();

    // Below min during BIDDING: the coalition closes and everyone gets its prepayment back.
    let mut t = reach(PurchaseState::Bidding);
    t.as_("alice.testnet").leave_coalition(C1.into(), id("b1"));
    t.as_(OP).leave_coalition(C1.into(), id("b2"));
    assert_eq!(t.state(), PurchaseState::Refunded);
    for (name, ..) in BUYERS {
        let b = t.buyer(name);
        assert_eq!((b.available.0, b.reserved.0, b.coalition_id.is_none()), (BUDGET, 0, true));
        assert!(b.request.is_some(), "requests stay open after a failed attempt");
    }
    assert!(t.view().get_coalition(C1.into()).unwrap().closed);
    t.check_invariants();

    let mut t = reach(PurchaseState::Funded);
    panics(|| t.as_(OP).leave_coalition(C1.into(), id("b1")), "after funding");
}

// ---------------------------------------------------------------------- prepay

#[test]
fn prepay_rules() {
    let mut t = setup();
    // Only the agent's own account: not the owner, not the operator.
    panics(|| t.as_("alice.testnet").prepay(P1.into(), id("b1")), "own account");
    panics(|| t.as_(OP).prepay(P1.into(), id("b1")), "own account");
    panics(|| t.as_(&id("b2")).prepay(P1.into(), id("b1")), "own account");

    t.prepay(P1, 0);
    let b = t.buyer("b1");
    assert_eq!((b.available.0, b.reserved.0), (BUDGET - prepay_of(0), prepay_of(0)));
    assert_eq!(t.p(P1).held.0, prepay_of(0));
    panics(|| t.prepay(P1, 0), "already prepaid");
    t.check_invariants();

    // Not a member.
    t.open_buyer("b4", "ivan.testnet", BUDGET, Some(request(GpuModel::A100, 80, 5, MILLI)), true);
    panics(|| t.as_(&id("b4")).prepay(P1.into(), id("b4")), "not a member");

    // Not enough available.
    t.as_(&id("b2")).withdraw(id("b2"), None);
    t.balance -= BUDGET;
    t.cb(true).on_withdraw(id("b2"));
    panics(|| t.prepay(P1, 1), "available balance is below");

    // Bidding can't open until every member prepaid; the deadline then passes.
    panics(|| t.as_(OP).open_bidding(P1.into()), "every member must prepay");
    t.advance(61);
    panics(|| t.prepay(P1, 2), "prepay deadline passed");
}

// ---------------------------------------------------------------------- the fair price

#[test]
fn every_member_pays_one_clearing_price_and_gets_its_excess_back() {
    let mut t = reach(PurchaseState::Funded);
    let p = t.p(P1);
    assert_eq!(p.winner_seller_id, Some(id("s1")));
    assert_eq!(p.clearing_price_per_hour, Some(U128(PRICE_1)));
    assert_eq!(p.held.0, PRICE_1 * HOURS);
    for (i, (name, _, hours, _)) in BUYERS.iter().enumerate() {
        let a = &p.allocations[i];
        let owed = PRICE_1 * *hours as u128;
        assert_eq!((a.owed.0, a.excess.0), (owed, prepay_of(i) - owed));
        let b = t.buyer(name);
        assert_eq!((b.reserved.0, b.available.0), (owed, BUDGET - owed));
    }
    let bids = &p.bids;
    assert!(bids.iter().all(|b| b.eligible == Some(true)));
    t.check_invariants();
}

#[test]
fn completed_purchase_pays_the_sellers_owner_and_fulfils_the_requests() {
    let mut t = reach(PurchaseState::Verifying);
    t.as_(VER).verify(P1.into(), true, "ok".into());
    assert!(get_logs().iter().any(|l| l.contains("\"payout_started\"") && l.contains("dave.testnet")));
    t.balance -= PRICE_1 * HOURS;
    assert!(t.cb(true).on_payout(P1.into()));
    assert_eq!(t.state(), PurchaseState::Completed);
    assert_eq!(t.p(P1).paid_out.0, PRICE_1 * HOURS);
    for (name, _, hours, _) in BUYERS {
        let b = t.buyer(name);
        let owed = PRICE_1 * hours as u128;
        assert_eq!((b.spent.0, b.reserved.0, b.available.0), (owed, 0, BUDGET - owed));
        assert!(b.request.is_none() && b.coalition_id.is_none());
    }
    assert!(t.view().get_coalition(C1.into()).unwrap().closed);
    let s = t.seller("s1");
    assert_eq!((s.reputation.wins, s.reputation.completed_deliveries), (1, 1));
    // Leftover budget goes back to the owner.
    assert_eq!(t.withdraw("b1"), BUDGET - PRICE_1 * 10);
    t.check_invariants();
}

#[test]
fn failed_delivery_refunds_each_member_and_its_request_can_be_regrouped() {
    let mut t = reach(PurchaseState::Refunded);
    assert_eq!(t.state(), PurchaseState::Refunded);
    for (name, ..) in BUYERS {
        let b = t.buyer(name);
        assert_eq!((b.available.0, b.reserved.0, b.spent.0), (BUDGET, 0, 0));
        assert!(b.request.is_some() && b.coalition_id.is_none());
    }
    assert_eq!(t.seller("s1").reputation.failed_deliveries, 1);
    t.check_invariants();
    t.as_(OP).register_coalition("coalition-2".into(), BUYERS.iter().map(|b| id(b.0)).collect(), 2);
    t.as_(OP).create_purchase("purchase-2".into(), "auction-2".into(), "coalition-2".into(), windows());
    t.prepay("purchase-2", 0);
    t.check_invariants();
}

#[test]
fn no_eligible_bid_returns_full_prepayments() {
    let mut t = reach(PurchaseState::Bidding);
    t.commit(P1, A1, "s3", PRICE_1, 3); // H100 only
    t.commit(P1, A1, "s4", PRICE_1, 4); // 40 GB
    t.commit(P1, A1, "s5", PRICE_1, 5); // 5 h capacity
    t.commit(P1, A1, "s1", 7 * MILLI, 1); // above the 6 milli ceiling
    t.advance(61);
    for (s, n) in [("s3", 3), ("s4", 4), ("s5", 5)] {
        t.reveal(P1, s, PRICE_1, n);
    }
    t.reveal(P1, "s1", 7 * MILLI, 1);
    t.advance(61);
    t.as_(ANYONE).close_auction(P1.into());
    let p = t.p(P1);
    assert_eq!(p.state, PurchaseState::Refunded);
    let reasons: Vec<_> = p.bids.iter().map(|b| b.ineligibility_reason.clone().unwrap()).collect();
    assert_eq!(reasons, ["GPU_MISMATCH", "VRAM_TOO_LOW", "INSUFFICIENT_CAPACITY", "ABOVE_PRICE_CEILING"]);
    for (name, ..) in BUYERS {
        assert_eq!(t.buyer(name).available.0, BUDGET);
    }
    t.check_invariants();
}

// ---------------------------------------------------------------------- bidding

#[test]
fn bids_are_signed_by_the_seller_agents_own_account() {
    let mut t = reach(PurchaseState::Bidding);
    let h = to_hex(&commitment::compute(A1, &id("s1"), PRICE_1, &[1; 32]));
    panics(|| t.as_(OP).commit_bid(P1.into(), id("s1"), h.clone()), "own account can bid");
    panics(|| t.as_("dave.testnet").commit_bid(P1.into(), id("s1"), h.clone()), "own account can bid");
    panics(|| t.as_(&id("s2")).commit_bid(P1.into(), id("s1"), h.clone()), "own account can bid");
    panics(|| t.as_(&id("s1")).commit_bid(P1.into(), id("s1"), "ab".into()), "32 bytes");
    t.commit(P1, A1, "s1", PRICE_1, 1);
    panics(|| t.commit(P1, A1, "s1", PRICE_1, 1), "already committed");
    panics(|| t.reveal(P1, "s1", PRICE_1, 1), "not started");

    // An inactive seller can't bid.
    t.as_("erin.testnet").update_seller(id("s2"), None, None, None, Some(false));
    panics(|| t.commit(P1, A1, "s2", PRICE_2, 2), "not active");
    t.as_("erin.testnet").update_seller(id("s2"), None, None, None, Some(true));
    // A seller whose floor rises after committing can't reveal below it.
    t.commit(P1, A1, "s2", PRICE_2, 2);
    t.as_("erin.testnet").update_seller(id("s2"), None, Some(U128(PRICE_2 + 1)), None, None);
    t.advance(61);
    panics(|| t.commit(P1, A1, "s3", PRICE_1, 3), "commit phase is over");
    panics(|| t.reveal(P1, "s2", PRICE_2, 2), "below the seller's own minimum");
    panics(|| t.as_(OP).reveal_bid(P1.into(), id("s1"), U128(PRICE_1), to_hex(&[1; 32])), "own account can reveal");
    panics(|| t.reveal(P1, "s1", PRICE_1, 9), "commitment mismatch");
    panics(|| t.reveal(P1, "s1", PRICE_1 + 1, 1), "commitment mismatch");
    t.reveal(P1, "s1", PRICE_1, 1);
    panics(|| t.reveal(P1, "s1", PRICE_1, 1), "already revealed");
    t.advance(61);
    panics(|| t.reveal(P1, "s1", PRICE_1, 1), "reveal phase is over");
}

#[test]
fn non_reveal_is_excluded_and_penalised() {
    let mut t = reach(PurchaseState::Bidding);
    t.commit(P1, A1, "s1", PRICE_1, 1);
    t.commit(P1, A1, "s2", PRICE_2, 2);
    t.advance(61);
    t.reveal(P1, "s2", PRICE_2, 2);
    t.advance(61);
    t.as_(ANYONE).close_auction(P1.into());
    let p = t.p(P1);
    assert_eq!(p.winner_seller_id, Some(id("s2")));
    assert_eq!(p.bids[0].ineligibility_reason.as_deref(), Some("NOT_REVEALED"));
    assert_eq!(t.seller("s1").reputation.non_reveals, 1);
}

#[test]
fn equal_bids_go_to_the_earlier_commitment() {
    let mut t = reach(PurchaseState::Bidding);
    t.commit(P1, A1, "s2", PRICE_1, 2);
    t.commit(P1, A1, "s1", PRICE_1, 1);
    t.advance(61);
    t.reveal(P1, "s1", PRICE_1, 1);
    t.reveal(P1, "s2", PRICE_1, 2);
    t.advance(61);
    t.as_(ANYONE).close_auction(P1.into());
    assert_eq!(t.p(P1).winner_seller_id, Some(id("s2")));
}

// ---------------------------------------------------------------------- settlement safety

#[test]
fn payout_failure_then_retry_and_no_double_payout() {
    let mut t = reach(PurchaseState::Verifying);
    t.as_(VER).verify(P1.into(), true, "ok".into());
    panics(|| t.as_(ANYONE).payout(P1.into()), "already in flight");
    assert!(!t.cb(false).on_payout(P1.into()));
    assert_eq!(t.state(), PurchaseState::Verifying);
    t.as_(ANYONE).payout(P1.into());
    t.balance -= PRICE_1 * HOURS;
    assert!(t.cb(true).on_payout(P1.into()));
    panics(|| t.as_(ANYONE).payout(P1.into()), "invalid state");
    panics(|| { t.cb(true).on_payout(P1.into()); }, "no payout in flight");
    t.check_invariants();
}

#[test]
fn only_the_verifier_verifies() {
    let mut t = reach(PurchaseState::Verifying);
    panics(|| t.as_(OP).verify(P1.into(), true, "ok".into()), "only the verifier");
    panics(|| t.as_("dave.testnet").verify(P1.into(), true, "ok".into()), "only the verifier");
}

#[test]
fn withdrawal_and_expiry_work_while_paused() {
    let mut t = reach(PurchaseState::Funded);
    t.as_(OWNER).set_paused(true);
    panics(|| t.as_(OP).start_delivery(P1.into()), "paused");
    t.withdraw("b1");
    t.advance(61);
    t.as_(ANYONE).expire(P1.into());
    assert_eq!(t.state(), PurchaseState::Refunded);
    t.check_invariants();
}

#[test]
fn solvency_is_checked_before_any_transfer() {
    let mut t = setup();
    t.balance = 0;
    panics(|| t.as_(&id("b1")).withdraw(id("b1"), None), "insolvent");
}

#[test]
fn expiry_by_third_party_returns_money_to_each_buyer() {
    // Delivery deadline: the seller never delivered.
    let mut t = reach(PurchaseState::Delivering);
    panics(|| t.as_(ANYONE).expire(P1.into()), "not reached");
    t.advance(61);
    t.as_(ANYONE).expire(P1.into());
    assert_eq!(t.state(), PurchaseState::Refunded);
    for (name, ..) in BUYERS {
        assert_eq!(t.buyer(name).available.0, BUDGET);
    }
    assert_eq!(t.seller("s1").reputation.failed_deliveries, 1);
    t.check_invariants();

    // Verification deadline.
    let mut t = reach(PurchaseState::Verifying);
    t.advance(61);
    t.as_(ANYONE).expire(P1.into());
    assert_eq!(t.state(), PurchaseState::Refunded);
    t.check_invariants();

    // Prepay deadline, part prepaid.
    let mut t = setup();
    t.prepay(P1, 0);
    t.advance(61);
    t.as_(ANYONE).expire(P1.into());
    assert_eq!(t.buyer("b1").available.0, BUDGET);
    assert!(t.buyer("b1").coalition_id.is_none());
    t.check_invariants();
}

// ---------------------------------------------------------------------- invalid transitions

type Op = (&'static str, fn(&mut T));

fn ops() -> Vec<Op> {
    vec![
        ("prepay", |t| t.prepay(P1, 0)),
        ("open_bidding", |t| t.as_(OP).open_bidding(P1.into())),
        ("commit_bid", |t| t.commit(P1, A1, "s5", PRICE_1, 5)),
        ("reveal_bid", |t| t.reveal(P1, "s1", PRICE_1, 1)),
        ("close_auction", |t| t.as_(ANYONE).close_auction(P1.into())),
        ("start_delivery", |t| t.as_(OP).start_delivery(P1.into())),
        ("submit_delivery_report", |t| t.as_(OP).submit_delivery_report(P1.into(), to_hex(&[1; 32]))),
        ("verify", |t| t.as_(VER).verify(P1.into(), true, "ok".into())),
        ("payout", |t| t.as_(ANYONE).payout(P1.into())),
        ("expire", |t| {
            t.advance(1000);
            t.as_(ANYONE).expire(P1.into())
        }),
    ]
}

#[test]
fn invalid_transitions_panic() {
    use PurchaseState::*;
    let allowed: &[(PurchaseState, &[&str])] = &[
        (Created, &["prepay", "open_bidding", "expire"]),
        (Bidding, &["commit_bid", "reveal_bid", "close_auction"]),
        (Funded, &["start_delivery", "expire"]),
        (Delivering, &["submit_delivery_report", "expire"]),
        (Verifying, &["verify", "expire"]),
        (Completed, &[]),
        (Failed, &[]),
        (Expired, &[]),
        (Refunded, &[]),
    ];
    let mut checked = 0;
    for (state, ok) in allowed {
        for (name, op) in ops() {
            if ok.contains(&name) {
                continue;
            }
            let mut t = reach(*state);
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| op(&mut t)));
            assert!(r.is_err(), "{name} from {} should panic", state.as_str());
            checked += 1;
        }
    }
    assert_eq!(checked, 9 * 10 - 12);
}

#[test]
fn events_are_nep297() {
    let mut t = setup();
    t.prepay(P1, 0);
    let logs = get_logs();
    assert!(logs.iter().all(|l| l.starts_with("EVENT_JSON:")));
    let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&logs[0]["EVENT_JSON:".len()..]).unwrap();
    assert_eq!(v["standard"], "swarmcompute");
    assert_eq!(v["event"], "prepaid");
    assert_eq!(v["data"][0]["amount"], prepay_of(0).to_string());
    assert_eq!(v["data"][0]["buyer_id"], id("b1"));
}

#[test]
fn seller_strategy_json_shape() {
    let s = near_sdk::serde_json::to_value(SellerStrategy::BelowCeiling { discount_bps: 250 }).unwrap();
    assert_eq!(s, near_sdk::serde_json::json!({ "kind": "BELOW_CEILING", "discount_bps": 250 }));
    let s = near_sdk::serde_json::to_value(SellerStrategy::AtMinimum).unwrap();
    assert_eq!(s, near_sdk::serde_json::json!({ "kind": "AT_MINIMUM" }));
}
