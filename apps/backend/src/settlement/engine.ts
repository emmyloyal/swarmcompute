/**
 * Settlement engine: simulated delivery → delivery report on-chain → simulated
 * verification (verifier key) → payout to the awarded seller, or every member's
 * money credited back and sent to each buyer's own wallet.
 *
 * - Payment is never released except by `verify(success)` on-chain (RULES.md R4).
 * - Outcomes are read from the contract's own events, never assumed (RULES.md R2).
 * - A failed payout transfer is retried; the contract's in-flight flag makes a
 *   double payout impossible (RULES.md R10). Withdrawals are guarded the same way.
 * - A purchase past its delivery/verification deadline is expired (anyone may)
 *   and its members are refunded.
 */
import { createMessage, SYSTEM_AGENTS, type AgentMessage } from "@swarmcompute/shared";
import type { Swarm } from "../agents/swarm.js";
import { decideVerification, type VerificationDecision } from "../agents/verification-agent.js";
import type { ContractPurchase, MarketplaceContract } from "../chain/marketplace.js";
import type { ContractEvent, TxResult } from "../chain/types.js";
import { simulateDelivery, type DeliveryOutcome, type SimulatedDelivery } from "../sim/gpu.js";
import { BalanceReturner, type BalanceStore } from "./balances.js";

export interface SettlementStore extends BalanceStore {
  delivered(d: SimulatedDelivery, reportTx: TxResult): Promise<void>;
  verified(purchaseId: string, d: VerificationDecision, verifierAccount: string, tx: TxResult): Promise<void>;
  payoutAttempt(purchaseId: string, sellerId: string, payoutAccount: string, amount: bigint, ok: boolean, tx: TxResult): Promise<void>;
  /** Members' money credited back on-chain (per-buyer lines). */
  refunded(purchaseId: string, amount: bigint, reason: string, lines: { buyer_id: string; amount: string }[], tx: TxResult): Promise<void>;
  synced(p: ContractPurchase): Promise<void>;
}

