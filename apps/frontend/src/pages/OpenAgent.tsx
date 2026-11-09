/**
 * Open a buying or selling agent (RULES.md R19, R20).
 *
 * 1. The market host issues a key pair for the new agent and returns only the
 *    public key.
 * 2. The user's own wallet signs `open_buyer_agent` / `open_seller_agent`,
 *    which creates `<name>.<contract>` with that key as its only key, a
 *    function-call key limited to the marketplace's agent methods.
 * 3. The user's wallet becomes the agent's owner: refunds, leftovers and seller
 *    payouts can only ever go back to it.
 */
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Store, User } from "../components/icons";
import { PageHead } from "../components/ui";
import { postJson, useMarket, useMeta } from "../lib/api";
import { dur, near, parseNear } from "../lib/format";
import { GPU_MODELS, type GpuModel, type GpuOffer, type SellerStrategy } from "../lib/types";
import { useWallet } from "../lib/wallet";

export const isAgentName = (s: string) => /^[a-z0-9]+([-_][a-z0-9]+)*$/.test(s) && s.length >= 2 && s.length <= 32;
const DEADLINES = [6, 24, 72, 168];

export function OpenAgentPage() {
  const [q, setQ] = useSearchParams();
  const role = q.get("role") === "seller" ? "SELLER" : "BUYER";
  const meta = useMeta();
  const { data: m } = useMarket();
  const { accountId, connect, call, setFlash } = useWallet();
  const nav = useNavigate();

  const [name, setName] = useState("");
  // Buyer terms
  const [gpu, setGpu] = useState<GpuModel>("A100");
  const [vram, setVram] = useState("80");
  const [hours, setHours] = useState("10");
  const [maxPrice, setMaxPrice] = useState("0.003");
  const [deadlineH, setDeadlineH] = useState(24);
  const [budget, setBudget] = useState("");
  // Seller terms
  const [offers, setOffers] = useState<{ gpu_model: GpuModel; vram_gb: string; capacity_hours: string }[]>([{ gpu_model: "A100", vram_gb: "80", capacity_hours: "100" }]);
  const [minPrice, setMinPrice] = useState("0.001");
  const [strategy, setStrategy] = useState<"AT_MINIMUM" | "BELOW_CEILING">("AT_MINIMUM");
  const [discount, setDiscount] = useState("10");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxLen = meta?.agentNameMaxLength ?? 32;
  const agentId = meta && name ? `${name}.${meta.contractId}` : "";
  const taken = !!m && (m.buyers.some((b) => b.buyer_id === agentId) || m.sellers.some((s) => s.seller_id === agentId));
  const openFee = meta?.openFee ? BigInt(meta.openFee) : null;
  const leadSecs = meta ? meta.windows.prepay_secs + meta.windows.commit_secs + meta.windows.reveal_secs + meta.windows.delivery_secs : 0;

  const v = useMemo(() => {
    const errs: string[] = [];
    if (!isAgentName(name)) errs.push("Name: 2–32 characters of a–z and 0–9, with single - or _ between them.");
    else if (name.length > maxLen) errs.push(`Name: at most ${maxLen} characters under this contract.`);
    if (taken) errs.push("That name is taken.");
    const int = (s: string, what: string, min = 1) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < min || n > 1_000_000) errs.push(`${what} must be a whole number from ${min}.`);
      return n;
    };
    if (role === "BUYER") {
      const vr = int(vram, "VRAM");
      const h = int(hours, "Hours");
      const max = parseNear(maxPrice);
      if (!max || max === 0n) errs.push("Max price must be a positive NEAR amount.");
      const prepay = max && Number.isInteger(h) ? max * BigInt(h) : 0n;
      const b = budget.trim() === "" ? prepay : parseNear(budget);
      if (b === null) errs.push("Budget must be a NEAR amount.");
      if (deadlineH * 3600 <= leadSecs) errs.push(`The deadline must leave at least ${dur(leadSecs)} for a full round.`);
      return { errs, prepay, budget: b ?? 0n, vram: vr, hours: h, max: max ?? 0n };
    }
    const parsed: GpuOffer[] = offers.map((o, i) => ({ gpu_model: o.gpu_model, vram_gb: int(o.vram_gb, `Offer ${i + 1} VRAM`), capacity_hours: int(o.capacity_hours, `Offer ${i + 1} capacity`) }));
    const min = parseNear(minPrice);
    if (!min || min === 0n) errs.push("Minimum price must be a positive NEAR amount.");
    const d = Number(discount);
    if (strategy === "BELOW_CEILING" && !(d > 0 && d < 100)) errs.push("Discount must be between 0 and 100%.");
    const strat: SellerStrategy = strategy === "AT_MINIMUM" ? { kind: "AT_MINIMUM" } : { kind: "BELOW_CEILING", discount_bps: Math.round(d * 100) };
    return { errs, offers: parsed, min: min ?? 0n, strategy: strat };
  }, [name, maxLen, taken, role, vram, hours, maxPrice, budget, deadlineH, leadSecs, offers, minPrice, strategy, discount]);

  const total = openFee !== null ? openFee + (role === "BUYER" ? ((v as { budget?: bigint }).budget ?? 0n) : 0n) : null;

  const submit = async () => {
    if (!meta || openFee === null) return;
    if (!accountId) return void connect();
    if (v.errs.length) return setError(v.errs[0]!);
    setBusy(true);
    setError(null);
    try {
      const { publicKey, agentId: id } = await postJson<{ publicKey: string; agentId: string }>("/api/agent-keys", { role, name });
      const returnTo = `/agents/${id}`;
      let out;
      if (role === "BUYER") {
        const b = v as { budget: bigint; vram: number; hours: number; max: bigint };
        const chainNow = BigInt(meta.host.chainTimeNs || "0") || BigInt(Date.now()) * 1_000_000n;
        const deadline = (chainNow + BigInt(deadlineH) * 3600n * 1_000_000_000n).toString();
        out = await call(
          "open_buyer_agent",
          { name, public_key: publicKey, request: { gpu_model: gpu, vram_gb: b.vram, hours: b.hours, max_price_per_hour: b.max.toString(), deadline } },
          openFee + b.budget,
          { returnTo, label: `Opening ${name}` },
        );
      } else {
        const s = v as { offers: GpuOffer[]; min: bigint; strategy: SellerStrategy };
        out = await call("open_seller_agent", { name, public_key: publicKey, offers: s.offers, min_price_per_hour: s.min.toString(), strategy: s.strategy }, openFee, {
          returnTo,
          label: `Opening ${name}`,
        });
      }
      if (out.txHash) {
        if (out.ok === false) throw new Error(out.error ?? "the transaction failed");
        setFlash({ kind: "ok", text: `${name} is being opened. It appears in the market within a few seconds.`, txHash: out.txHash });
        nav(returnTo);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setOffer = (i: number, k: "gpu_model" | "vram_gb" | "capacity_hours", val: string) => setOffers((os) => os.map((o, j) => (j === i ? { ...o, [k]: val } : o)));

  return (
    <div className="page narrow">
      <PageHead
        title={role === "BUYER" ? "Open a buying agent" : "Open a selling agent"}
        sub={
          role === "BUYER"
            ? "Your agent joins other buyers that want the same GPU, prepays your max from its budget, and pays the round's one clearing price. The rest stays in its balance for you to withdraw."
            : "Your agent bids sealed prices on coalitions it can serve, never below your minimum. When it wins and delivery is verified, escrow pays your wallet."
        }
      />
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={role === "BUYER"} className={role === "BUYER" ? "on" : ""} onClick={() => setQ({ role: "buyer" })}>
          <User width={16} /> Buying agent
        </button>
        <button role="tab" aria-selected={role === "SELLER"} className={role === "SELLER" ? "on" : ""} onClick={() => setQ({ role: "seller" })}>
          <Store width={16} /> Selling agent
        </button>
      </div>

      <div className="card pad form">
        <label className="field">
          <span>Agent name</span>
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder={role === "BUYER" ? "e.g. alice-training" : "e.g. gpu-farm-1"} maxLength={maxLen} autoComplete="off" />
          <small className="mono ellipsis">{agentId || `<name>.${meta?.contractId ?? "contract"}`}</small>
          {taken && <small className="err">That name is taken.</small>}
        </label>

        {role === "BUYER" ? (
          <>
            <div className="fields-3">
              <label className="field">
                <span>GPU</span>
                <select className="select" value={gpu} onChange={(e) => setGpu(e.target.value as GpuModel)}>
                  {GPU_MODELS.map((g) => <option key={g}>{g}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Min VRAM (GB)</span>
                <input inputMode="numeric" value={vram} onChange={(e) => setVram(e.target.value)} />
              </label>
              <label className="field">
                <span>GPU-hours</span>
                <input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />
              </label>
            </div>
            <div className="fields-3">
              <label className="field">
                <span>Max price per GPU-hour (NEAR)</span>
                <input inputMode="decimal" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
              </label>
              <label className="field">
                <span>Deadline</span>
                <select className="select" value={deadlineH} onChange={(e) => setDeadlineH(Number(e.target.value))}>
                  {DEADLINES.map((h) => <option key={h} value={h}>{h < 48 ? `${h} hours` : `${h / 24} days`} from now</option>)}
                </select>
              </label>
              <label className="field">
                <span>Budget to deposit (NEAR)</span>
                <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder={near((v as { prepay?: bigint }).prepay ?? 0n).replace(" NEAR", "")} />
              </label>
            </div>
            <p className="small muted">
              To join a round, the agent must hold at least hours × max price ({near((v as { prepay?: bigint }).prepay ?? 0n)}). It pays only hours × the clearing price; the
              difference returns to its balance.
            </p>
          </>
        ) : (
          <>
            <div className="field">
              <span>GPU offers (up to 4)</span>
              {offers.map((o, i) => (
                <div className="offer-row" key={i}>
                  <select className="select" value={o.gpu_model} onChange={(e) => setOffer(i, "gpu_model", e.target.value)} aria-label="GPU model">
                    {GPU_MODELS.map((g) => <option key={g}>{g}</option>)}
                  </select>
                  <input inputMode="numeric" value={o.vram_gb} onChange={(e) => setOffer(i, "vram_gb", e.target.value)} aria-label="VRAM GB" placeholder="VRAM GB" />
                  <input inputMode="numeric" value={o.capacity_hours} onChange={(e) => setOffer(i, "capacity_hours", e.target.value)} aria-label="Capacity hours" placeholder="Capacity h" />
                  {offers.length > 1 && (
                    <button className="linkish" onClick={() => setOffers((os) => os.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
              {offers.length < 4 && (
                <button className="linkish" onClick={() => setOffers((os) => [...os, { gpu_model: "H100", vram_gb: "80", capacity_hours: "50" }])}>
                  + Add an offer
                </button>
              )}
              <small className="faint">GPU model · VRAM in GB · GPU-hours you can serve per round</small>
            </div>
            <label className="field">
              <span>Minimum price per GPU-hour (NEAR)</span>
              <input inputMode="decimal" value={minPrice} onChange={(e) => setMinPrice(e.target.value)} />
              <small className="faint">The contract rejects any bid of yours below this.</small>
            </label>
            <div className="field">
              <span>Pricing strategy</span>
              <label className="radio">
                <input type="radio" checked={strategy === "AT_MINIMUM"} onChange={() => setStrategy("AT_MINIMUM")} /> Bid my minimum price
              </label>
              <label className="radio">
                <input type="radio" checked={strategy === "BELOW_CEILING"} onChange={() => setStrategy("BELOW_CEILING")} /> Bid
                <input className="inline-num" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} disabled={strategy !== "BELOW_CEILING"} />% below the
                coalition's price ceiling, but never below my minimum
              </label>
            </div>
          </>
        )}

        <div className="summary">
          <div className="spread">
            <span>Opening fee</span>
            <span>{openFee !== null ? near(openFee) : "–"}</span>
          </div>
          {role === "BUYER" && (
            <div className="spread">
              <span>Budget</span>
              <span>{near((v as { budget?: bigint }).budget ?? 0n)}</span>
            </div>
          )}
          <div className="spread total">
            <span>You send</span>
            <b>{total !== null ? near(total) : "–"}</b>
          </div>
          <p className="small faint">
            Of the fee, {meta?.agentGasFund ? near(meta.agentGasFund) : "–"} goes to the agent's own account to pay for its transactions; the rest covers its storage in the contract.
            {role === "BUYER" ? " You can withdraw the budget at any time it isn't reserved in a round." : ""}
          </p>
        </div>

        {error && <div className="err small">{error}</div>}
        {!error && v.errs.length > 0 && name && <div className="small warn-text">{v.errs[0]}</div>}
        <div className="row">
          <button className="btn primary" onClick={() => void submit()} disabled={busy || !meta || (!!accountId && v.errs.length > 0)}>
            {busy ? "Waiting for your wallet…" : accountId ? `Open agent and send ${total !== null ? near(total) : ""}` : "Connect wallet to continue"}
          </button>
          <Link to="/" className="small">Cancel</Link>
        </div>
        <p className="small faint">
          The market host creates this agent's key and keeps it encrypted; only the public key reaches your wallet and the chain. That key can only call the marketplace's agent
          actions (prepay, bid, reveal, withdraw to you), never move your money anywhere else.
        </p>
      </div>
    </div>
  );
}
