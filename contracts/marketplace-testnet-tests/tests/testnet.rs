//! Real-chain tests on NEAR Testnet for real users' agents (RULES.md R1: testnet only).
//!
//! Covers what the mocked unit tests cannot:
//! - `open_*_agent` really creates `<name>.<contract>`, funded, with exactly one
//!   function-call key limited to the marketplace's agent methods (R19);
//! - that key can't transfer NEAR or call an owner-only method;
//! - every buyer agent prepays and every seller agent bids with its OWN key (R8);
//! - the clearing price for every member, the payout to the winning seller's
//!   owner, and withdrawals to each buyer's owner (R11);
//! - a failed delivery refunding every member, and expiry by a third party
//!   on real block time.
//!
//! Every transaction hash goes to `target/testnet-report.md`.
//!
//! Run (ignored by default: spends testnet NEAR, takes several minutes):
//!   cd contracts/marketplace && cargo near build non-reproducible-wasm --no-abi
//!   cd ../marketplace-testnet-tests && cargo test -- --ignored --nocapture
//!
//! Account: NEAR_TEST_ACCOUNT_ID + NEAR_TEST_PRIVATE_KEY (~8 NEAR), else a dev
//! account from the testnet helper. Optional NEAR_TESTNET_RPC_URL.

use anyhow::{anyhow, bail, ensure, Context, Result};
use near_workspaces::network::Testnet;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::str::FromStr;
use std::time::Duration;

const MILLI: u128 = 1_000_000_000_000_000_000_000; // 0.001 NEAR
const OPEN_FEE: u128 = MILLI / 10; // 0.0001 NEAR: the contract sponsors the rest
const AGENT_GAS_FUND: u128 = 100 * MILLI;
/// Agents attach 30 Tgas: prepaid gas is charged upfront, and an agent holds only its gas fund.
const AGENT_TGAS: u64 = 30;
const BUDGET: u128 = 100 * MILLI;
const WASM: &str = "../marketplace/target/near/marketplace.wasm";
/// (agent name, hours, own max price per hour in milliNEAR)
const BUYERS: [(&str, u32, u128); 3] = [("alice-gpu", 10, 3), ("bob-gpu", 10, 2), ("carol-gpu", 10, 2)];
const SELLERS: [&str; 2] = ["dave-farm", "erin-farm"];

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
    /// Buyer owners' wallets and their agents (signing with the agent's own key).
    buyer_owners: Vec<Account>,
    buyers: Vec<Account>,
    seller_owners: Vec<Account>,
    sellers: Vec<Account>,
    suffix: String,
    report: Vec<(String, String, bool)>,
}

impl Ctx {
    fn record(&mut self, label: &str, r: &ExecutionFinalResult) {
        let hash = r.outcome().transaction_hash.to_string();
        let ok = r.is_success() && r.receipt_failures().is_empty();
        println!("  {:<64} {} {}", label, hash, if ok { "" } else { "(has failures)" });
        self.report.push((label.to_string(), hash, ok));
    }

