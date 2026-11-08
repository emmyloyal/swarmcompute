/**
 * Deterministic agent profiles (spec Section 4). Same seed + same base time
 * => identical profiles (RULES.md R16).
 *
 * Prices are deliberately small (fractions of a milliNEAR per GPU-hour) so a
 * full demo run costs well under 1 testnet NEAR from the single funder wallet.
 */
import { nearToYocto, type GpuModel } from "@swarmcompute/shared";
import { Prng } from "./prng.js";

export const BUYER_COUNT = 20;

export type PricingStrategy =
  | "AGGRESSIVE_LOW"
  | "PREMIUM_RELIABLE"
  | "LIMITED_CAPACITY"
  | "FLEXIBLE"
  | "RANDOMIZED_COMPETITIVE";

export interface BuyerProfile {
  agentId: string;
  buyerId: string;
  gpuModel: GpuModel;
  minVramGb: number;
  requiredHours: number;
  maxBudgetYocto: bigint;
  maxPricePerHourYocto: bigint;
  latestDeliveryAt: Date;
  /** The buyer agent's own testnet wallet: prepays from here, receives its balance here. */
  wallet: string;
}

/** `buyer-001` → `buyer001.<parent>` (NEAR sub-account names can't contain the hyphen pattern we want to keep readable). */
export function buyerWallet(buyerId: string, parent: string): string {
  return `${buyerId.replace("-", "")}.${parent}`;
}

export interface GpuOffer {
  gpuModel: GpuModel;
  vramGb: number;
  capacityHours: number;
  deliveryTimeMinutes: number;
}

export interface SellerProfile {
  agentId: string;
  sellerId: string;
  /** REAL testnet account receiving payouts (spec Section 2). */
  payoutAccount: string;
  strategy: PricingStrategy;
  offers: GpuOffer[];
  /** PRIVATE: never leaves the backend (not in SELLER_AVAILABILITY, not in public views). */
  minPricePerHourYocto: bigint;
  /** PRIVATE: simulated delivery failure probability, basis points. */
  failureProbabilityBps: number;
}

const n = nearToYocto;
const MICRO = 10n ** 18n; // 0.000001 NEAR

/** Per-model buyer price bands (yocto per GPU-hour). */
const BUYER_PRICE_BAND: Record<GpuModel, [bigint, bigint]> = {
  A100: [n("0.0004"), n("0.0012")],
  H100: [n("0.0008"), n("0.0020")],
};

export function generateBuyers(seed: string, baseTime: Date, walletParent = "buyers.testnet"): BuyerProfile[] {
  const root = new Prng(seed, "buyers");
  const out: BuyerProfile[] = [];
  for (let i = 1; i <= BUYER_COUNT; i++) {
    const buyerId = `buyer-${String(i).padStart(3, "0")}`;
    const r = root.fork(buyerId);
    // ~60% A100, ~40% H100
    const gpuModel: GpuModel = r.chanceBps(6000) ? "A100" : "H100";
    const minVramGb = gpuModel === "A100" ? r.pick([40, 80]) : 80;
    const requiredHours = r.int(4, 40);
    const [lo, hi] = BUYER_PRICE_BAND[gpuModel];
    // Whole micro-NEAR amounts keep logs and UI readable; still exact integers.
    const maxPricePerHourYocto = (r.bigint(lo, hi) / MICRO) * MICRO;
    // Budget always covers the buyer's own hours at its own max price, plus 0-50% headroom.
    const headroomBps = BigInt(r.int(10_000, 15_000));
    const maxBudgetYocto = (((maxPricePerHourYocto * BigInt(requiredHours) * headroomBps) / 10_000n) / MICRO) * MICRO;
    const latestDeliveryAt = new Date(baseTime.getTime() + r.int(6, 72) * 3_600_000);
    out.push({
      agentId: buyerId,
      buyerId,
      gpuModel,
      minVramGb,
      requiredHours,
      maxBudgetYocto,
      maxPricePerHourYocto,
      latestDeliveryAt,
      wallet: buyerWallet(buyerId, walletParent),
    });
  }
  return out;
}

/** One seller per strategy (spec Section 4). Fixed design, not random: the demo relies on their contrast. */
const SELLER_DESIGN: Omit<SellerProfile, "agentId" | "sellerId" | "payoutAccount">[] = [
  {
    strategy: "AGGRESSIVE_LOW",
    offers: [{ gpuModel: "A100", vramGb: 80, capacityHours: 200, deliveryTimeMinutes: 30 }],
    minPricePerHourYocto: n("0.0004"),
    failureProbabilityBps: 1500,
  },
  {
    strategy: "PREMIUM_RELIABLE",
    offers: [
      { gpuModel: "H100", vramGb: 80, capacityHours: 200, deliveryTimeMinutes: 15 },
      { gpuModel: "A100", vramGb: 80, capacityHours: 120, deliveryTimeMinutes: 15 },
    ],
    minPricePerHourYocto: n("0.00075"),
    failureProbabilityBps: 200,
  },
  {
    strategy: "LIMITED_CAPACITY",
    offers: [{ gpuModel: "A100", vramGb: 80, capacityHours: 40, deliveryTimeMinutes: 45 }],
    minPricePerHourYocto: n("0.0005"),
    failureProbabilityBps: 500,
  },
  {
    strategy: "FLEXIBLE",
    offers: [
      { gpuModel: "A100", vramGb: 80, capacityHours: 150, deliveryTimeMinutes: 60 },
      { gpuModel: "H100", vramGb: 80, capacityHours: 150, deliveryTimeMinutes: 60 },
    ],
    minPricePerHourYocto: n("0.0005"),
    failureProbabilityBps: 800,
  },
  {
    strategy: "RANDOMIZED_COMPETITIVE",
    offers: [
      { gpuModel: "H100", vramGb: 80, capacityHours: 120, deliveryTimeMinutes: 40 },
      { gpuModel: "A100", vramGb: 40, capacityHours: 120, deliveryTimeMinutes: 40 },
    ],
    minPricePerHourYocto: n("0.0006"),
    failureProbabilityBps: 1000,
  },
];

export function generateSellers(payoutAccounts: readonly string[]): SellerProfile[] {
  if (payoutAccounts.length !== SELLER_DESIGN.length) {
    throw new Error(`expected ${SELLER_DESIGN.length} seller payout accounts, got ${payoutAccounts.length}`);
  }
  return SELLER_DESIGN.map((d, i) => {
    const sellerId = `seller-${String(i + 1).padStart(2, "0")}`;
    return { ...d, offers: d.offers.map((o) => ({ ...o })), agentId: sellerId, sellerId, payoutAccount: payoutAccounts[i]! };
  });
}
