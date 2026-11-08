/**
 * Direct, read-only contract views from the browser via the public NEAR Testnet
 * RPC. Lets a visitor check the backend's numbers against the chain itself.
 */
export async function viewContract<T>(rpcUrl: string, contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
  const body = {
    jsonrpc: "2.0",
    id: "swarmcompute-ui",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: method,
      args_base64: btoa(JSON.stringify(args)),
    },
  };
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = (await r.json()) as { result?: { result: number[]; block_height: number }; error?: { message?: string; cause?: { name?: string } } };
  if (j.error) throw new Error(j.error.cause?.name ?? j.error.message ?? "RPC error");
  const bytes = new Uint8Array(j.result!.result);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
