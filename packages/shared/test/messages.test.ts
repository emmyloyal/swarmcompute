import { describe, expect, it } from "vitest";
import {
  CoalitionProposalPayload,
  InMemoryReplayGuard,
  RefundConfirmationPayload,
  PrepaymentPayload,
  FundingConfirmationPayload,
  BalanceReturnedPayload,
  SYSTEM_AGENTS,
  canonicalJson,
  computeSignature,
  createMessage,
  deriveAgentKey,
  validateMessage,
  type ValidationDeps,
} from "../src/index.js";

const MASTER = Buffer.from("11".repeat(32), "hex");
const key = (id: string) => deriveAgentKey(MASTER, id);
const NOW = Date.parse("2026-11-06T12:00:00.000Z");
const TX = "9xQ2tA4nYQ3a6jZ2y8mXHk5ZJb7ec4U9k8tP1rS3vWzF";
const NEAR = "1000000000000000000000000";

function deps(overrides: Partial<ValidationDeps> = {}): ValidationDeps {
  return { keyFor: key, replayGuard: new InMemoryReplayGuard(), maxAgeMs: 300_000, now: () => NOW, ...overrides };
}

function requirement(buyer = "buyer-001") {
  return createMessage(
    {
      type: "BUYER_REQUIREMENT",
      sender_id: buyer,
      receiver_id: SYSTEM_AGENTS.COALITION,
      timestamp: new Date(NOW).toISOString(),
      payload: {
        buyer_id: buyer,
        gpu_model: "H100",
        min_vram_gb: 80,
        required_hours: 4,
        max_budget_yocto: (5n * 10n ** 24n).toString(),
        max_price_per_hour_yocto: NEAR,
        latest_delivery_at: "2026-11-07T00:00:00Z",
      },
    },
    key(buyer),
  );
}

/** Re-sign an arbitrary (possibly invalid) envelope as the given sender. */
function resign(env: Record<string, unknown>, signer: string): Record<string, unknown> {
  return { ...env, signature: computeSignature(env, key(signer)) };
}

describe("key derivation", () => {
  it("matches the Python-generated vector", () => {
    expect(key("buyer-001").toString("hex")).toBe("36b7a0d08fd198d940b02fdbe2e5c3067b4c16d2a25b84915d57e6fb464cc81d");
  });
  it("gives different agents different keys", () => {
    expect(key("buyer-001").equals(key("buyer-002"))).toBe(false);
  });
});