export interface SettlementOptions {
  swarm: Swarm;
  contract: MarketplaceContract;
  seed: string;
  verifierAccountId: string;
  store?: SettlementStore;
  log?: (line: string) => void;
  /** Demo: force delivery outcomes per purchase (e.g. to show the refund path). */
  force?: Record<string, DeliveryOutcome>;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SettlementRun {
  purchaseId: string;
  coalitionId: string;
  path: "DELIVERED" | "EXPIRED" | "RETRY_ONLY";
  delivery?: SimulatedDelivery;
  decision?: VerificationDecision;
  finalState: ContractPurchase["state"];
  paidOut?: bigint;
  refunded?: bigint;
  returnedToBuyers: bigint;
  retries: number;
  txs: { label: string; txHash: string; ok: boolean }[];
}

const has = (tx: TxResult, event: string) => tx.events.find((e) => e.event === event);
const data = (e: ContractEvent | undefined) => (e?.data[0] ?? {}) as Record<string, unknown>;

export class SettlementEngine {
  private readonly log: (l: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly balances: BalanceReturner;

  constructor(private readonly o: SettlementOptions) {
    this.log = o.log ?? (() => {});
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.balances = new BalanceReturner({ swarm: o.swarm, contract: o.contract, store: o.store, log: this.log, sleep: this.sleep, maxRetries: o.maxRetries });
  }

  private get c() {
    return this.o.contract;
  }

  private track(run: SettlementRun, label: string, tx: TxResult): TxResult {
    run.txs.push({ label, txHash: tx.txHash, ok: tx.ok });
    this.log(`  ${run.purchaseId} ${label.padEnd(30)} ${tx.txHash}${tx.ok ? "" : "  (transfer receipt failed)"}`);
    return tx;
  }

  async settleAll(purchaseIds: readonly string[]): Promise<SettlementRun[]> {
    const out: SettlementRun[] = [];
    for (const id of purchaseIds) out.push(await this.settle(id));
    return out;
  }

  async settle(purchaseId: string): Promise<SettlementRun> {
    let p = await this.mustPurchase(purchaseId);
    const run: SettlementRun = { purchaseId, coalitionId: p.coalition_id, path: "RETRY_ONLY", finalState: p.state, returnedToBuyers: 0n, retries: 0, txs: [] };
    if (p.state === "CREATED" || p.state === "BIDDING") {
      // Not settleable yet (deadline not reached): leave it alone.
      const now0 = await this.c.blockTimestampNs();
      const due = p.state === "CREATED" ? BigInt(p.prepay_deadline) : BigInt(p.reveal_deadline ?? "0");
      if (now0 < due) {
        this.log(`  ${purchaseId} ${p.state} until its deadline; skipped`);
        return run;
      }
    }
    const now = await this.c.blockTimestampNs();
    let last: TxResult | undefined;

    const deliveryOver = p.delivery_deadline !== null && now >= BigInt(p.delivery_deadline);
    if ((p.state === "FUNDED" || p.state === "DELIVERING") && deliveryOver) {
      run.path = "EXPIRED";
      last = this.track(run, "expire (delivery deadline passed)", await this.c.expire(purchaseId));
    } else if (p.state === "FUNDED" || p.state === "DELIVERING") {
      run.path = "DELIVERED";
      last = await this.deliverAndVerify(run, p);
    } else if (p.state === "VERIFYING" && p.verified_success == null && p.verification_deadline && now >= BigInt(p.verification_deadline)) {
      run.path = "EXPIRED";
      last = this.track(run, "expire (verification deadline passed)", await this.c.expire(purchaseId));
    } else if (p.state === "CREATED" && now >= BigInt(p.prepay_deadline)) {
      run.path = "EXPIRED";
      last = this.track(run, "expire (prepay deadline passed)", await this.c.expire(purchaseId));
    } else if (p.state === "BIDDING" && p.reveal_deadline && now >= BigInt(p.reveal_deadline)) {
      // An auction nobody closed: anyone may close it; with no eligible bid every prepayment comes back.
      run.path = "EXPIRED";
      last = this.track(run, "close_auction (reveal deadline passed)", await this.c.closeAuction(purchaseId));
    }
    await this.finishPayout(run, last);
    await this.confirmRefund(run, last);
    p = await this.mustPurchase(purchaseId);
    // Whatever is credited to these buyers goes to their own wallets now.
    const sent = await this.balances.returnTo(p.allocations.map((a) => a.buyer_id));
    run.returnedToBuyers = sent.reduce((s, r) => s + r.amount, 0n);
    run.finalState = p.state;
    await this.o.store?.synced(p);
    if (p.state === "COMPLETED" || p.state === "REFUNDED") {
      const ca = this.o.swarm.coalitionAgent;
      if (ca.coalitions.get(p.coalition_id)?.status === "FUNDED") await ca.markClosed(p.coalition_id);
    }
    return run;
  }

  private async deliverAndVerify(run: SettlementRun, p: ContractPurchase): Promise<TxResult> {
    const swarm = this.o.swarm;
    const sellerId = p.winner_seller_id!;
    const seller = swarm.seller(sellerId);
    if (p.state === "FUNDED") this.track(run, "start_delivery", await this.c.startDelivery(p.purchase_id));
    const hours = p.allocations.reduce((s, a) => s + a.hours, 0);
    const offer = seller.profile.offers[0]!;
    const d = simulateDelivery({
      seed: this.o.seed,
      purchaseId: p.purchase_id,
      sellerId,
      gpuModel: offer.gpuModel,
      vramGb: offer.vramGb,
      requiredHours: hours,
      failureProbabilityBps: seller.profile.failureProbabilityBps,
      startedAt: swarm.clock(),
      force: this.o.force?.[p.purchase_id],
      msPerHour: 0,
    });
    run.delivery = d;
    this.log(`  ${p.purchase_id} simulated delivery: ${d.outcome} ${d.allocatedHours}/${d.requiredHours} h (SIMULATED)`);
    const reportTx = this.track(run, "submit_delivery_report", await this.c.submitDeliveryReport(p.purchase_id, d.jobLogHashHex));
    await this.o.store?.delivered(d, reportTx);
    const report = seller.deliveryReportMessage(d, reportTx.txHash);
    await this.send(report);

    const onChain = (await this.mustPurchase(p.purchase_id)).delivery_report_hash ?? null;
    const decision = decideVerification(report.payload, d.jobLog, onChain);
    run.decision = decision;
    const vtx = this.track(run, `verify(${decision.success ? "success" : "fail"})`, await this.c.verify(p.purchase_id, decision.success, decision.reason));
    await this.o.store?.verified(p.purchase_id, decision, this.o.verifierAccountId, vtx);
    await this.send(
      createMessage(
        {
          type: "VERIFICATION_RESULT",
          sender_id: SYSTEM_AGENTS.VERIFICATION,
          receiver_id: SYSTEM_AGENTS.TREASURY,
          timestamp: swarm.clock().toISOString(),
          payload: {
            purchase_id: p.purchase_id,
            success: decision.success,
            reason: decision.reason,
            report_hash_hex: d.jobLogHashHex,
            verifier_account: this.o.verifierAccountId,
            simulated_verification: true,
            tx_hash: vtx.txHash,
          },
        },
        swarm.systemKey(SYSTEM_AGENTS.VERIFICATION),
      ),
    );
    return vtx;
  }

  /** Payout outcome from contract events; retry a failed transfer; confirm to buyers. */
  private async finishPayout(run: SettlementRun, first: TxResult | undefined): Promise<void> {
    let tx = first;
    for (let attempt = 0; ; attempt++) {
      const p = await this.mustPurchase(run.purchaseId);
      if (tx) {
        const okE = has(tx, "payout_succeeded");
        const failE = has(tx, "payout_failed");
        if (okE || failE) {
          const seller = p.winner_seller_id ?? "";
          const payoutAccount = String(data(okE ?? failE).payout_account_id ?? this.o.swarm.sellers.find((s) => s.id === seller)?.profile.payoutAccount ?? "");
          const amount = BigInt(String(data(okE ?? failE).amount ?? p.held));
          await this.o.store?.payoutAttempt(run.purchaseId, seller, payoutAccount, amount, !!okE, tx);
          if (okE) {
            run.paidOut = amount;
            await this.confirmPayout(p, amount, payoutAccount, tx.txHash);
            return;
          }
        }
      }
      if (!(p.state === "VERIFYING" && p.verified_success === true && !p.payout_in_flight && BigInt(p.held) > 0n)) return;
      if (attempt >= (this.o.maxRetries ?? 2)) {
        this.log(`  ${run.purchaseId} payout still failing after ${attempt} retries; left for a later run`);
        return;
      }
      run.retries++;
      await this.sleep(2000); // a failed transfer's refund receipt must land before the solvency check passes
      tx = this.track(run, "payout (retry)", await this.c.payout(run.purchaseId));
    }
  }

  /** verify(fail)/expire credited every member; tell each one what it got back. */
  private async confirmRefund(run: SettlementRun, tx: TxResult | undefined): Promise<void> {
    const e = tx && has(tx, "refund_succeeded");
    if (!tx || !e) return;
    const d = data(e);
    const lines = (d.lines as { buyer_id: string; amount: string }[]) ?? [];
    const amount = BigInt(String(d.amount));
    run.refunded = amount;
    await this.o.store?.refunded(run.purchaseId, amount, String(d.reason ?? "refund"), lines, tx);
    const key = this.o.swarm.systemKey(SYSTEM_AGENTS.TREASURY);
    const per_buyer = lines.map((l) => ({ buyer_id: l.buyer_id, amount_yocto: String(l.amount) }));
    for (const l of lines) {
      await this.send(
        createMessage(
          {
            type: "REFUND_CONFIRMATION",
            sender_id: SYSTEM_AGENTS.TREASURY,
            receiver_id: l.buyer_id,
            timestamp: this.o.swarm.clock().toISOString(),
            payload: { purchase_id: run.purchaseId, total_refund_yocto: amount.toString(), per_buyer, tx_hash: tx.txHash },
          },
          key,
        ),
      );
    }
  }

  private async confirmPayout(p: ContractPurchase, amount: bigint, payoutAccount: string, txHash: string): Promise<void> {
    const key = this.o.swarm.systemKey(SYSTEM_AGENTS.TREASURY);
    for (const a of p.allocations) {
      await this.send(
        createMessage(
          {
            type: "SETTLEMENT_CONFIRMATION",
            sender_id: SYSTEM_AGENTS.TREASURY,
            receiver_id: a.buyer_id,
            timestamp: this.o.swarm.clock().toISOString(),
            payload: { purchase_id: p.purchase_id, seller_id: p.winner_seller_id!, payout_account: payoutAccount, amount_yocto: amount.toString(), tx_hash: txHash },
          },
          key,
        ),
      );
    }
  }

  private async send(m: AgentMessage): Promise<void> {
    const r = await this.o.swarm.bus.send(m);
    if (!r.ok) throw new Error(`message ${m.type} rejected: ${r.code} ${r.detail}`);
    await this.o.swarm.bus.drain();
  }

  private async mustPurchase(id: string): Promise<ContractPurchase> {
    const p = await this.c.getPurchase(id);
    if (!p) throw new Error(`purchase ${id} not found on-chain`);
    return p;
  }
}
