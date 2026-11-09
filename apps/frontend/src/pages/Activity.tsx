import { Feed } from "./Rounds";
import { Empty, LoadState, PageHead } from "../components/ui";
import { useApi } from "../lib/api";
import type { Activity } from "../lib/types";

export function ActivityPage() {
  const a = useApi<Activity[]>("/api/activity?limit=200", 5000);
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
