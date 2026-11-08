/**
 * Auction engine: collective buying at one fair price.
 *
 *   1. coalition registered on-chain with each member's own max price
 *   2. purchase created; every member prepays hours × its OWN max price from its
 *      OWN wallet (PREPAYMENT). A member that can't afford it leaves first.
 *   3. bidding opens only when all members prepaid; sealed commits, then reveals
 *   4. close_auction: the lowest eligible bid is the clearing price for EVERY
 *      member; each owes hours × clearing price; prepaid − owed is credited back
 *      (FUNDING_CONFIRMATION to each member shows the arithmetic)
 *   5. credited balances are sent to each buyer's own wallet (BALANCE_RETURNED)
 *
 * Coalitions advance stage by stage so deadline waits overlap. Every money
 * decision is deterministic code checked again by the contract (RULES.md R5).
 * Deadlines are chain time.
 */
import { createMessage, SYSTEM_AGENTS, type AgentMessage, type PayloadOf } from "@swarmcompute/shared";
import type { Swarm } from "../agents/swarm.js";
import type { ContractPurchase, ContractWindows, MarketplaceContract } from "../chain/marketplace.js";
import type { TxResult } from "../chain/types.js";
import type { SealedBid } from "../crypto/bid-vault.js";
import { BalanceReturner, type BalanceStore } from "../settlement/balances.js";

export interface AuctionStore extends BalanceStore {
  purchaseCreated(r: PurchaseRun, p: ContractPurchase, tx: TxResult): Promise<void>;
  prepaid(purchaseId: string, buyerId: string, amount: bigint, tx: TxResult): Promise<void>;
  /** Bidding opened: the on-chain commit/reveal deadlines are now known. */
  auctionOpened(r: PurchaseRun, p: ContractPurchase): Promise<void>;
  bidCommitted(purchaseId: string, auctionId: string, sellerId: string, commitmentHex: string, sealed: SealedBid, tx: TxResult): Promise<void>;
  bidRevealed(auctionId: string, sellerId: string, price: bigint, nonceHex: string, tx: TxResult): Promise<void>;
  /** Auction closed: FUNDED at the clearing price (allocations written) or REFUNDED. */
  auctionClosed(r: PurchaseRun, p: ContractPurchase, tx: TxResult): Promise<void>;
}

export interface EngineOptions {
  swarm: Swarm;
  contract: MarketplaceContract;
  windows: ContractWindows;
  store?: AuctionStore;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Makes purchase/auction IDs unique across runs (auction IDs can never be reused on-chain). */
  runTag?: string;
}

export interface PurchaseRun {
  coalitionId: string;
  purchaseId: string;
  auctionId: string;
  state: ContractPurchase["state"] | "NOT_STARTED";
  commitDeadlineNs?: bigint;
  revealDeadlineNs?: bigint;
  committed: string[];
  revealed: string[];
  winnerSellerId?: string;
  clearingPricePerHour?: bigint;
  requiredTotal?: bigint;
  prepaidTotal: bigint;
  returnedToBuyers: bigint;
  leftBuyers: string[];
  txs: { label: string; txHash: string; ok: boolean }[];
  failureReason?: string;
}

const nsToDate = (ns: bigint) => new Date(Number(ns / 1_000_000n));

