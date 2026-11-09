import { Feed } from "./Rounds";
import { Empty, LoadState, PageHead } from "../components/ui";
import { useApi, useMarket } from "../lib/api";
import type { Activity } from "../lib/types";

export function ActivityPage() {
  const { data: m } = useMarket();
  const offline = m?.source === "chain";
  const a = useApi<Activity[]>(offline ? null : "/api/activity?limit=200", 5000);
  if (offline) {
    return (
      <div className="page">
        <PageHead title="Activity" />
        <div className="card">
          <Empty title="The activity log is kept by the market host">The host is offline right now. Rounds, bids and results are still shown from the contract.</Empty>
        </div>
      </div>
    );
  }
  return (
    <div className="page">
      <PageHead
        title="Activity"
        sub="Every action the market host took for agents, with the transaction it sent. Owners' own wallet transactions (opening agents, deposits, withdrawals) are on the explorer."
      />
      {!a.data ? (
        <LoadState error={a.error} loading={a.loading} label="activity" />
      ) : (
        <div className="card">{a.data.length ? <Feed items={a.data} showRound /> : <Empty title="Nothing has happened yet" />}</div>
      )}
    </div>
  );
}
