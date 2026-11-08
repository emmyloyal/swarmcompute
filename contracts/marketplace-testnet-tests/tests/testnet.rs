//! Real-chain tests on NEAR Testnet for the fair-price marketplace (RULES.md R1: testnet only).
//!
//! Covers what the mocked unit tests cannot: buyers prepaying from their own real
//! wallets, the clearing price applied to every member, excess and refunds sent
//! to each buyer's wallet, a payout receipt that genuinely fails and is retried,
//! a withdrawal to a deleted wallet that genuinely fails and is retried,
//! `#[private]` enforcement, real block-time deadlines and expiry by a third
//! party. Every transaction hash goes to `target/testnet-report.md`.
//!
//! Run (ignored by default: spends testnet NEAR, takes several minutes):
//!   cd contracts/marketplace && cargo near build non-reproducible-wasm --no-abi
//!   cd ../marketplace-testnet-tests && cargo test -- --ignored --nocapture
//!
//! Account: NEAR_TEST_ACCOUNT_ID + NEAR_TEST_PRIVATE_KEY (~12 NEAR), else a dev
//! account from the testnet helper. Optional NEAR_TESTNET_RPC_URL.

use anyhow::{anyhow, bail, ensure, Context, Result};
use near_workspaces::network::Testnet;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::str::FromStr;
use std::time::Duration;

const MILLI: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR
const WASM: &str = "../marketplace/target/near/marketplace.wasm";
/// (buyer, hours, own max price per hour in milliNEAR)
const MEMBERS: [(&str, u32, u128); 3] = [("buyer-001", 10, 3), ("buyer-002", 10, 2), ("buyer-003", 10, 2)];

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// ARCHITECTURE.md §6 commitment encoding.
fn commitment(auction: &str, seller: &str, price: u128, nonce: &[u8; 32]) -> String {
    let mut h = Sha256::new();
    for part in [auction.as_bytes(), seller.as_bytes(), &price.to_be_bytes(), nonce] {
        h.update((part.len() as u32).to_be_bytes());
        h.update(part);
    }
    hex(&h.finalize())
}

fn n(v: &Value) -> u128 {
    v.as_str().and_then(|s| s.parse().ok()).unwrap_or_else(|| panic!("not a u128 string: {v}"))
}

struct Ctx {
    worker: Worker<Testnet>,
    master: Account,
    contract: Contract,
    rando: Account,
    wallets: Vec<Account>,
    pay1: Account,
    pay2_id: AccountId,
    pay2: Option<Account>,
    suffix: String,
    report: Vec<(String, String, bool)>,
}

impl Ctx {
    fn record(&mut self, label: &str, r: &ExecutionFinalResult) {
        let hash = r.outcome().transaction_hash.to_string();
        let ok = r.is_success() && r.receipt_failures().is_empty();
        println!("  {:<58} {} {}", label, hash, if ok { "" } else { "(has failures)" });
        self.report.push((label.to_string(), hash, ok));
    }

