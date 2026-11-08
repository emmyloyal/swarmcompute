//! Unit tests (mocked chain). Real transfers, failing receipts and real block
//! time are covered by contracts/marketplace-testnet-tests.

use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, NearToken, PromiseResult, RuntimeFeesConfig};

const MKT: &str = "market.testnet";
const OWNER: &str = "owner.testnet";
const OP: &str = "operator.testnet";
const VER: &str = "verifier.testnet";
const ANYONE: &str = "rando.testnet";

const NS: u64 = 1_000_000_000;
const MILLI: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR
const NEAR: u128 = 1000 * MILLI;

const P1: &str = "purchase-1";
const A1: &str = "auction-1";
const C1: &str = "coalition-1";

/// (buyer, wallet, hours, own max price per hour)
const MEMBERS: [(&str, &str, u32, u128); 3] = [
    ("buyer-001", "w1.testnet", 10, 10 * MILLI),
    ("buyer-002", "w2.testnet", 10, 8 * MILLI),
    ("buyer-003", "w3.testnet", 10, 6 * MILLI),
];
const PRICE_1: u128 = 4 * MILLI; // seller-01 bid
const PRICE_2: u128 = 5 * MILLI; // seller-02 bid
const HOURS: u128 = 30;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn prepay_of(i: usize) -> u128 {
    MEMBERS[i].3 * MEMBERS[i].2 as u128
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
    fn seller(&mut self, id: &str) -> Seller {
        self.view().get_seller(id.into()).unwrap()
    }
    fn buyer(&mut self, id: &str) -> Buyer {
        self.view().get_buyer(id.into()).unwrap()
    }
    fn cfg(&mut self) -> Config {
        self.view().get_config()
    }
    fn prepay(&mut self, pid: &str, i: usize) {
        let (b, w, _, _) = MEMBERS[i];
        let amount = prepay_of(i);
        self.balance += amount;
        self.pay(w, amount).prepay(pid.into(), b.into());
    }
    fn prepay_all(&mut self, pid: &str) {
        for i in 0..MEMBERS.len() {
            self.prepay(pid, i);
        }
    }
    fn commit(&mut self, pid: &str, aid: &str, seller: &str, price: u128, nonce: u8) {
        let h = to_hex(&commitment::compute(aid, seller, price, &[nonce; 32]));
        self.as_(OP).commit_bid(pid.into(), seller.into(), h);
    }
    fn reveal(&mut self, pid: &str, seller: &str, price: u128, nonce: u8) {
        self.as_(OP).reveal_bid(pid.into(), seller.into(), U128(price), to_hex(&[nonce; 32]));
    }
    /// Withdraw a buyer's balance with a successful transfer.
    fn withdraw(&mut self, buyer: &str) -> u128 {
        let amount = self.buyer(buyer).balance.0;
        self.as_(ANYONE).withdraw_balance(buyer.into());
        self.balance -= amount;
        assert!(self.cb(true).on_withdraw(buyer.into()));
        amount
    }
    fn check_invariants(&mut self) {
        let cfg = self.cfg();
        let held: u128 = self.view().list_purchase_ids(None, None).into_iter().map(|id| self.p(&id).held.0).sum();
        assert_eq!(cfg.total_escrowed.0, held, "total_escrowed == Σ held");
        let balances: u128 = ["buyer-001", "buyer-002", "buyer-003"].iter().map(|b| self.buyer(b).balance.0).sum();
        assert_eq!(cfg.total_balances.0, balances, "total_balances == Σ buyer balances");
        let s = self.view().get_solvency();
        assert!(s.account_balance.0 - s.storage_cost.0 >= s.total_escrowed.0 + s.total_balances.0, "solvent");
    }
}

fn offer(m: GpuModel, vram: u32, cap: u32) -> GpuOffer {
    GpuOffer { gpu_model: m, vram_gb: vram, capacity_hours: cap }
}

fn windows() -> Windows {
    Windows { prepay_secs: 60, commit_secs: 60, reveal_secs: 60, delivery_secs: 60, verification_secs: 60 }
}

fn members() -> Vec<CoalitionMember> {
    MEMBERS.iter().map(|(b, _, h, m)| CoalitionMember { buyer_id: b.to_string(), hours: *h, max_price_per_hour: U128(*m) }).collect()
}