export class AuctionEngine {
  private readonly log: (l: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly balances: BalanceReturner;
  private seq = 0;

  constructor(private readonly o: EngineOptions) {
    this.log = o.log ?? (() => {});
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.balances = new BalanceReturner({ swarm: o.swarm, contract: o.contract, store: o.store, log: this.log, sleep: this.sleep });
  }

  private get swarm() {
    return this.o.swarm;
  }
  private get c() {
    return this.o.contract;
  }

  private track(run: PurchaseRun, label: string, tx: TxResult): TxResult {
    run.txs.push({ label, txHash: tx.txHash, ok: tx.ok });
    this.log(`  ${run.coalitionId} ${label.padEnd(30)} ${tx.txHash}`);
    return tx;
  }

  /** Register every buyer (budget + own wallet) and seller once; load on-chain budget usage. */
  async registerParticipants(): Promise<{ registered: number; skipped: number }> {
    let registered = 0;
    let skipped = 0;
    for (const b of this.swarm.buyers) {
      const onChain = await this.c.getBuyer(b.id);
      if (onChain) {
        b.syncFromChain(BigInt(onChain.reserved), BigInt(onChain.spent));
        skipped++;
      } else {
        const tx = await this.c.registerBuyer(b.id, b.profile.maxBudgetYocto, b.profile.wallet);
        this.log(`  register_buyer ${b.id} wallet ${b.profile.wallet} ${tx.txHash}`);
        registered++;
      }
    }
    for (const s of this.swarm.sellers) {
      if (await this.c.getSeller(s.id)) skipped++;
      else {
        const offers = s.profile.offers.map((o) => ({ gpu_model: o.gpuModel, vram_gb: o.vramGb, capacity_hours: o.capacityHours }));
        const tx = await this.c.registerSeller(s.id, s.profile.payoutAccount, offers);
        this.log(`  register_seller ${s.id} ${tx.txHash}`);
        registered++;
      }
    }
    return { registered, skipped };
  }

  async runAll(coalitionIds: readonly string[]): Promise<PurchaseRun[]> {
    const runs: PurchaseRun[] = [];
    // Everyone prepays first; bidding opens for all coalitions together so no
    // commit window runs out while other coalitions are still prepaying.
    for (const cid of coalitionIds) runs.push(await this.prepareWithPrepay(cid));
    for (const r of runs.filter((x) => x.state === "CREATED")) await this.openBidding(r);
    const live = () => runs.filter((r) => r.state === "BIDDING");
    for (const r of live()) await this.commitAll(r);
    await this.waitUntil(live().map((r) => r.commitDeadlineNs!));
    for (const r of live()) await this.revealAll(r);
    await this.waitUntil(live().map((r) => r.revealDeadlineNs!));
    for (const r of live()) await this.close(r);
    return runs;
  }

  /** Steps 1–2: register, create, every member prepays its own max. */
  private async prepareWithPrepay(coalitionId: string): Promise<PurchaseRun> {
    const ca = this.swarm.coalitionAgent;
    const tracked = ca.coalitions.get(coalitionId);
    if (!tracked || tracked.status !== "ACTIVE") throw new Error(`coalition ${coalitionId} is not ACTIVE`);
    const suffix = coalitionId.slice("coalition-".length);
    const n = `${this.o.runTag ? `${this.o.runTag}-` : ""}${this.seq++}`;
    const run: PurchaseRun = {
      coalitionId,
      purchaseId: `purchase-${suffix}-${n}`,
      auctionId: `auction-${suffix}-${n}`,
      state: "NOT_STARTED",
      committed: [],
      revealed: [],
      prepaidTotal: 0n,
      returnedToBuyers: 0n,
      leftBuyers: [],
      txs: [],
    };
    const accepted = () => tracked.plan.members.filter((m) => tracked.members.get(m.buyerId) === "ACCEPTED");
    if (!(await this.c.getCoalition(coalitionId))) {
      this.track(
        run,
        "register_coalition",
        await this.c.registerCoalition({
          coalitionId,
          gpuModel: tracked.plan.gpuModel,
          vramGb: tracked.plan.vramGb,
          minMembers: tracked.plan.minMembers,
          members: accepted().map((m) => ({ buyer_id: m.buyerId, hours: m.hours, max_price_per_hour: m.maxPricePerHourYocto })),
        }),
      );
    }
    const created = this.track(run, "create_purchase", await this.c.createPurchase(run.purchaseId, run.auctionId, coalitionId, this.o.windows));
    let p = await this.mustPurchase(run.purchaseId);
    await this.o.store?.purchaseCreated(run, p, created);

    // Each member prepays its own max from its own wallet (or leaves if it can't).
    for (const m of accepted()) {
      const buyer = this.swarm.buyer(m.buyerId);
      const d = buyer.decidePrepay(m.hours);
      if (!d.prepay) {
        this.track(run, `leave_coalition ${m.buyerId}`, await this.c.leaveCoalition(coalitionId, m.buyerId, run.purchaseId));
        run.leftBuyers.push(m.buyerId);
        buyer.markLeft(coalitionId);
        await ca.removeMember(coalitionId, m.buyerId);
        continue;
      }
      const tx = this.track(run, `prepay ${m.buyerId}`, await this.c.prepay(buyer.profile.wallet, run.purchaseId, m.buyerId, d.amount));
      run.prepaidTotal += d.amount;
      await this.o.store?.prepaid(run.purchaseId, m.buyerId, d.amount, tx);
      await this.send(buyer.prepaid(coalitionId, run.purchaseId, m.hours, tx.txHash));
    }
    p = await this.mustPurchase(run.purchaseId);
    run.state = p.state;
    if (p.state !== "CREATED" || tracked.status !== "ACTIVE") {
      run.failureReason = "coalition fell below min_members before bidding";
      if (run.leftBuyers.length) run.returnedToBuyers += await this.returnBalances(p);
    }
    return run;
  }

  /** Step 3a: open bidding (all members prepaid) and send AUCTION_REQUEST with on-chain deadlines. */
  private async openBidding(run: PurchaseRun): Promise<void> {
    const coalitionId = run.coalitionId;
    const ca = this.swarm.coalitionAgent;
    this.track(run, "open_bidding", await this.c.openBidding(run.purchaseId));
    const p = await this.mustPurchase(run.purchaseId);
    run.state = p.state;
    run.commitDeadlineNs = BigInt(p.commit_deadline!);
    run.revealDeadlineNs = BigInt(p.reveal_deadline!);
    await this.o.store?.auctionOpened(run, p);
    await ca.requestAuction(
      this.swarm.bus,
      coalitionId,
      { auctionId: run.auctionId, purchaseId: run.purchaseId, commitDeadline: nsToDate(run.commitDeadlineNs), revealDeadline: nsToDate(run.revealDeadlineNs) },
      this.swarm.sellers.map((s) => s.id),
    );
    await this.swarm.bus.drain();
  }

  private async commitAll(run: PurchaseRun): Promise<void> {
    for (const s of this.swarm.sellers) {
      const bid = s.pendingBid(run.auctionId);
      if (!bid) {
        const why = s.declined.get(run.auctionId);
        if (why) this.log(`  ${run.coalitionId} ${s.id} declines (${why})`);
        continue;
      }
      const tx = this.track(run, `commit_bid ${s.id}`, await this.c.commitBid(run.purchaseId, s.id, bid.commitmentHex));
      run.committed.push(s.id);
      await this.o.store?.bidCommitted(run.purchaseId, run.auctionId, s.id, bid.commitmentHex, bid.sealed, tx);
      await this.send(s.commitmentMessage(run.auctionId, tx.txHash));
    }
  }

  private async revealAll(run: PurchaseRun): Promise<void> {
    for (const id of run.committed) {
      const s = this.swarm.seller(id);
      const { pricePerHourYocto, nonceHex } = s.revealSecret(run.auctionId);
      const tx = this.track(run, `reveal_bid ${id}`, await this.c.revealBid(run.purchaseId, id, pricePerHourYocto, nonceHex));
      run.revealed.push(id);
      await this.o.store?.bidRevealed(run.auctionId, id, pricePerHourYocto, nonceHex, tx);
      await this.send(s.revealMessage(run.auctionId, tx.txHash));
    }
  }

  /** Steps 4–5: one clearing price for everyone, then excess back to each wallet. */
  private async close(run: PurchaseRun): Promise<void> {
    const tx = this.track(run, "close_auction", await this.c.closeAuction(run.purchaseId));
    const p = await this.mustPurchase(run.purchaseId);
    run.state = p.state;
    const excluded = p.bids
      .filter((b) => b.eligible === false && b.ineligibility_reason)
      .map((b) => ({ seller_id: b.seller_id, reason_code: b.ineligibility_reason as PayloadOf<"AUCTION_RESULT">["excluded"][number]["reason_code"] }));
    const base = { auction_id: run.auctionId, purchase_id: run.purchaseId, coalition_id: run.coalitionId, excluded, tx_hash: tx.txHash };
    const funded = p.state === "FUNDED";
    let payload: PayloadOf<"AUCTION_RESULT">;
    if (funded) {
      run.winnerSellerId = p.winner_seller_id!;
      run.clearingPricePerHour = BigInt(p.clearing_price_per_hour!);
      run.requiredTotal = BigInt(p.required_total!);
      payload = {
        ...base,
        outcome: "AWARDED",
        winner_seller_id: run.winnerSellerId,
        winning_price_per_hour_yocto: run.clearingPricePerHour.toString(),
        total_price_yocto: run.requiredTotal.toString(),
      };
    } else {
      run.failureReason = "no eligible bid; every prepayment credited back";
      payload = { ...base, outcome: "FAILED" };
    }
    await this.o.store?.auctionClosed(run, p, tx);
    const coord = this.swarm.systemKey(SYSTEM_AGENTS.AUCTION_COORDINATOR);
    const treasury = this.swarm.systemKey(SYSTEM_AGENTS.TREASURY);
    const now = () => this.swarm.clock().toISOString();
    for (const a of p.allocations) {
      await this.send(createMessage({ type: "AUCTION_RESULT", sender_id: SYSTEM_AGENTS.AUCTION_COORDINATOR, receiver_id: a.buyer_id, payload, timestamp: now() }, coord));
      if (funded) {
        await this.send(
          createMessage(
            {
              type: "FUNDING_CONFIRMATION",
              sender_id: SYSTEM_AGENTS.TREASURY,
              receiver_id: a.buyer_id,
              timestamp: now(),
              payload: {
                purchase_id: run.purchaseId,
                buyer_id: a.buyer_id,
                clearing_price_per_hour_yocto: p.clearing_price_per_hour!,
                hours: a.hours,
                prepaid_yocto: a.prepaid,
                owed_yocto: a.owed,
                excess_yocto: a.excess,
                tx_hash: tx.txHash,
              },
            },
            treasury,
          ),
        );
      }
    }
    if (funded) {
      await this.swarm.coalitionAgent.markFunded(run.coalitionId);
    } else {
      const lines = p.allocations.map((a) => ({ buyer_id: a.buyer_id, amount_yocto: a.refunded }));
      const total = lines.reduce((s, l) => s + BigInt(l.amount_yocto), 0n);
      if (total > 0n) {
        for (const a of p.allocations) {
          await this.send(
            createMessage(
              {
                type: "REFUND_CONFIRMATION",
                sender_id: SYSTEM_AGENTS.TREASURY,
                receiver_id: a.buyer_id,
                timestamp: now(),
                payload: { purchase_id: run.purchaseId, total_refund_yocto: total.toString(), per_buyer: lines, tx_hash: tx.txHash },
              },
              treasury,
            ),
          );
        }
      }
      await this.swarm.coalitionAgent.markFailed(run.coalitionId, run.failureReason!);
    }
    run.returnedToBuyers += await this.returnBalances(p);
  }

  private async returnBalances(p: ContractPurchase): Promise<bigint> {
    const ids = new Set([...p.allocations.map((a) => a.buyer_id), ...(this.swarm.coalitionAgent.coalitions.get(p.coalition_id)?.members.keys() ?? [])]);
    const sent = await this.balances.returnTo(ids);
    return sent.reduce((s, r) => s + r.amount, 0n);
  }

  private async send(m: AgentMessage): Promise<void> {
    const r = await this.swarm.bus.send(m);
    if (!r.ok) throw new Error(`message ${m.type} rejected: ${r.code} ${r.detail}`);
    await this.swarm.bus.drain();
  }

  private async mustPurchase(id: string): Promise<ContractPurchase> {
    const p = await this.c.getPurchase(id);
    if (!p) throw new Error(`purchase ${id} not found on-chain`);
    return p;
  }

  private async waitUntil(deadlinesNs: bigint[]): Promise<void> {
    if (deadlinesNs.length === 0) return;
    const target = deadlinesNs.reduce((a, b) => (a > b ? a : b));
    for (;;) {
      const t = await this.c.blockTimestampNs();
      if (t > target) return;
      const waitMs = Number((target - t) / 1_000_000n);
      this.log(`  waiting ${Math.ceil(waitMs / 1000)}s for chain deadline`);
      await this.sleep(Math.min(Math.max(waitMs, 0) + 500, this.o.pollMs ?? 5000));
    }
  }
}
