/**
 * NEAR Testnet client (near-api-js 7.4.0, verified 2026-11-08).
 *
 * - Refuses to run unless the RPC reports chain_id "testnet" (RULES.md R1).
 * - One signer per role (RULES.md R8): the funder key is only used for `fund`,
 *   the verifier key only for `verify`, the operator key for everything else.
 * - Returns the real execution outcome. Failed transactions are results, not
 *   exceptions, so the failure is recorded and shown (RULES.md R2). Only an RPC
 *   error (no tx hash) throws.
 */
import { Account, actions, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { parseEvents, type CallOptions, type ChainCaller, type ChainReader, type Role, type TxResult, type TxStatusView } from "./types.js";

export interface NearChainConfig {
  rpcUrl: string;
  contractId: string;
  accounts: Record<Role, { accountId: string; privateKey: string }>;
  /**
   * Buyer agents' wallets: `<buyerNNN>.<parent>`, all holding `privateKey`
   * (backend-held, like every simulated agent's key).
   */
  buyerWallets?: { parent: string; privateKey: string };
  /** Persists each submitted tx (blockchain_transactions). */
  recorder?: TxRecorder;
}

export interface TxRecorder {
  record(tx: TxResult, opts: CallOptions & { deposit: bigint }): Promise<void>;
}

type Outcome = Awaited<ReturnType<Account["signAndSendTransaction"]>>;

function failed(status: unknown): boolean {
  return typeof status === "object" && status !== null && "Failure" in status;
}

export function toTxResult(out: Outcome, signerId: string, receiverId: string, method: string): TxResult {
  const all = [out.transaction_outcome, ...out.receipts_outcome];
  const logs = all.flatMap((o) => o.outcome.logs);
  const failedReceipts = out.receipts_outcome.filter((r) => failed(r.outcome.status)).length;
  const topFailed = failed(out.status);
  const gasBurnt = all.reduce((s, o) => s + BigInt(o.outcome.gas_burnt), 0n);
  const firstFailure = [out.status, ...out.receipts_outcome.map((r) => r.outcome.status)].find(failed) as
    | { Failure: unknown }
    | undefined;
  return {
    txHash: out.transaction_outcome.id,
    signerId,
    receiverId,
    method,
    ok: !topFailed && failedReceipts === 0,
    callSucceeded: !topFailed,
    failedReceipts,
    logs,
    events: parseEvents(logs),
    blockHash: (out.transaction_outcome as { block_hash?: string }).block_hash,
    gasBurnt,
    error: firstFailure?.Failure,
  };
}

export class NearChain implements ChainCaller, ChainReader {
  readonly contractId: string;
  private readonly provider: JsonRpcProvider;
  private readonly accounts: Record<Role, Account>;

  private constructor(private readonly cfg: NearChainConfig) {
    this.contractId = cfg.contractId;
    this.provider = new JsonRpcProvider({ url: cfg.rpcUrl });
    const mk = (r: Role) =>
      new Account(cfg.accounts[r].accountId, this.provider, KeyPairSigner.fromSecretKey(cfg.accounts[r].privateKey as KeyPairString));
    // Same account in several roles shares one Account object, so nonces stay ordered.
    const byId = new Map<string, Account>();
    const get = (r: Role) => {
      const id = cfg.accounts[r].accountId;
      if (!byId.has(id)) byId.set(id, mk(r));
      return byId.get(id)!;
    };
    this.accounts = { operator: get("operator"), funder: get("funder"), verifier: get("verifier") };
  }

  /** Connects and verifies the network is NEAR Testnet before anything is signed. */
  static async connect(cfg: NearChainConfig): Promise<NearChain> {
    const c = new NearChain(cfg);
    const status = (await c.provider.viewNodeStatus()) as { chain_id?: string };
    if (status.chain_id !== "testnet") throw new Error(`RPC chain_id is "${status.chain_id}", expected "testnet" (RULES.md R1)`);
    return c;
  }

  accountOf(role: Role): string {
    return this.cfg.accounts[role].accountId;
  }

  async call(role: Role, method: string, args: Record<string, unknown>, opts: CallOptions): Promise<TxResult> {
    if (method === "verify" && role !== "verifier") throw new Error("verify must be signed by the verifier (RULES.md R8)");
    if (method === "prepay") throw new Error("prepay is signed only by the buyer's own wallet");
    const deposit = opts.deposit ?? 0n;
    const acct = this.accounts[role];
    const out = await acct.signAndSendTransaction({
      receiverId: this.contractId,
      actions: [actions.functionCall(method, args, BigInt(opts.gasTera ?? 100) * 10n ** 12n, deposit)],
      throwOnFailure: false,
      waitUntil: "FINAL",
    });
    const res = toTxResult(out, acct.accountId, this.contractId, method);
    await this.cfg.recorder?.record(res, { ...opts, deposit });
    return res;
  }

  private readonly buyerAccounts = new Map<string, Account>();

  async callAsBuyerWallet(wallet: string, method: string, args: Record<string, unknown>, opts: CallOptions): Promise<TxResult> {
    const bw = this.cfg.buyerWallets;
    if (!bw) throw new Error("buyer wallets are not configured");
    if (!wallet.endsWith(`.${bw.parent}`)) throw new Error(`${wallet} is not a buyer wallet under ${bw.parent}`);
    if (method !== "prepay") throw new Error("buyer wallets only sign their own prepayment");
    let acct = this.buyerAccounts.get(wallet);
    if (!acct) {
      acct = new Account(wallet, this.provider, KeyPairSigner.fromSecretKey(bw.privateKey as KeyPairString));
      this.buyerAccounts.set(wallet, acct);
    }
    const deposit = opts.deposit ?? 0n;
    const out = await acct.signAndSendTransaction({
      receiverId: this.contractId,
      actions: [actions.functionCall(method, args, BigInt(opts.gasTera ?? 100) * 10n ** 12n, deposit)],
      throwOnFailure: false,
      waitUntil: "FINAL",
    });
    const res = toTxResult(out, wallet, this.contractId, method);
    await this.cfg.recorder?.record(res, { ...opts, deposit });
    return res;
  }

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await withRateLimitRetry(() => this.provider.callFunction({ contractId: this.contractId, method, args, blockQuery: { finality: "final" } }))) as T;
  }

  async blockTimestampNs(): Promise<bigint> {
    const b = await withRateLimitRetry(() => this.provider.viewBlock({ finality: "final" }));
    return BigInt(b.header.timestamp_nanosec);
  }

  async txStatus(txHash: string, signerId: string): Promise<TxStatusView | null> {
    return withRateLimitRetry(() => fetchTxStatus(this.provider, txHash, signerId));
  }

  async block(hash: string): Promise<{ height: bigint; timestampNs: bigint }> {
    const b = await withRateLimitRetry(() => this.provider.viewBlock({ blockId: hash }));
    return { height: BigInt(b.header.height), timestampNs: BigInt(b.header.timestamp_nanosec) };
  }
}

