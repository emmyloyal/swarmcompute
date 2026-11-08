/**
 * Chain-facing types. Every TxResult comes from a real RPC response
 * (RULES.md R2): if the RPC call itself fails there is no TxResult, the error
 * propagates, and nothing is recorded as if it had happened.
 */
export type Role = "operator" | "funder" | "verifier";

export interface ContractEvent {
  standard: string;
  version: string;
  event: string;
  data: Record<string, unknown>[];
}

export interface TxResult {
  txHash: string;
  signerId: string;
  receiverId: string;
  method: string;
  /** Transaction and every receipt succeeded. */
  ok: boolean;
  /**
   * The contract call itself (and its final callback) did not panic. True for a
   * `verify` whose payout transfer failed but whose callback recorded that.
   */
  callSucceeded: boolean;
  /** Receipts that failed (e.g. a payout transfer); `ok` is false when > 0. */
  failedReceipts: number;
  logs: string[];
  events: ContractEvent[];
  blockHash?: string;
  gasBurnt: bigint;
  error?: unknown;
}

export interface CallOptions {
  deposit?: bigint;
  gasTera?: number;
  /** Why the backend sent this (blockchain_transactions.purpose). */
  purpose: string;
  purchaseId?: string;
}

/** Low-level port: implemented by NearChain against testnet RPC. */
export interface ChainCaller {
  readonly contractId: string;
  accountOf(role: Role): string;
  call(role: Role, method: string, args: Record<string, unknown>, opts: CallOptions): Promise<TxResult>;
  /** Sign as a buyer agent's own wallet (used only for that buyer's prepayment). */
  callAsBuyerWallet(wallet: string, method: string, args: Record<string, unknown>, opts: CallOptions): Promise<TxResult>;
  view<T>(method: string, args?: Record<string, unknown>): Promise<T>;
  /** Latest final block timestamp (ns). Contract deadlines are in chain time. */
  blockTimestampNs(): Promise<bigint>;
}

export interface ReceiptView {
  receiptId: string;
  executorId: string;
  blockHash: string;
  logs: string[];
  failed: boolean;
}

export interface TxStatusView {
  txHash: string;
  signerId: string;
  receiverId: string;
  /** Transaction and all receipts succeeded. */
  ok: boolean;
  receipts: ReceiptView[];
}

/** Read side used by confirmation, indexing and reconciliation (Phase 6). */
export interface ChainReader {
  readonly contractId: string;
  /** Final status of a tx from the RPC; null if the RPC does not know the tx. */
  txStatus(txHash: string, signerId: string): Promise<TxStatusView | null>;
  block(hash: string): Promise<{ height: bigint; timestampNs: bigint }>;
  view<T>(method: string, args?: Record<string, unknown>): Promise<T>;
}

export class ChainCallError extends Error {
  override name = "ChainCallError";
  constructor(
    message: string,
    readonly result: TxResult,
  ) {
    super(message);
  }
}

export function parseEvents(logs: readonly string[]): ContractEvent[] {
  const out: ContractEvent[] = [];
  for (const l of logs) {
    if (!l.startsWith("EVENT_JSON:")) continue;
    try {
      const e = JSON.parse(l.slice("EVENT_JSON:".length)) as ContractEvent;
      if (typeof e.event === "string" && Array.isArray(e.data)) out.push(e);
    } catch {
      /* not an event */
    }
  }
  return out;
}