    async fn call(&mut self, label: &str, who: &Account, method: &str, args: Value, deposit: u128, tgas: u64) -> Result<ExecutionFinalResult> {
        let is_agent = who.id().as_str().ends_with(&format!(".{}", self.contract.id()));
        let tgas = if is_agent { AGENT_TGAS } else { tgas };
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

    async fn ok_with(&mut self, label: &str, who: &Account, method: &str, args: Value, deposit: u128) -> Result<()> {
        let who = who.clone();
        let r = self.call(label, &who, method, args, deposit, 150).await?;
        ensure!(r.is_success() && r.receipt_failures().is_empty(), "{label} failed: {:?}", r.into_result().err());
        Ok(())
    }

    async fn ok(&mut self, label: &str, who: &Account, method: &str, args: Value) -> Result<()> {
        self.ok_with(label, who, method, args, 0).await
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

    async fn buyer(&self, i: usize) -> Result<Value> {
        self.view("get_buyer", json!({ "buyer_id": self.buyers[i].id() })).await
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

    /// The buyer AGENT withdraws its whole available balance; its OWNER must receive exactly that.
    async fn withdraw(&mut self, i: usize) -> Result<u128> {
        let amount = n(&self.buyer(i).await?["available"]);
        let owner = self.buyer_owners[i].id().clone();
        let before = self.balance(&owner).await?;
        let agent = self.buyers[i].clone();
        let id = agent.id().clone();
        self.ok(&format!("withdraw {id} (signed by the agent) -> owner"), &agent, "withdraw", json!({ "buyer_id": id })).await?;
        let after = self.balance(&owner).await?;
        ensure!(after - before == amount, "{owner} should receive exactly {amount}, got {}", after - before);
        ensure!(n(&self.buyer(i).await?["available"]) == 0);
        Ok(amount)
    }

    /// Open an agent from `owner`'s wallet with a freshly generated key; return the agent
    /// as an `Account` that signs with that key, after checking its account and key on chain.
    async fn open_agent(&mut self, label: &str, owner: &Account, name: &str, method: &str, mut args: Value, deposit: u128) -> Result<Account> {
        let sk = SecretKey::from_random(KeyType::ED25519);
        args["name"] = json!(name);
        args["public_key"] = json!(sk.public_key().to_string());
        self.ok_with(label, owner, method, args, deposit).await?;
        let id: AccountId = format!("{name}.{}", self.contract.id()).parse()?;

        // The account exists, holds the gas fund, and has ONE key: function-call only, on this contract.
        let acct = self.worker.view_account(&id).await.with_context(|| format!("{id} was not created"))?;
        ensure!(acct.balance.as_yoctonear() == AGENT_GAS_FUND, "{id} should hold the gas fund, has {}", acct.balance.as_yoctonear());
        let keys = self.worker.view_access_keys(&id).await?;
        ensure!(keys.len() == 1, "{id} should have exactly one key, has {}", keys.len());
        let perm = format!("{:?}", keys[0].access_key.permission);
        ensure!(perm.contains("FunctionCall") && !perm.contains("FullAccess"), "{id} key must be function-call only: {perm}");
        ensure!(perm.contains(self.contract.id().as_str()), "{id} key must be limited to the marketplace: {perm}");
        for m in ["prepay", "commit_bid", "reveal_bid", "withdraw", "leave_coalition"] {
            ensure!(perm.contains(m), "{id} key must allow {m}: {perm}");
        }
        ensure!(keys[0].public_key.to_string() == sk.public_key().to_string(), "{id} key must be the one we generated");
        Ok(Account::from_secret_key(id, sk, &self.worker))
    }

    /// Coalition from the three buyer agents' own requests; each AGENT prepays; each
    /// seller AGENT commits and reveals; third-party close. Returns the purchase after close.
    async fn auction(&mut self, tag: &str, delivery_secs: u32, bids: &[(usize, u128)]) -> Result<Value> {
        let (cid, pid, aid) = (format!("coal-{tag}"), format!("purchase-{tag}"), format!("auction-{tag}-{}", self.suffix));
        let m = self.master.clone();
        let ids: Vec<String> = self.buyers.iter().map(|b| b.id().to_string()).collect();
        self.ok(&format!("[{tag}] register_coalition (terms from agents' own requests)"), &m, "register_coalition", json!({ "coalition_id": cid, "buyer_ids": ids, "min_members": 2 })).await?;
        let windows = json!({ "prepay_secs": 600, "commit_secs": 45, "reveal_secs": 60, "delivery_secs": delivery_secs, "verification_secs": 600 });
        self.ok(&format!("[{tag}] create_purchase"), &m, "create_purchase", json!({ "purchase_id": pid, "auction_id": aid, "coalition_id": cid, "windows": windows })).await?;

        // Not the operator, not the owner: only the agent's own account prepays.
        let (o0, b0) = (self.buyer_owners[0].clone(), self.buyers[0].id().clone());
        self.fails(&format!("[{tag}] prepay {b0} by the operator (rejected)"), &m, "prepay", json!({ "purchase_id": pid, "buyer_id": b0 }), 0, "own account").await?;
        self.fails(&format!("[{tag}] prepay {b0} by its owner (rejected)"), &o0, "prepay", json!({ "purchase_id": pid, "buyer_id": b0 }), 0, "own account").await?;
        for i in 0..self.buyers.len() {
            let agent = self.buyers[i].clone();
            let id = agent.id().clone();
            self.ok(&format!("[{tag}] prepay {id} (signed by the agent)"), &agent, "prepay", json!({ "purchase_id": pid, "buyer_id": id })).await?;
        }
        self.ok(&format!("[{tag}] open_bidding"), &m, "open_bidding", json!({ "purchase_id": pid })).await?;

        let s0 = self.sellers[bids[0].0].id().clone();
        let c = commitment(&aid, s0.as_str(), bids[0].1, &[1; 32]);
        self.fails(&format!("[{tag}] commit for {s0} by the operator (rejected)"), &m, "commit_bid", json!({ "purchase_id": pid, "seller_id": s0, "commitment_hex": c }), 0, "own account").await?;
        for (k, (si, price)) in bids.iter().enumerate() {
            let agent = self.sellers[*si].clone();
            let id = agent.id().clone();
            let c = commitment(&aid, id.as_str(), *price, &[k as u8 + 1; 32]);
            self.ok(&format!("[{tag}] commit_bid {id} (signed by the agent)"), &agent, "commit_bid", json!({ "purchase_id": pid, "seller_id": id, "commitment_hex": c })).await?;
        }
        let p = self.purchase(&pid).await?;
        self.wait_past(&p["commit_deadline"]).await?;
        let a0 = self.sellers[bids[0].0].clone();
        self.fails(&format!("[{tag}] reveal {s0} wrong price (rejected)"), &a0, "reveal_bid", json!({ "purchase_id": pid, "seller_id": s0, "price_per_hour": (bids[0].1 + 1).to_string(), "nonce_hex": hex(&[1; 32]) }), 0, "commitment mismatch").await?;
        for (k, (si, price)) in bids.iter().enumerate() {
            let agent = self.sellers[*si].clone();
            let id = agent.id().clone();
            self.ok(&format!("[{tag}] reveal_bid {id} (signed by the agent)"), &agent, "reveal_bid", json!({ "purchase_id": pid, "seller_id": id, "price_per_hour": price.to_string(), "nonce_hex": hex(&[k as u8 + 1; 32]) })).await?;
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
        self.ok(&format!("[{tag}] start_delivery (simulated)"), &m, "start_delivery", json!({ "purchase_id": pid })).await?;
        self.ok(&format!("[{tag}] submit_delivery_report (simulated)"), &m, "submit_delivery_report", json!({ "purchase_id": pid, "report_hash_hex": hex(&[7; 32]) })).await
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
    ensure!(bal.as_near() >= 7, "master account needs at least ~7 NEAR");

    // Short: agent ids are `<name>.<contract>` and NEAR account ids are at most 64 chars.
    let suffix = format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?.as_secs() % 10_000_000);
    let contract_acc = sub(&master, &format!("m{suffix}"), 4500).await?;
    let rando = sub(&master, &format!("rnd{suffix}"), 200).await?;
    let mut buyer_owners = vec![];
    for (name, ..) in BUYERS {
        buyer_owners.push(sub(&master, &format!("{}{suffix}", name.split('-').next().unwrap()), 400).await?);
    }
    let mut seller_owners = vec![];
    for name in SELLERS {
        seller_owners.push(sub(&master, &format!("{}{suffix}", name.split('-').next().unwrap()), 400).await?);
    }
    let contract = contract_acc.deploy(&wasm).await?.into_result().map_err(|e| anyhow!("deploy: {e:?}"))?;
    let mut ctx = Ctx { worker, master: master.clone(), contract, rando, buyer_owners, buyers: vec![], seller_owners, sellers: vec![], suffix, report: vec![] };
    let r = ctx.contract.call("new").args_json(json!({ "owner": master.id(), "operator": master.id(), "verifier": master.id() })).transact().await?;
    ctx.record("init new", &r);
    ensure!(r.is_success(), "init failed: {:?}", r.into_result().err());

    // Real users open their own agents from their own wallets.
    let deadline = (ctx.worker.view_block().await?.timestamp() + 24 * 3600 * 1_000_000_000).to_string();
    for (i, (name, hours, max)) in BUYERS.iter().enumerate() {
        let owner = ctx.buyer_owners[i].clone();
        let req = json!({ "gpu_model": "A100", "vram_gb": 80, "hours": hours, "max_price_per_hour": (max * MILLI).to_string(), "deadline": deadline });
        let agent = ctx.open_agent(&format!("open_buyer_agent {name} (owner {})", owner.id()), &owner, name, "open_buyer_agent", json!({ "request": req }), OPEN_FEE + BUDGET).await?;
        let b = ctx.view("get_buyer", json!({ "buyer_id": agent.id() })).await?;
        ensure!(b["opened"] == true && n(&b["available"]) == BUDGET && b["owner"] == owner.id().as_str(), "buyer agent state: {b}");
        ctx.buyers.push(agent);
    }
    let offers = json!([{ "gpu_model": "A100", "vram_gb": 80, "capacity_hours": 100 }]);
    for (i, name) in SELLERS.iter().enumerate() {
        let owner = ctx.seller_owners[i].clone();
        let args = json!({ "offers": offers, "min_price_per_hour": MILLI.to_string(), "strategy": { "kind": "AT_MINIMUM" } });
        let agent = ctx.open_agent(&format!("open_seller_agent {name} (owner {})", owner.id()), &owner, name, "open_seller_agent", args, OPEN_FEE).await?;
        ctx.sellers.push(agent);
    }
    let cfg = ctx.view("get_config", json!({})).await?;
    ensure!(cfg["buyer_count"] == 3 && cfg["seller_count"] == 2, "{cfg}");
    ctx.check_invariant().await?;
    Ok(ctx)
}

/// The agent's key is limited: it can't move NEAR, and it can't call an owner-only method.
async fn scenario_agent_key_is_limited(ctx: &mut Ctx) -> Result<()> {
    println!("\n== 0: an agent's key is a function-call key, limited to the marketplace");
    let agent = ctx.buyers[0].clone();
    let owner = ctx.buyer_owners[0].id().clone();
    let r = agent.transfer_near(&owner, NearToken::from_millinear(1)).await;
    let err = match r {
        Ok(out) => {
            ensure!(!out.is_success(), "an agent key must not be able to transfer NEAR");
            format!("{:?}", out.into_result().err())
        }
        Err(e) => format!("{e:?}"),
    };
    println!("  transfer from agent rejected: {}", err.chars().take(120).collect::<String>());
    ensure!(err.contains("FullAccess") || err.contains("Transfer") || err.contains("InvalidAccessKey"), "unexpected transfer error: {err}");

    let r = agent.call(ctx.contract.id(), "set_request").args_json(json!({ "buyer_id": agent.id(), "request": null })).transact().await;
    let err = match r {
        Ok(out) => {
            ensure!(!out.is_success(), "an agent key must not be able to call set_request");
            format!("{:?}", out.into_result().err())
        }
        Err(e) => format!("{e:?}"),
    };
    println!("  set_request from agent rejected: {}", err.chars().take(120).collect::<String>());
    ensure!(err.contains("MethodName") || err.contains("InvalidAccessKey"), "unexpected set_request error: {err}");
    Ok(())
}

/// A: one clearing price for every member, excess back to available, withdrawals to owners,
/// the payout to the winning seller's owner.
async fn scenario_fair_price_and_payout(ctx: &mut Ctx) -> Result<()> {
    println!("\n== A: fair price for every member; payout to the seller's owner; withdrawals to owners");
    let p = ctx.auction("a", 600, &[(1, MILLI), (0, 3 * MILLI / 2)]).await?;
    ensure!(p["winner_seller_id"] == ctx.sellers[1].id().as_str());
    ctx.deliver("a").await?;
    let m = ctx.master.clone();
    let seller_owner = ctx.seller_owners[1].id().clone();
    let before = ctx.balance(&seller_owner).await?;
    ctx.ok("[a] verify(success) -> payout to the winning seller's owner", &m, "verify", json!({ "purchase_id": "purchase-a", "success": true, "reason": "ok" })).await?;
    ensure!(ctx.balance(&seller_owner).await? - before == 30 * MILLI, "the seller's owner must receive exactly hours × clearing price");
    let p = ctx.purchase("purchase-a").await?;
    ensure!(p["state"] == "COMPLETED", "{p}");
    let rnd = ctx.rando.clone();
    ctx.fails("[a] payout again (rejected)", &rnd, "payout", json!({ "purchase_id": "purchase-a" }), 0, "invalid state").await?;
    ctx.fails("[a] on_payout called directly (rejected: private)", &rnd, "on_payout", json!({ "purchase_id": "purchase-a" }), 0, "private").await?;
    for i in 0..3 {
        let b = ctx.buyer(i).await?;
        ensure!(b["request"].is_null() && b["coalition_id"].is_null(), "request fulfilled: {b}");
        ensure!(n(&b["spent"]) == 10 * MILLI, "spent hours × clearing price: {b}");
    }
    let s = ctx.view("get_seller", json!({ "seller_id": ctx.sellers[1].id() })).await?;
    ensure!(s["reputation"]["completed_deliveries"] == 1, "{s}");
    ctx.check_invariant().await
}

/// B: a failed delivery refunds every member; the request stays open and can be grouped again.
async fn scenario_refund(ctx: &mut Ctx) -> Result<()> {
    println!("\n== B: failed delivery refunds each member");
    let deadline = (ctx.worker.view_block().await?.timestamp() + 24 * 3600 * 1_000_000_000).to_string();
    for (i, (name, hours, max)) in BUYERS.iter().enumerate() {
        let owner = ctx.buyer_owners[i].clone();
        let req = json!({ "gpu_model": "A100", "vram_gb": 80, "hours": hours, "max_price_per_hour": (max * MILLI).to_string(), "deadline": deadline });
        let id = ctx.buyers[i].id().clone();
        ctx.ok(&format!("[b] set_request {name} (owner)"), &owner, "set_request", json!({ "buyer_id": id, "request": req })).await?;
    }
    let before: Vec<u128> = {
        let mut v = vec![];
        for i in 0..3 {
            v.push(n(&ctx.buyer(i).await?["available"]));
        }
        v
    };
    ctx.auction("b", 600, &[(0, MILLI)]).await?;
    ctx.deliver("b").await?;
    let m = ctx.master.clone();
    ctx.ok("[b] verify(fail) -> each member's owed credited back", &m, "verify", json!({ "purchase_id": "purchase-b", "success": false, "reason": "partial delivery" })).await?;
    let p = ctx.purchase("purchase-b").await?;
    ensure!(p["state"] == "REFUNDED" && n(&p["held"]) == 0, "{p}");
    for (i, b0) in before.iter().enumerate() {
        let b = ctx.buyer(i).await?;
        ensure!(n(&b["available"]) == *b0 && !b["request"].is_null(), "member {i} fully refunded, request still open: {b}");
    }
    ctx.check_invariant().await
}

/// C: delivery deadline passes; a third party expires it; then every agent withdraws to its owner.
async fn scenario_expiry_and_withdrawals(ctx: &mut Ctx) -> Result<()> {
    println!("\n== C: delivery deadline expiry by a third party, then withdrawals to owners");
    ctx.auction("c", 25, &[(0, MILLI)]).await?;
    let rnd = ctx.rando.clone();
    ctx.fails("[c] expire before deadline (rejected)", &rnd, "expire", json!({ "purchase_id": "purchase-c" }), 0, "not reached").await?;
    let p = ctx.purchase("purchase-c").await?;
    ctx.wait_past(&p["delivery_deadline"]).await?;
    ctx.ok("[c] expire (third party) -> refund to members", &rnd, "expire", json!({ "purchase_id": "purchase-c" })).await?;
    ensure!(ctx.purchase("purchase-c").await?["state"] == "REFUNDED");
    let (o0, b0) = (ctx.buyer_owners[1].clone(), ctx.buyers[0].id().clone());
    ctx.fails("[c] withdraw alice's agent by bob (rejected)", &o0, "withdraw", json!({ "buyer_id": b0 }), 0, "only the agent or its owner").await?;
    for i in 0..3 {
        let got = ctx.withdraw(i).await?;
        ensure!(got == BUDGET - 10 * MILLI, "agent {i}: budget minus the completed purchase, got {got}");
    }
    let cfg = ctx.view("get_config", json!({})).await?;
    ensure!(n(&cfg["total_escrowed"]) == 0 && n(&cfg["total_balances"]) == 0, "everything returned: {cfg}");
    ctx.check_invariant().await
}

async fn cleanup(ctx: &Ctx) {
    let master = ctx.master.id().clone();
    let mut accounts: Vec<Account> = ctx.buyer_owners.clone();
    accounts.extend(ctx.seller_owners.iter().cloned());
    accounts.push(ctx.rando.clone());
    for a in accounts {
        if let Err(e) = a.delete_account(&master).await {
            println!("cleanup: {e}");
        }
    }
    // Agent accounts have only function-call keys, so they can't be deleted (by design).
    if let Err(e) = ctx.contract.as_account().clone().delete_account(&master).await {
        println!("cleanup contract: {e}");
    }
}

fn write_report(ctx: &Ctx, outcome: &Result<()>) {
    let mut s = format!(
        "# Marketplace testnet run (real user agents)\n\nContract: `{}` (NEAR Testnet)\n\nResult: **{}**\n\n\"Clean\" = transaction and all receipts succeeded. Steps marked \"no\" contain a failing transaction or receipt; each one is asserted by the test (rejected calls).\n\n| Step | Transaction | Clean |\n|---|---|---|\n",
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
        scenario_agent_key_is_limited(&mut ctx).await?;
        scenario_fair_price_and_payout(&mut ctx).await?;
        scenario_refund(&mut ctx).await?;
        scenario_expiry_and_withdrawals(&mut ctx).await?;
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