/**
 * Read calls only: back off and retry when the public RPC rate-limits (HTTP 429).
 * Never used for transaction submission (a resent tx could double-act).
 */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (i >= attempts - 1 || !/429|rate limit/i.test(msg)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

/** Unknown-transaction errors become null; any other RPC error propagates (never guessed). */
export async function fetchTxStatus(provider: JsonRpcProvider, txHash: string, signerId: string): Promise<TxStatusView | null> {
  let out: Awaited<ReturnType<JsonRpcProvider["viewTransactionStatusWithReceipts"]>>;
  try {
    out = await provider.viewTransactionStatusWithReceipts({ txHash, accountId: signerId, waitUntil: "FINAL" });
  } catch (err) {
    if (/UNKNOWN_TRANSACTION|doesn't exist|does not exist|not found/i.test(String((err as Error).message ?? err))) return null;
    throw err;
  }
  const o = out as unknown as {
    status: unknown;
    transaction: { signer_id: string; receiver_id: string };
    transaction_outcome: { id: string };
    receipts_outcome: { id: string; block_hash: string; outcome: { logs: string[]; executor_id: string; status: unknown } }[];
  };
  const receipts = o.receipts_outcome.map((r) => ({
    receiptId: r.id,
    executorId: r.outcome.executor_id,
    blockHash: r.block_hash,
    logs: r.outcome.logs,
    failed: failed(r.outcome.status),
  }));
  return {
    txHash: o.transaction_outcome.id,
    signerId: o.transaction.signer_id,
    receiverId: o.transaction.receiver_id,
    ok: !failed(o.status) && receipts.every((r) => !r.failed),
    receipts,
  };
}