    async fn call(&mut self, label: &str, who: &Account, method: &str, args: Value, deposit: u128, tgas: u64) -> Result<ExecutionFinalResult> {
        let r = who
            .call(self.contract.id(), method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(Gas::from_tgas(tgas))
            .transact()
            .await?;
        self.record(label, &r);
        Ok(r)
    }

    async fn ok(&mut self, label: &str, who: &Account, method: &str, args: Value) -> Result<()> {
        let who = who.clone();
        let r = self.call(label, &who, method, args, 0, 150).await?;
        ensure!(r.is_success() && r.receipt_failures().is_empty(), "{label} failed: {:?}", r.into_result().err());
        Ok(())
    }

    async fn fails(&mut self, label: &str, who: &Account, method: &str, args: Value, deposit: u128, msg: &str) -> Result<()> {
        let who = who.clone();
        let r = self.call(label, &who, method, args, deposit, 50).await?;
        ensure!(!r.is_success(), "{label} unexpectedly succeeded");
        let err = format!("{:?}", r.into_result().err());
        ensure!(err.contains(msg), "{label}: failure {err} does not contain {msg:?}");
        Ok(())
    }

    async fn view(&self, method: &str, args: Value) -> Result<Value> {
        Ok(self.contract.view(method).args_json(args).await?.json()?)
    }

    async fn purchase(&self, id: &str) -> Result<Value> {
        self.view("get_purchase", json!({ "purchase_id": id })).await
    }

    async fn buyer(&self, id: &str) -> Result<Value> {
        self.view("get_buyer", json!({ "buyer_id": id })).await
    }

    async fn balance(&self, id: &AccountId) -> Result<u128> {
        Ok(self.worker.view_account(id).await?.balance.as_yoctonear())
    }

    async fn wait_past(&self, deadline: &Value) -> Result<()> {
        let d: u64 = deadline.as_str().context("deadline")?.parse()?;
        loop {
            if self.worker.view_block().await?.timestamp() > d {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
    }

    async fn check_invariant(&self) -> Result<()> {
        let s = self.view("get_solvency", json!({})).await?;
        ensure!(
            n(&s["account_balance"]) - n(&s["storage_cost"]) >= n(&s["total_escrowed"]) + n(&s["total_balances"]),
            "solvency invariant broken: {s}"
        );
        Ok(())
    }

    /// Withdraw a buyer's balance (third party) and check its wallet received exactly that.
    async fn withdraw(&mut self, i: usize) -> Result<u128> {
        let (b, _, _) = MEMBERS[i];
        let amount = n(&self.buyer(b).await?["balance"]);
        let wallet = self.wallets[i].id().clone();
        let before = self.balance(&wallet).await?;
        let rnd = self.rando.clone();
        self.ok(&format!("withdraw_balance {b} (third party)"), &rnd, "withdraw_balance", json!({ "buyer_id": b })).await?;
        let after = self.balance(&wallet).await?;
        ensure!(after - before == amount, "{b}'s wallet should receive exactly {amount}, got {}", after - before);
        ensure!(n(&self.buyer(b).await?["balance"]) == 0);
        Ok(amount)
    }

    /// Coalition + purchase; every member prepays its own max from its own wallet;
    /// commit/reveal; third-party close. Returns the purchase after close.
    async fn auction(&mut self, tag: &str, delivery_secs: u32, bids: &[(&str, u128)]) -> Result<Value> {
        let (cid, pid, aid) = (format!("coal-{tag}"), format!("purchase-{tag}"), format!("auction-{tag}-{}", self.suffix));
        let m = self.master.clone();
        let members: Vec<Value> = MEMBERS.iter().map(|(b, h, p)| json!({ "buyer_id": b, "hours": h, "max_price_per_hour": (p * MILLI).to_string() })).collect();
        self.ok(&format!("[{tag}] register_coalition"), &m, "register_coalition", json!({ "coalition_id": cid, "gpu_model": "A100", "vram_gb": 80, "min_members": 2, "members": members })).await?;
        let windows = json!({ "prepay_secs": 600, "commit_secs": 45, "reveal_secs": 60, "delivery_secs": delivery_secs, "verification_secs": 600 });
        self.ok(&format!("[{tag}] create_purchase"), &m, "create_purchase", json!({ "purchase_id": pid, "auction_id": aid, "coalition_id": cid, "windows": windows })).await?;

        // A wallet can't prepay for someone else, nor the wrong amount.
        let w0 = self.wallets[0].clone();
        self.fails(&format!("[{tag}] prepay buyer-002 from buyer-001's wallet (rejected)"), &w0, "prepay", json!({ "purchase_id": pid, "buyer_id": "buyer-002" }), 20 * MILLI, "own wallet").await?;
        self.fails(&format!("[{tag}] prepay wrong amount (rejected)"), &w0, "prepay", json!({ "purchase_id": pid, "buyer_id": "buyer-001" }), 30 * MILLI - 1, "exactly").await?;
        for (i, (b, h, p)) in MEMBERS.iter().enumerate() {
            let w = self.wallets[i].clone();
            let r = self.call(&format!("[{tag}] prepay {b} (own wallet, own max)"), &w, "prepay", json!({ "purchase_id": pid, "buyer_id": b }), p * MILLI * *h as u128, 30).await?;
            ensure!(r.is_success(), "prepay {b} failed: {:?}", r.into_result().err());
        }
        self.ok(&format!("[{tag}] open_bidding"), &m, "open_bidding", json!({ "purchase_id": pid })).await?;
        for (i, (seller, price)) in bids.iter().enumerate() {
            let c = commitment(&aid, seller, *price, &[i as u8 + 1; 32]);
            self.ok(&format!("[{tag}] commit_bid {seller}"), &m, "commit_bid", json!({ "purchase_id": pid, "seller_id": seller, "commitment_hex": c })).await?;
        }
        let p = self.purchase(&pid).await?;
        self.wait_past(&p["commit_deadline"]).await?;
        let (s0, p0) = bids[0];
        self.fails(&format!("[{tag}] reveal {s0} wrong price (rejected)"), &m, "reveal_bid", json!({ "purchase_id": pid, "seller_id": s0, "price_per_hour": (p0 + 1).to_string(), "nonce_hex": hex(&[1; 32]) }), 0, "commitment mismatch").await?;
        for (i, (seller, price)) in bids.iter().enumerate() {
            self.ok(&format!("[{tag}] reveal_bid {seller}"), &m, "reveal_bid", json!({ "purchase_id": pid, "seller_id": seller, "price_per_hour": price.to_string(), "nonce_hex": hex(&[i as u8 + 1; 32]) })).await?;
        }
        self.wait_past(&p["reveal_deadline"]).await?;
        let r = self.rando.clone();
        self.ok(&format!("[{tag}] close_auction (third party)"), &r, "close_auction", json!({ "purchase_id": pid })).await?;
        let p = self.purchase(&pid).await?;
        ensure!(p["state"] == "FUNDED", "[{tag}] expected FUNDED, got {}", p["state"]);

        // Fairness, checked on the contract's own numbers.
        let lowest = bids.iter().map(|(_, p)| *p).min().unwrap();
        let price = n(&p["clearing_price_per_hour"]);
        ensure!(price == lowest, "clearing price must be the lowest bid");
        for a in p["allocations"].as_array().unwrap() {
            let hours = a["hours"].as_u64().unwrap() as u128;
            ensure!(n(&a["owed"]) == price * hours, "same rate for {}", a["buyer_id"]);
            ensure!(n(&a["excess"]) == n(&a["prepaid"]) - n(&a["owed"]), "excess credited for {}", a["buyer_id"]);
            ensure!(price <= n(&a["max_price_per_hour"]), "never above own max");
        }
        ensure!(n(&p["held"]) == price * 30, "escrow holds exactly what is owed");
        self.check_invariant().await?;
        Ok(p)
    }

    async fn deliver(&mut self, tag: &str) -> Result<()> {
        let pid = format!("purchase-{tag}");
        let m = self.master.clone();
        self.ok(&format!("[{tag}] start_delivery"), &m, "start_delivery", json!({ "purchase_id": pid })).await?;
        self.ok(&format!("[{tag}] submit_delivery_report"), &m, "submit_delivery_report", json!({ "purchase_id": pid, "report_hash_hex": hex(&[7; 32]) })).await
    }
}

async fn master_account(worker: &Worker<Testnet>) -> Result<Account> {
    match (std::env::var("NEAR_TEST_ACCOUNT_ID"), std::env::var("NEAR_TEST_PRIVATE_KEY")) {
        (Ok(id), Ok(sk)) => {
            ensure!(id.ends_with(".testnet"), "NEAR_TEST_ACCOUNT_ID must be a .testnet account");
            let sk = SecretKey::from_str(&sk).map_err(|e| anyhow!("NEAR_TEST_PRIVATE_KEY: {e}"))?;
            Ok(Account::from_secret_key(id.parse()?, sk, worker))
        }
        _ => {
            println!("NEAR_TEST_ACCOUNT_ID/NEAR_TEST_PRIVATE_KEY unset: requesting a dev account from the testnet helper");
            worker.dev_create_account().await.context("testnet helper could not create a dev account; set NEAR_TEST_ACCOUNT_ID and NEAR_TEST_PRIVATE_KEY")
        }
    }
}

async fn sub(master: &Account, name: &str, milli: u128) -> Result<Account> {
    master
        .create_subaccount(name)
        .initial_balance(NearToken::from_millinear(milli))
        .transact()
        .await?
        .into_result()
        .map_err(|e| anyhow!("create {name}: {e:?}"))
}

async fn setup() -> Result<Ctx> {
    let rpc = std::env::var("NEAR_TESTNET_RPC_URL").unwrap_or_else(|_| "https://test.rpc.fastnear.com".into());
    let worker = near_workspaces::testnet().rpc_addr(&rpc).await?;
    let master = master_account(&worker).await?;
    let wasm = std::fs::read(WASM).with_context(|| format!("{WASM} missing: run `cargo near build non-reproducible-wasm --no-abi` in contracts/marketplace"))?;
    let bal = worker.view_account(master.id()).await?.balance;
    println!("master {} balance {} | wasm {} bytes", master.id(), bal.exact_amount_display(), wasm.len());
    ensure!(bal.as_near() >= 9, "master account needs at least ~9 NEAR");

    let suffix = format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs());
    let contract_acc = sub(&master, &format!("mkt{suffix}"), 6000).await?;
    let rando = sub(&master, &format!("rnd{suffix}"), 1000).await?;
    let pay1 = sub(&master, &format!("pay1{suffix}"), 50).await?;
    let mut wallets = vec![];
    for i in 1..=3 {
        wallets.push(sub(&master, &format!("w{i}{suffix}"), 300).await?);
    }
    let pay2_id: AccountId = format!("pay2{suffix}.{}", master.id()).parse()?;
    let contract = contract_acc.deploy(&wasm).await?.into_result().map_err(|e| anyhow!("deploy: {e:?}"))?;
    let mut ctx = Ctx { worker, master: master.clone(), contract, rando, wallets, pay1, pay2_id, pay2: None, suffix, report: vec![] };
    let r = ctx.contract.call("new").args_json(json!({ "owner": master.id(), "operator": master.id(), "verifier": master.id() })).transact().await?;
    ctx.record("init new", &r);
    ensure!(r.is_success(), "init failed: {:?}", r.into_result().err());

    for (i, (b, _, _)) in MEMBERS.iter().enumerate() {
        let w = ctx.wallets[i].id().clone();
        ctx.ok(&format!("register_buyer {b} (wallet {w})"), &master, "register_buyer", json!({ "buyer_id": b, "max_budget": (1000 * MILLI).to_string(), "wallet": w })).await?;
    }
    let offer = json!([{ "gpu_model": "A100", "vram_gb": 80, "capacity_hours": 100 }]);
    let (p1, p2) = (ctx.pay1.id().clone(), ctx.pay2_id.clone());
    ctx.ok("register_seller seller-01", &master, "register_seller", json!({ "seller_id": "seller-01", "payout_account_id": p1, "offers": offer })).await?;
    // seller-02's payout account does not exist yet: its first payout fails for real.
    ctx.ok("register_seller seller-02", &master, "register_seller", json!({ "seller_id": "seller-02", "payout_account_id": p2, "offers": offer })).await?;
    Ok(ctx)
}

/// A: one clearing price, excess to each wallet; payout to a missing account fails, retried once, never twice.
async fn scenario_fair_price_and_payout_retry(ctx: &mut Ctx) -> Result<()> {
    println!("\n== A: fair price for every member, excess back to wallets, payout failure + retry");
    let p = ctx.auction("a", 600, &[("seller-02", MILLI), ("seller-01", 3 * MILLI / 2)]).await?;
    ensure!(p["winner_seller_id"] == "seller-02");
    for i in 0..3 {
        ctx.withdraw(i).await?;
    }
    ctx.deliver("a").await?;
    let m = ctx.master.clone();
    let r = ctx.call("[a] verify(success) -> payout to missing account", &m, "verify", json!({ "purchase_id": "purchase-a", "success": true, "reason": "ok" }), 0, 150).await?;
    ensure!(r.is_success() && !r.receipt_failures().is_empty(), "transfer receipt should have failed");
    let p = ctx.purchase("purchase-a").await?;
    ensure!(p["state"] == "VERIFYING" && p["payout_in_flight"] == false, "after failed payout: {p}");
    let rnd = ctx.rando.clone();
    ctx.fails("[a] on_payout called directly (rejected: private)", &rnd, "on_payout", json!({ "purchase_id": "purchase-a" }), 0, "private").await?;
    let pay2 = sub(&ctx.master, &format!("pay2{}", ctx.suffix), 50).await?;
    let before = ctx.balance(pay2.id()).await?;
    ctx.ok("[a] payout retry (third party)", &rnd, "payout", json!({ "purchase_id": "purchase-a" })).await?;
    ensure!(ctx.balance(pay2.id()).await? - before == 30 * MILLI, "seller must receive exactly hours × clearing price");
    ctx.fails("[a] payout again (rejected)", &rnd, "payout", json!({ "purchase_id": "purchase-a" }), 0, "invalid state").await?;
    ctx.pay2 = Some(pay2);
    ctx.check_invariant().await
}

/// B: verify(fail) credits each member; a withdrawal to a deleted wallet fails for real, then succeeds once.
async fn scenario_refund_and_withdrawal_retry(ctx: &mut Ctx) -> Result<()> {
    println!("\n== B: failed delivery refunds each member; withdrawal failure + retry");
    ctx.auction("b", 600, &[("seller-01", MILLI)]).await?;
    for i in 0..3 {
        ctx.withdraw(i).await?; // the excess from this purchase
    }
    ctx.deliver("b").await?;
    let m = ctx.master.clone();
    ctx.ok("[b] verify(fail) -> each member's owed credited back", &m, "verify", json!({ "purchase_id": "purchase-b", "success": false, "reason": "partial delivery" })).await?;
    let p = ctx.purchase("purchase-b").await?;
    ensure!(p["state"] == "REFUNDED" && n(&p["held"]) == 0, "{p}");
    for (i, (b, h, _)) in MEMBERS.iter().enumerate() {
        ensure!(n(&ctx.buyer(b).await?["balance"]) == MILLI * *h as u128, "{b} credited its owed amount");
        let _ = i;
    }
    // buyer-003's wallet is deleted: the transfer genuinely fails and the balance stays credited.
    let w3_name = format!("w3{}", ctx.suffix);
    let r = ctx.wallets[2].clone().delete_account(ctx.master.id()).await?;
    ctx.record("[b] delete buyer-003's wallet (force withdrawal failure)", &r);
    let rnd = ctx.rando.clone();
    let r = ctx.call("[b] withdraw_balance buyer-003 -> deleted wallet", &rnd, "withdraw_balance", json!({ "buyer_id": "buyer-003" }), 0, 150).await?;
    ensure!(r.is_success() && !r.receipt_failures().is_empty(), "withdrawal transfer should have failed");
    ensure!(n(&ctx.buyer("buyer-003").await?["balance"]) == 10 * MILLI, "balance must stay credited after a failed withdrawal");
    ctx.wallets[2] = sub(&ctx.master, &w3_name, 100).await?;
    ctx.withdraw(2).await?;
    ctx.fails("[b] withdraw again (rejected)", &rnd, "withdraw_balance", json!({ "buyer_id": "buyer-003" }), 0, "no balance").await?;
    ctx.withdraw(0).await?;
    ctx.withdraw(1).await?;
    ctx.check_invariant().await
}

/// C: delivery deadline passes; a third party expires it and every member is refunded.
async fn scenario_expiry(ctx: &mut Ctx) -> Result<()> {
    println!("\n== C: delivery deadline expiry by a third party");
    ctx.auction("c", 25, &[("seller-01", MILLI)]).await?;
    let rnd = ctx.rando.clone();
    ctx.fails("[c] expire before deadline (rejected)", &rnd, "expire", json!({ "purchase_id": "purchase-c" }), 0, "not reached").await?;
    let p = ctx.purchase("purchase-c").await?;
    ctx.wait_past(&p["delivery_deadline"]).await?;
    ctx.ok("[c] expire (third party) -> refund to members", &rnd, "expire", json!({ "purchase_id": "purchase-c" })).await?;
    ensure!(ctx.purchase("purchase-c").await?["state"] == "REFUNDED");
    for i in 0..3 {
        ctx.withdraw(i).await?;
    }
    let cfg = ctx.view("get_config", json!({})).await?;
    ensure!(n(&cfg["total_escrowed"]) == 0 && n(&cfg["total_balances"]) == 0, "everything returned: {cfg}");
    ctx.check_invariant().await
}

async fn cleanup(ctx: &Ctx) {
    let master = ctx.master.id().clone();
    let mut accounts: Vec<Account> = ctx.wallets.clone();
    accounts.push(ctx.rando.clone());
    accounts.push(ctx.pay1.clone());
    if let Some(p) = &ctx.pay2 {
        accounts.push(p.clone());
    }
    for a in accounts {
        if let Err(e) = a.delete_account(&master).await {
            println!("cleanup: {e}");
        }
    }
    if let Err(e) = ctx.contract.as_account().clone().delete_account(&master).await {
        println!("cleanup contract: {e}");
    }
}

fn write_report(ctx: &Ctx, outcome: &Result<()>) {
    let mut s = format!(
        "# Marketplace testnet run (fair-price model)\n\nContract: `{}` (NEAR Testnet)\n\nResult: **{}**\n\n\"Clean\" = transaction and all receipts succeeded. Steps marked \"no\" contain a failing transaction or receipt; each one is asserted by the test (rejected calls, forced transfer failures).\n\n| Step | Transaction | Clean |\n|---|---|---|\n",
        ctx.contract.id(),
        match outcome { Ok(()) => "PASS".to_string(), Err(e) => format!("FAIL: {e}") }
    );
    for (label, hash, ok) in &ctx.report {
        s += &format!("| {label} | [{hash}](https://testnet.nearblocks.io/txns/{hash}) | {} |\n", if *ok { "yes" } else { "no" });
    }
    let _ = std::fs::create_dir_all("target");
    match std::fs::write("target/testnet-report.md", s) {
        Ok(()) => println!("\nreport: contracts/marketplace-testnet-tests/target/testnet-report.md"),
        Err(e) => println!("could not write report: {e}"),
    }
}

#[tokio::test]
#[ignore = "spends testnet NEAR and takes several minutes; run with -- --ignored"]
async fn marketplace_on_testnet() -> Result<()> {
    let mut ctx = setup().await?;
    let outcome = async {
        scenario_fair_price_and_payout_retry(&mut ctx).await?;
        scenario_refund_and_withdrawal_retry(&mut ctx).await?;
        scenario_expiry(&mut ctx).await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    write_report(&ctx, &outcome);
    cleanup(&ctx).await;
    if let Err(e) = outcome {
        bail!(e);
    }
    Ok(())
}