describe("canonical JSON", () => {
  it("sorts keys and strips whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  });
  it.each([1.5, Number.NaN, 2 ** 60, 10n, undefined])("rejects %s", (v) => {
    expect(() => canonicalJson({ v })).toThrow(TypeError);
  });
});

describe("validateMessage", () => {
  it("accepts a valid signed message, marking off-chain types as not needing tx verification", async () => {
    const r = await validateMessage(requirement(), deps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.requiresTxVerification).toBe(false);
  });

  it("rejects replayed message IDs", async () => {
    const d = deps();
    const m = requirement();
    expect((await validateMessage(m, d)).ok).toBe(true);
    expect(await validateMessage(m, d)).toMatchObject({ ok: false, code: "REPLAY" });
  });

  it("does not burn a message ID on a rejected message", async () => {
    const d = deps();
    const m = requirement();
    expect(await validateMessage({ ...m, signature: "0".repeat(64) }, d)).toMatchObject({ code: "BAD_SIGNATURE" });
    expect((await validateMessage(m, d)).ok).toBe(true);
  });

  it("rejects tampered payloads", async () => {
    const m = requirement();
    const tampered = { ...m, payload: { ...m.payload, max_budget_yocto: "9".repeat(30) } };
    expect(await validateMessage(tampered, deps())).toMatchObject({ ok: false, code: "BAD_SIGNATURE" });
  });

  it("rejects a message signed with another agent's key", async () => {
    const forged = resign({ ...requirement() }, "buyer-002");
    expect(await validateMessage(forged, deps())).toMatchObject({ code: "BAD_SIGNATURE" });
  });

  it("rejects unknown types", async () => {
    expect(await validateMessage({ ...requirement(), type: "TRANSFER_FUNDS" }, deps())).toMatchObject({ code: "UNKNOWN_TYPE" });
  });

  it("rejects a sender kind not permitted for the type", async () => {
    const m = { ...requirement(), type: "FUNDING_CONFIRMATION" };
    expect(await validateMessage(resign(m, "buyer-001"), deps())).toMatchObject({ code: "UNAUTHORIZED_SENDER" });
  });

  it("rejects a buyer speaking for another buyer", async () => {
    const m = requirement();
    const spoof = resign({ ...m, payload: { ...m.payload, buyer_id: "buyer-007" } }, "buyer-001");
    expect(await validateMessage(spoof, deps())).toMatchObject({ code: "UNAUTHORIZED_SENDER" });
  });

  it("rejects senders claiming a non-PENDING status", async () => {
    expect(await validateMessage({ ...requirement(), status: "CONFIRMED" }, deps())).toMatchObject({ code: "MALFORMED_ENVELOPE" });
  });

  it("rejects stale and future-dated messages", async () => {
    expect(await validateMessage(requirement(), deps({ now: () => NOW + 301_000 }))).toMatchObject({ code: "STALE" });
    expect(await validateMessage(requirement(), deps({ now: () => NOW - 60_000 }))).toMatchObject({ code: "STALE" });
  });

  it("rejects a BID_COMMITMENT that leaks price or nonce", async () => {
    const sender = "seller-01";
    const m = createMessage(
      {
        type: "BID_COMMITMENT",
        sender_id: sender,
        receiver_id: SYSTEM_AGENTS.AUCTION_COORDINATOR,
        timestamp: new Date(NOW).toISOString(),
        payload: { auction_id: "auction-0001", seller_id: sender, commitment_hex: "ab".repeat(32), tx_hash: TX },
      },
      key(sender),
    );
    expect(m.auction_id).toBe("auction-0001");
    const ok = await validateMessage(m, deps());
    expect(ok).toMatchObject({ ok: true, requiresTxVerification: true });
    const leaky = resign({ ...m, payload: { ...m.payload, price_per_hour_yocto: NEAR } }, sender);
    expect(await validateMessage(leaky, deps())).toMatchObject({ code: "INVALID_PAYLOAD" });
  });

  it("rejects envelope / payload context mismatches", async () => {
    const sender = "seller-01";
    const m = createMessage(
      {
        type: "BID_COMMITMENT",
        sender_id: sender,
        receiver_id: SYSTEM_AGENTS.AUCTION_COORDINATOR,
        timestamp: new Date(NOW).toISOString(),
        payload: { auction_id: "auction-0001", seller_id: sender, commitment_hex: "ab".repeat(32), tx_hash: TX },
      },
      key(sender),
    );
    const moved = resign({ ...m, auction_id: "auction-0002" }, sender);
    expect(await validateMessage(moved, deps())).toMatchObject({ code: "CONTEXT_MISMATCH" });
  });

  it("refuses to construct a message with an invalid payload", () => {
    expect(() =>
      createMessage(
        {
          type: "CONTRIBUTION_APPROVAL",
          sender_id: "buyer-001",
          receiver_id: SYSTEM_AGENTS.TREASURY,
          // @ts-expect-error approval_kind must be the literal "SIMULATED"
          payload: { purchase_id: "purchase-0001", coalition_id: "coal-0001", buyer_id: "buyer-001", hours: 2, contribution_yocto: NEAR, approved: true, approval_kind: "SIGNED" },
        },
        key("buyer-001"),
      ),
    ).toThrow();
  });
});

describe("payload refinements", () => {
  const member = (id: string, price: string) => ({ buyer_id: id, hours: 2, max_price_per_hour_yocto: price, max_budget_yocto: "10" });
  const proposal = {
    coalition_id: "coal-0001",
    gpu_model: "A100",
    vram_gb: 80,
    members: [member("buyer-001", "5"), member("buyer-002", "3")],
    min_members: 2,
    total_hours: 4,
    price_ceiling_per_hour_yocto: "3",
    total_budget_yocto: "20",
    delivery_deadline: "2026-11-07T00:00:00Z",
    formation_seed: "seed",
  };

  it("enforces the coalition price ceiling = lowest member max price", () => {
    expect(CoalitionProposalPayload.safeParse(proposal).success).toBe(true);
    expect(CoalitionProposalPayload.safeParse({ ...proposal, price_ceiling_per_hour_yocto: "5" }).success).toBe(false);
    expect(CoalitionProposalPayload.safeParse({ ...proposal, total_hours: 5 }).success).toBe(false);
    expect(CoalitionProposalPayload.safeParse({ ...proposal, total_budget_yocto: "21" }).success).toBe(false);
  });

  it("reports malformed money as a validation error instead of throwing", () => {
    const bad = { ...proposal, members: [member("buyer-001", "1.5"), member("buyer-002", "3")] };
    expect(() => CoalitionProposalPayload.safeParse(bad)).not.toThrow();
    expect(CoalitionProposalPayload.safeParse(bad).success).toBe(false);
  });

  it("requires per-buyer refunds to sum to the total", () => {
    const refund = {
      purchase_id: "purchase-0001",
      total_refund_yocto: "10",
      per_buyer: [{ buyer_id: "buyer-001", amount_yocto: "4" }, { buyer_id: "buyer-002", amount_yocto: "6" }],
      tx_hash: TX,
    };
    expect(RefundConfirmationPayload.safeParse(refund).success).toBe(true);
    expect(RefundConfirmationPayload.safeParse({ ...refund, total_refund_yocto: "11" }).success).toBe(false);
    expect(RefundConfirmationPayload.safeParse({ ...refund, funder_account: "funder.testnet" }).success).toBe(false);
  });

  it("encodes the fair-price arithmetic in prepayment and funding messages", () => {
    const pre = { purchase_id: "purchase-0001", coalition_id: "coalition-1", buyer_id: "buyer-001", wallet: "buyer001.dev.testnet", hours: 10, max_price_per_hour_yocto: "7", amount_yocto: "70", tx_hash: TX };
    expect(PrepaymentPayload.safeParse(pre).success).toBe(true);
    expect(PrepaymentPayload.safeParse({ ...pre, amount_yocto: "69" }).success).toBe(false);
    expect(PrepaymentPayload.safeParse({ ...pre, wallet: "buyer001.near" }).success).toBe(false);
    const funded = { purchase_id: "purchase-0001", buyer_id: "buyer-001", clearing_price_per_hour_yocto: "4", hours: 10, prepaid_yocto: "70", owed_yocto: "40", excess_yocto: "30", tx_hash: TX };
    expect(FundingConfirmationPayload.safeParse(funded).success).toBe(true);
    expect(FundingConfirmationPayload.safeParse({ ...funded, owed_yocto: "41" }).success).toBe(false); // not hours × clearing price
    expect(FundingConfirmationPayload.safeParse({ ...funded, excess_yocto: "29" }).success).toBe(false); // excess withheld
    expect(BalanceReturnedPayload.safeParse({ buyer_id: "buyer-001", wallet: "buyer001.dev.testnet", amount_yocto: "30", tx_hash: TX }).success).toBe(true);
  });
});