/// 3 buyers with wallets, 5 sellers, coalition-1 (A100/80 GB/30 h, min 2), purchase-1 CREATED.
fn setup() -> T {
    let mut t = T { c: None, now: 1_700_000_000 * NS, height: 100, balance: 10 * NEAR };
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
    let b = t.builder(OWNER, 0);
    testing_env!(b.build());
    t.c = Some(Marketplace::new(acc(OWNER), acc(OP), acc(VER)));
    for (b, w, _, _) in MEMBERS {
        t.as_(OP).register_buyer(b.into(), U128(NEAR), acc(w));
    }
    use GpuModel::*;
    let sellers = [
        ("seller-01", vec![offer(A100, 80, 100)]),
        ("seller-02", vec![offer(A100, 80, 100)]),
        ("seller-03", vec![offer(H100, 80, 100)]),
        ("seller-04", vec![offer(A100, 40, 100)]),
        ("seller-05", vec![offer(A100, 80, 5)]),
    ];
    for (i, (s, o)) in sellers.into_iter().enumerate() {
        t.as_(OP).register_seller(s.into(), acc(&format!("seller{}.testnet", i + 1)), o);
    }
    t.as_(OP).register_coalition(C1.into(), A100, 80, 2, members());
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
        // FAILED with nothing held: a member leaves in CREATED before anyone prepaid, below min.
        t.as_(OP).leave_coalition(C1.into(), "buyer-001".into());
        t.as_(OP).leave_coalition(C1.into(), "buyer-002".into());
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
    t.commit(P1, A1, "seller-01", PRICE_1, 1);
    t.commit(P1, A1, "seller-02", PRICE_2, 2);
    t.advance(61);
    t.reveal(P1, "seller-01", PRICE_1, 1);
    t.reveal(P1, "seller-02", PRICE_2, 2);
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

// ---------------------------------------------------------------------- registration

#[test]
fn roles_and_pause() {
    let mut t = setup();
    panics(|| t.as_(OP).set_roles(None, Some(acc(ANYONE))), "only the owner");
    panics(|| t.as_(OWNER).set_roles(Some(acc(MKT)), None), "contract account");
    t.as_(OWNER).set_roles(None, Some(acc("verifier2.testnet")));
    assert_eq!(t.cfg().verifier, acc("verifier2.testnet"));
    t.as_(OWNER).set_paused(true);
    panics(|| t.as_(OP).register_buyer("buyer-009".into(), U128(1), acc("w9.testnet")), "paused");
    panics(|| t.prepay(P1, 0), "paused");
    t.as_(OWNER).set_paused(false);
    t.as_(OWNER).set_owner(acc("owner2.testnet"));
    panics(|| t.as_(OWNER).set_paused(true), "only the owner");
}

#[test]
fn registration_validation() {
    let mut t = setup();
    panics(|| t.as_(ANYONE).register_buyer("buyer-010".into(), U128(1), acc("w.testnet")), "only the operator");
    panics(|| t.as_(OP).register_buyer("buyer-10".into(), U128(1), acc("w.testnet")), "invalid buyer_id");
    panics(|| t.as_(OP).register_buyer("buyer-010".into(), U128(0), acc("w.testnet")), "positive");
    panics(|| t.as_(OP).register_buyer("buyer-010".into(), U128(1), acc(MKT)), "wallet cannot be the contract");
    panics(|| t.as_(OP).register_buyer("buyer-001".into(), U128(1), acc("w.testnet")), "already registered");
    let o = vec![offer(GpuModel::A100, 80, 10)];
    panics(|| t.as_(OP).register_seller("seller-06".into(), acc(MKT), o.clone()), "cannot be the contract");
    panics(|| t.as_(OP).register_seller("seller-06".into(), acc("x.testnet"), vec![]), "offers");
    let m = |b: &str, h, p| CoalitionMember { buyer_id: b.into(), hours: h, max_price_per_hour: U128(p) };
    let reg = |t: &mut T, id: &str, min: u32, ms: Vec<CoalitionMember>| t.as_(OP).register_coalition(id.into(), GpuModel::A100, 80, min, ms);
    panics(|| reg(&mut t, "Coal-2", 1, vec![m("buyer-001", 1, 1)]), "invalid coalition_id");
    panics(|| reg(&mut t, "coal-2", 1, vec![m("buyer-099", 1, 1)]), "not a registered buyer");
    panics(|| reg(&mut t, "coal-2", 1, vec![m("buyer-001", 1, 1), m("buyer-001", 2, 1)]), "duplicate member");
    panics(|| reg(&mut t, "coal-2", 3, vec![m("buyer-001", 1, 1)]), "fewer members");
    panics(|| reg(&mut t, "coal-2", 1, vec![m("buyer-001", 1, 0)]), "max price must be positive");
    // Ceiling and budget are derived from the members, not supplied.
    let c = t.view().get_coalition(C1.into()).unwrap();
    assert_eq!(c.price_ceiling(), 6 * MILLI);
    assert_eq!(c.total_budget(), prepay_of(0) + prepay_of(1) + prepay_of(2));
}

// ---------------------------------------------------------------------- prepay

#[test]
fn prepay_rules() {
    let mut t = setup();
    let (b0, w0, _, _) = MEMBERS[0];
    let amt = prepay_of(0);
    panics(|| t.pay(ANYONE, amt).prepay(P1.into(), b0.into()), "only the buyer's own wallet");
    panics(|| t.pay("w2.testnet", amt).prepay(P1.into(), b0.into()), "only the buyer's own wallet");
    panics(|| t.pay(w0, amt - 1).prepay(P1.into(), b0.into()), "exactly");
    panics(|| t.pay(w0, amt + 1).prepay(P1.into(), b0.into()), "exactly");
    panics(|| t.as_(OP).open_bidding(P1.into()), "every member must prepay");
    t.prepay(P1, 0);
    panics(|| t.prepay(P1, 0), "already prepaid");
    let p = t.p(P1);
    assert_eq!((p.deposited.0, p.held.0), (amt, amt));
    assert_eq!(t.buyer(b0).reserved.0, amt);
    t.prepay(P1, 1);
    panics(|| t.as_(OP).open_bidding(P1.into()), "every member must prepay");
    t.advance(61);
    panics(|| t.prepay(P1, 2), "prepay deadline passed");
    t.check_invariants();

    // Non-member and budget limits.
    let mut t = setup();
    t.as_(OP).register_buyer("buyer-009".into(), U128(1), acc("w9.testnet"));
    panics(|| t.pay("w9.testnet", 1).prepay(P1.into(), "buyer-009".into()), "not a member");
    let small = vec![CoalitionMember { buyer_id: "buyer-009".into(), hours: 2, max_price_per_hour: U128(1) }];
    t.as_(OP).register_coalition("coal-9".into(), GpuModel::A100, 80, 1, small);
    t.as_(OP).create_purchase("purchase-9".into(), "auction-9".into(), "coal-9".into(), windows());
    panics(|| t.pay("w9.testnet", 2).prepay("purchase-9".into(), "buyer-009".into()), "exceeds buyer's remaining budget");
}

// ---------------------------------------------------------------------- the fairness guarantees

#[test]
fn every_member_pays_one_clearing_price_and_gets_its_excess_back() {
    let mut t = reach(PurchaseState::Bidding);
    t.check_invariants();
    t.commit(P1, A1, "seller-01", PRICE_1, 1);
    t.commit(P1, A1, "seller-02", PRICE_2, 2);
    t.advance(61);
    t.reveal(P1, "seller-01", PRICE_1, 1);
    t.reveal(P1, "seller-02", PRICE_2, 2);
    t.advance(61);
    t.as_(ANYONE).close_auction(P1.into());
    let logs = get_logs();
    let p = t.p(P1);

    // Lowest eligible bid wins and becomes the clearing price; escrow is funded at once.
    assert_eq!(p.state, PurchaseState::Funded);
    assert_eq!(p.winner_seller_id.as_deref(), Some("seller-01"));
    assert_eq!(p.clearing_price_per_hour, Some(U128(PRICE_1)));

    // Every member: same rate, never above its own max, excess exactly prepaid − owed.
    for (i, a) in p.allocations.iter().enumerate() {
        let (b, _, hours, max) = MEMBERS[i];
        assert_eq!(a.buyer_id, b);
        assert_eq!(a.owed.0, PRICE_1 * hours as u128, "same clearing rate for {b}");
        assert_eq!(a.owed.0 / hours as u128, PRICE_1);
        assert!(PRICE_1 <= max, "never above own max");
        assert_eq!(a.excess.0, a.prepaid.0 - a.owed.0);
        assert_eq!(t.buyer(b).balance.0, a.excess.0, "excess credited to {b}");
        assert_eq!(t.buyer(b).reserved.0, a.owed.0);
    }
    assert_eq!(p.held.0, PRICE_1 * HOURS);
    assert_eq!(p.required_total, Some(U128(PRICE_1 * HOURS)));
    assert!(logs.iter().any(|l| l.contains("\"purchase_funded\"") && l.contains("\"excess\"")));
    assert_eq!(logs.iter().filter(|l| l.contains("\"balance_credited\"") && l.contains("excess_over_clearing_price")).count(), 3);
    t.check_invariants();

    // The balance goes to each buyer's own wallet.
    for (b, w, _, _) in MEMBERS {
        let expected = t.buyer(b).balance.0;
        t.as_(ANYONE).withdraw_balance(b.into());
        assert!(get_logs().iter().any(|l| l.contains("\"withdrawal_started\"") && l.contains(w)));
        t.balance -= expected;
        assert!(t.cb(true).on_withdraw(b.into()));
        let after = t.buyer(b);
        assert_eq!((after.balance.0, after.withdrawing.0), (0, 0));
    }
    t.check_invariants();
    assert_eq!(t.cfg().total_balances.0, 0);
}

#[test]
fn completed_purchase_pays_seller_and_records_spend_at_the_clearing_price() {
    let mut t = reach(PurchaseState::Completed);
    let p = t.p(P1);
    assert_eq!((p.state, p.held.0, p.paid_out.0), (PurchaseState::Completed, 0, PRICE_1 * HOURS));
    for (b, _, h, _) in MEMBERS {
        let buyer = t.buyer(b);
        assert_eq!((buyer.reserved.0, buyer.spent.0), (0, PRICE_1 * h as u128));
    }
    let r = t.seller("seller-01").reputation;
    assert_eq!((r.wins, r.completed_deliveries), (1, 1));
    // Each buyer's total out of pocket = owed; everything else is withdrawable.
    for (i, (b, _, _, _)) in MEMBERS.iter().enumerate() {
        assert_eq!(t.buyer(b).balance.0 + PRICE_1 * MEMBERS[i].2 as u128, prepay_of(i));
    }
    t.check_invariants();
}

#[test]
fn failed_delivery_returns_every_members_money_to_that_member() {
    let mut t = reach(PurchaseState::Refunded);
    let logs = get_logs(); // logs of the verify(fail) call, before views reset them
    let p = t.p(P1);
    assert_eq!((p.state, p.held.0), (PurchaseState::Refunded, 0));
    // Excess came back at award, owed came back on failure: each member gets everything it prepaid.
    for (i, (b, _, _, _)) in MEMBERS.iter().enumerate() {
        let buyer = t.buyer(b);
        assert_eq!(buyer.balance.0, prepay_of(i), "{b} gets its full prepayment back");
        assert_eq!((buyer.reserved.0, buyer.spent.0), (0, 0));
        assert_eq!(p.allocations[i].refunded.0, p.allocations[i].owed.0);
    }
    assert!(logs.iter().any(|l| l.contains("\"refund_succeeded\"")));
    assert_eq!(t.seller("seller-01").reputation.failed_deliveries, 1);
    panics(|| t.as_(ANYONE).payout(P1.into()), "invalid state");
    t.check_invariants();
}

#[test]
fn no_eligible_bid_returns_full_prepayments() {
    let mut t = reach(PurchaseState::Bidding);
    let bids = [("seller-02", 6 * MILLI + 1), ("seller-03", PRICE_1), ("seller-04", PRICE_1), ("seller-05", PRICE_1)];
    for (i, (s, p)) in bids.iter().enumerate() {
        t.commit(P1, A1, s, *p, i as u8);
    }
    t.advance(61);
    for (i, (s, p)) in bids.iter().enumerate() {
        t.reveal(P1, s, *p, i as u8);
    }
    t.advance(61);
    t.as_(ANYONE).close_auction(P1.into());
    let p = t.p(P1);
    assert_eq!(p.state, PurchaseState::Refunded);
    let reasons: Vec<_> = p.bids.iter().map(|b| b.ineligibility_reason.clone().unwrap()).collect();
    assert_eq!(reasons, ["ABOVE_PRICE_CEILING", "GPU_MISMATCH", "VRAM_TOO_LOW", "INSUFFICIENT_CAPACITY"]);
    for (i, (b, _, _, _)) in MEMBERS.iter().enumerate() {
        assert_eq!(t.buyer(b).balance.0, prepay_of(i));
    }
    assert_eq!(t.view().get_coalition(C1.into()).unwrap().live_purchase_id, None);
    t.check_invariants();
}

// ---------------------------------------------------------------------- auction mechanics

#[test]
fn commit_reveal_rules() {
    let mut t = reach(PurchaseState::Bidding);
    panics(|| t.as_(ANYONE).commit_bid(P1.into(), "seller-01".into(), "00".repeat(32)), "only the operator");
    panics(|| t.as_(OP).commit_bid(P1.into(), "seller-09".into(), "00".repeat(32)), "not registered");
    t.commit(P1, A1, "seller-01", PRICE_1, 1);
    panics(|| t.commit(P1, A1, "seller-01", PRICE_2, 2), "already committed");
    panics(|| t.reveal(P1, "seller-01", PRICE_1, 1), "reveal phase has not started");
    t.advance(61);
    panics(|| t.commit(P1, A1, "seller-02", PRICE_2, 2), "commit phase is over");
    panics(|| t.reveal(P1, "seller-01", PRICE_2, 1), "commitment mismatch");
    panics(|| t.reveal(P1, "seller-01", PRICE_1, 9), "commitment mismatch");
    panics(|| t.as_(ANYONE).close_auction(P1.into()), "reveal phase is not over");
    t.reveal(P1, "seller-01", PRICE_1, 1);
    panics(|| t.reveal(P1, "seller-01", PRICE_1, 1), "already revealed");
    t.advance(61);
    t.as_(ANYONE).close_auction(P1.into());
    assert_eq!(t.state(), PurchaseState::Funded);
}

#[test]
fn non_reveal_is_excluded_and_penalised() {
    let mut t = reach(PurchaseState::Bidding);
    t.commit(P1, A1, "seller-01", PRICE_1, 1); // cheaper, never revealed
    t.commit(P1, A1, "seller-02", PRICE_2, 2);
    t.advance(61);
    t.reveal(P1, "seller-02", PRICE_2, 2);
    t.advance(61);
    t.as_(ANYONE).close_auction(P1.into());
    let p = t.p(P1);
    assert_eq!(p.winner_seller_id.as_deref(), Some("seller-02"));
    assert_eq!(p.clearing_price_per_hour, Some(U128(PRICE_2)));
    assert_eq!(p.bids[0].ineligibility_reason.as_deref(), Some("NOT_REVEALED"));
    assert_eq!(t.seller("seller-01").reputation.non_reveals, 1);
}

#[test]
fn tie_break_order() {
    fn run(prep: impl FnOnce(&mut T), order: &[(&str, u128)]) -> String {
        let mut t = reach(PurchaseState::Bidding);
        prep(&mut t);
        for (i, (s, p)) in order.iter().enumerate() {
            t.commit(P1, A1, s, *p, i as u8);
        }
        t.advance(61);
        for (i, (s, p)) in order.iter().enumerate() {
            t.reveal(P1, s, *p, i as u8);
        }
        t.advance(61);
        t.as_(ANYONE).close_auction(P1.into());
        t.p(P1).winner_seller_id.unwrap()
    }
    assert_eq!(run(|_| {}, &[("seller-01", PRICE_2), ("seller-02", PRICE_1)]), "seller-02");
    assert_eq!(run(|_| {}, &[("seller-02", PRICE_1), ("seller-01", PRICE_1)]), "seller-02");
    let boost = |t: &mut T| {
        let mut s = t.c.as_ref().unwrap().sellers.get("seller-01").unwrap().clone();
        s.reputation.completed_deliveries = 3;
        t.c.as_mut().unwrap().sellers.insert("seller-01".into(), s);
    };
    assert_eq!(run(boost, &[("seller-02", PRICE_1), ("seller-01", PRICE_1)]), "seller-01");
}

// ---------------------------------------------------------------------- payout / withdrawal safety

#[test]
fn payout_failure_then_retry_and_no_double_payout() {
    let mut t = reach(PurchaseState::Verifying);
    panics(|| t.as_(ANYONE).payout(P1.into()), "not verified");
    panics(|| t.as_(OP).verify(P1.into(), true, "ok".into()), "only the verifier");
    t.as_(VER).verify(P1.into(), true, "ok".into());
    panics(|| t.as_(VER).verify(P1.into(), true, "again".into()), "already verified");
    panics(|| t.as_(ANYONE).payout(P1.into()), "in flight");
    assert!(!t.cb(false).on_payout(P1.into()));
    let p = t.p(P1);
    assert_eq!((p.state, p.payout_in_flight, p.held.0), (PurchaseState::Verifying, false, PRICE_1 * HOURS));
    t.advance(120);
    panics(|| t.as_(ANYONE).expire(P1.into()), "already verified");
    t.as_(ANYONE).payout(P1.into());
    t.balance -= PRICE_1 * HOURS;
    assert!(t.cb(true).on_payout(P1.into()));
    assert_eq!(t.state(), PurchaseState::Completed);
    panics(|| t.as_(ANYONE).payout(P1.into()), "invalid state");
    panics(|| _ = t.cb(true).on_payout(P1.into()), "no payout in flight");
    t.check_invariants();
}

#[test]
fn withdrawal_failure_then_retry_and_no_double_withdrawal() {
    let mut t = reach(PurchaseState::Funded);
    let b = "buyer-001";
    let amount = t.buyer(b).balance.0;
    assert!(amount > 0);
    t.as_(ANYONE).withdraw_balance(b.into());
    panics(|| t.as_(ANYONE).withdraw_balance(b.into()), "already in flight");
    assert!(!t.cb(false).on_withdraw(b.into()));
    assert_eq!((t.buyer(b).balance.0, t.buyer(b).withdrawing.0), (amount, 0));
    t.check_invariants();
    assert_eq!(t.withdraw(b), amount);
    panics(|| t.as_(ANYONE).withdraw_balance(b.into()), "no balance");
    panics(|| _ = t.cb(true).on_withdraw(b.into()), "no withdrawal in flight");
    t.check_invariants();
}

#[test]
fn withdrawal_and_expiry_work_while_paused() {
    let mut t = reach(PurchaseState::Funded);
    t.as_(OWNER).set_paused(true);
    panics(|| t.as_(OP).start_delivery(P1.into()), "paused");
    t.withdraw("buyer-002");
    t.advance(61);
    t.as_(ANYONE).expire(P1.into());
    assert_eq!(t.state(), PurchaseState::Refunded);
    t.check_invariants();
}

#[test]
fn solvency_is_checked_before_any_transfer() {
    let mut t = reach(PurchaseState::Funded);
    t.balance = 0;
    panics(|| t.as_(ANYONE).withdraw_balance("buyer-001".into()), "insolvent");
}

// ---------------------------------------------------------------------- expiry

#[test]
fn expiry_by_third_party_returns_money_to_each_buyer() {
    // CREATED: partial prepayments returned at the prepay deadline.
    let mut t = setup();
    t.prepay(P1, 0);
    panics(|| t.as_(ANYONE).expire(P1.into()), "not reached");
    t.advance(61);
    t.as_(ANYONE).expire(P1.into());
    assert_eq!(t.state(), PurchaseState::Refunded);
    assert_eq!(t.buyer("buyer-001").balance.0, prepay_of(0));
    t.check_invariants();

    // FUNDED (operator stalled): owed amounts returned; seller not penalised.
    let mut t = reach(PurchaseState::Funded);
    t.advance(61);
    t.as_(ANYONE).expire(P1.into());
    assert_eq!(t.state(), PurchaseState::Refunded);
    assert_eq!(t.seller("seller-01").reputation.failed_deliveries, 0);
    for (i, (b, _, _, _)) in MEMBERS.iter().enumerate() {
        assert_eq!(t.buyer(b).balance.0, prepay_of(i));
    }

    // DELIVERING: seller failed to deliver.
    let mut t = reach(PurchaseState::Delivering);
    t.advance(61);
    t.as_(ANYONE).expire(P1.into());
    assert_eq!(t.seller("seller-01").reputation.failed_deliveries, 1);

    // VERIFYING: verifier stalled.
    let mut t = reach(PurchaseState::Verifying);
    t.advance(61);
    panics(|| t.as_(VER).verify(P1.into(), true, "late".into()), "deadline passed");
    t.as_(ANYONE).expire(P1.into());
    assert_eq!(t.state(), PurchaseState::Refunded);
    t.check_invariants();
}

// ---------------------------------------------------------------------- membership

#[test]
fn leaving_before_funding_returns_the_prepayment() {
    let mut t = setup();
    t.prepay_all(P1);
    t.as_(OP).leave_coalition(C1.into(), "buyer-003".into());
    assert_eq!(t.buyer("buyer-003").balance.0, prepay_of(2));
    let p = t.p(P1);
    assert_eq!(p.held.0, prepay_of(0) + prepay_of(1));
    assert_eq!(p.allocations.len(), 2);
    // Ceiling rises to the lowest remaining max (0.008): nobody remaining pays above its max.
    assert_eq!(t.view().get_coalition(C1.into()).unwrap().price_ceiling(), 8 * MILLI);
    t.as_(OP).open_bidding(P1.into());
    t.check_invariants();

    // Below min during BIDDING: coalition fails and everyone gets its prepayment back.
    let mut t = reach(PurchaseState::Bidding);
    t.as_(OP).leave_coalition(C1.into(), "buyer-001".into());
    t.as_(OP).leave_coalition(C1.into(), "buyer-002".into());
    assert_eq!(t.state(), PurchaseState::Refunded);
    for (i, (b, _, _, _)) in MEMBERS.iter().enumerate() {
        assert_eq!(t.buyer(b).balance.0, prepay_of(i));
    }
    assert!(t.view().get_coalition(C1.into()).unwrap().failed);
    t.check_invariants();

    let mut t = reach(PurchaseState::Funded);
    panics(|| t.as_(OP).leave_coalition(C1.into(), "buyer-001".into()), "after funding");
}

// ---------------------------------------------------------------------- invalid transitions

type Op = (&'static str, fn(&mut T));

fn ops() -> Vec<Op> {
    vec![
        ("prepay", |t| {
            let b = "buyer-009";
            if t.view().get_buyer(b.into()).is_none() {
                t.as_(OP).register_buyer(b.into(), U128(NEAR), acc("w9.testnet"));
            }
            t.pay("w1.testnet", prepay_of(0)).prepay(P1.into(), "buyer-001".into())
        }),
        ("open_bidding", |t| t.as_(OP).open_bidding(P1.into())),
        ("commit_bid", |t| t.commit(P1, A1, "seller-05", PRICE_1, 5)),
        ("reveal_bid", |t| t.reveal(P1, "seller-01", PRICE_1, 1)),
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
            assert_eq!(t.state(), if *state == Expired { Expired } else { *state });
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
}

#[test]
fn budget_counts_completed_spend_across_purchases() {
    let mut t = reach(PurchaseState::Completed);
    // buyer-001 spent 0.04 of its 1 NEAR budget; a coalition needing 0.97 must be refused.
    let m = vec![CoalitionMember { buyer_id: "buyer-001".into(), hours: 97, max_price_per_hour: U128(10 * MILLI) }];
    t.as_(OP).register_coalition("coal-2".into(), GpuModel::A100, 80, 1, m);
    t.as_(OP).create_purchase("purchase-2".into(), "auction-2".into(), "coal-2".into(), windows());
    panics(|| t.pay("w1.testnet", 97 * 10 * MILLI).prepay("purchase-2".into(), "buyer-001".into()), "remaining budget");
}
