/**
 * Full SwarmCompute flow on NEAR Testnet: collective buying at one fair price.
 *
 * 20 simulated buyers → coalitions → each member prepays hours × its own max
 * price from its own wallet → sealed commit-reveal auction → lowest eligible
 * bid is the clearing price for EVERY member → each member's excess goes back to
 * its wallet → simulated delivery + verification → seller paid, or each member
 * refunded to its own wallet → reputation updated by the contract.
 *
 * One purchase is forced to fail delivery so the refund path always shows.
 * Pass `--no-forced-failure` to disable.
 *
 *   pnpm --filter @swarmcompute/backend demo:run
 */
import { yoctoToNear } from "@swarmcompute/shared";
import { AuctionEngine } from "../auction/engine.js";
import { PgAuctionStore } from "../db/auction-repo.js";
import { PgSettlementStore } from "../db/settlement-repo.js";
import { SettlementEngine } from "../settlement/engine.js";
import { PgMessageConfirmer } from "../sync/confirm.js";
import { PgEventIndexer } from "../sync/indexer.js";
import { PgReconciler } from "../sync/reconcile.js";
import { bootstrap } from "./bootstrap.js";
import { print } from "./settle-run.js";

const N = (y: bigint | string) => `${yoctoToNear(BigInt(y))} NEAR`;

async function main(): Promise<void> {
  const rt = await bootstrap();
  const { cfg, pool, swarm, contract, chain } = rt;
  try {
    console.log(`contract ${cfg.MARKETPLACE_CONTRACT_ID} (NEAR Testnet), seed "${cfg.SIMULATION_SEED}"`);
    const auctions = new AuctionEngine({
      swarm,
      contract,
      windows: { prepay_secs: 600, commit_secs: 90, reveal_secs: 90, delivery_secs: 900, verification_secs: 900 },
      store: new PgAuctionStore(pool),
      log: (l) => console.log(l),
      runTag: Date.now().toString(36),
    });
    console.log("\n[1] participants (buyers with their own wallets)");
    console.log("   ", await auctions.registerParticipants());

    console.log("\n[2] requirements and coalitions");
    await swarm.announce();
    const formed = await swarm.formCoalitions();
    for (const c of formed.coalitions) {
      console.log(`    ${c.coalitionId} ${c.gpuModel}/${c.vramGb}GB ${c.members.length} buyers ${c.totalHours} h, ceiling ${N(c.priceCeilingPerHourYocto)}/h`);
    }
    for (const u of formed.unserved) console.log(`    not grouped: ${u.buyerId} (${u.reason})`);
    const active = formed.coalitions.map((c) => c.coalitionId).filter((id) => swarm.coalitionAgent.coalitions.get(id)!.status === "ACTIVE");

    console.log("\n[3] prepay own max → sealed auction → one clearing price → excess back to each wallet");
    const runs = await auctions.runAll(active);

    console.log("\n[fairness]");
    for (const r of runs) {
      const p = await contract.getPurchase(r.purchaseId);
      console.log(`  ${r.purchaseId}  ${r.state}  bids=${r.committed.length}  winner=${r.winnerSellerId ?? "-"}  clearing=${r.clearingPricePerHour ? `${N(r.clearingPricePerHour)}/h` : "-"}`);
      for (const a of p?.allocations ?? []) {
        console.log(
          `      ${a.buyer_id}  ${String(a.hours).padStart(3)} h  own max ${N(a.max_price_per_hour)}/h  prepaid ${N(a.prepaid)}  pays ${N(a.owed)}  back ${N(BigInt(a.excess) + BigInt(a.refunded))}`,
        );
      }
    }

    const fundedIds = runs.filter((r) => r.state === "FUNDED").map((r) => r.purchaseId);
    const force: Record<string, "FAILURE"> = {};
    if (!process.argv.includes("--no-forced-failure") && fundedIds.length > 1) force[fundedIds.at(-1)!] = "FAILURE";
    console.log(`\n[4] delivery, verification, settlement${Object.keys(force).length ? ` (forced failure: ${Object.keys(force)[0]})` : ""}`);
    const settlement = new SettlementEngine({
      swarm,
      contract,
      seed: cfg.SIMULATION_SEED,
      verifierAccountId: cfg.VERIFIER_ACCOUNT_ID,
      store: new PgSettlementStore(pool),
      force,
      log: (l) => console.log(l),
    });
    print(await settlement.settleAll(fundedIds), cfg.explorerTxUrl);

    console.log("\n[5] reputation (on-chain)");
    for (const s of swarm.sellers) {
      const v = (await contract.getSeller(s.id)) as { reputation: Record<string, number> } | null;
      if (v) console.log(`    ${s.id} ${JSON.stringify(v.reputation)}`);
    }

    console.log("\n[6] sync: index events, confirm messages, reconcile");
    const idx = await new PgEventIndexer(pool, chain).run();
    const conf = await new PgMessageConfirmer(pool, chain, { operator: cfg.OPERATOR_ACCOUNT_ID, funder: cfg.FUNDER_ACCOUNT_ID, verifier: cfg.VERIFIER_ACCOUNT_ID }).run();
    const rec = await new PgReconciler(pool, chain).run();
    console.log(`    ${idx.events} events indexed, ${conf.confirmed} messages confirmed (${conf.rejected} rejected, ${conf.pending} pending), ${rec.drifted.length} purchases with drift`);
    console.log(`    contract escrow ${N(rec.escrow.chainTotal)} (unexplained ${N(rec.escrow.unexplained < 0n ? -rec.escrow.unexplained : rec.escrow.unexplained)})`);
    if (swarm.bus.deliveryErrors.length) {
      console.error("delivery errors:", swarm.bus.deliveryErrors.map((d) => d.error));
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
