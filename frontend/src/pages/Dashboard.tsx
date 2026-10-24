import { useCallback, useEffect, useState } from "react";
import {
  api,
  formatEth,
  type CampaignDetail,
  type CampaignSummary,
  type IndexerStatus,
  type ReadyChecks,
  type StatsData,
} from "../api";
import { CampaignCard } from "../components/CampaignCard";
import { CampaignDetailView } from "../components/CampaignDetail";

const REFRESH_MS = 10_000;

export function Dashboard() {
  const [ready, setReady] = useState<ReadyChecks | null>(null);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [indexer, setIndexer] = useState<IndexerStatus | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [selected, setSelected] = useState<CampaignDetail | null>(null);
  const [credSubject, setCredSubject] = useState("");
  const [credResult, setCredResult] = useState<string>("");
  const [error, setError] = useState<string>("");

  const refresh = useCallback(async () => {
    try {
      const [r, s, i, c] = await Promise.all([
        api.ready(),
        api.stats(),
        api.indexer(),
        api.campaigns(),
      ]);
      setReady(r);
      setStats(s.data);
      setIndexer(i.data);
      setCampaigns(c.data);
      setError("");
    } catch (e) {
      setError(
        `Backend unreachable at ${api.base}: ${(e as Error).message}. Is the backend running (npm run dev, port 4000)?`
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const openCampaign = useCallback(async (address: string) => {
    try {
      const d = await api.campaign(address);
      setSelected(d.data);
      setError("");
    } catch (e) {
      setError(`Campaign detail failed: ${(e as Error).message}`);
    }
  }, []);

  const lookupCredentials = useCallback(async () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(credSubject.trim())) {
      setCredResult("Enter a valid 0x address.");
      return;
    }
    try {
      const r = await api.credentials(credSubject.trim());
      setCredResult(JSON.stringify(r.data, null, 2));
    } catch (e) {
      setCredResult(`lookup failed: ${(e as Error).message}`);
    }
  }, [credSubject]);

  return (
    <div className="app">
      <header className="top">
        <h1>
          Crowdfunding Trust Dashboard{" "}
          <small>chain {indexer?.chainId ?? "…"} · api {api.base}</small>
        </h1>
        <button className="ghost" onClick={() => void refresh()}>
          refresh
        </button>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="statusbar">
        <span className={`pill ${ready?.checks.database?.ok ? "ok" : "bad"}`}>
          db: {ready?.checks.database?.detail ?? "…"}
        </span>
        <span className={`pill ${ready?.checks.chain?.ok ? "ok" : "bad"}`}>
          chain: {ready?.checks.chain?.detail ?? "…"}
        </span>
        <span className={`pill ${ready?.checks.ml?.ok ? "ok" : "bad"}`}>
          ml: {ready?.checks.ml?.detail ?? "…"}
        </span>
        <span className={`pill ${indexer?.running ? "ok" : "bad"}`}>
          indexer: {indexer ? `${indexer.eventsIndexed} events · head ${indexer.headBlock}` : "…"}
        </span>
        {indexer?.lastError && (
          <span className="pill bad">indexer error: {indexer.lastError}</span>
        )}
      </div>

      {selected ? (
        <CampaignDetailView detail={selected} onBack={() => setSelected(null)} />
      ) : (
        <>
          <div className="grid">
            <div className="card">
              <h3>Campaigns</h3>
              <div className="big">{stats?.campaigns ?? "…"}</div>
              <div>
                <small>{JSON.stringify(stats?.byState ?? {})}</small>
              </div>
            </div>
            <div className="card">
              <h3>Total raised</h3>
              <div className="big">
                {stats ? formatEth(stats.totalRaisedWei) : "…"}
              </div>
            </div>
            <div className="card">
              <h3>Indexer cursors</h3>
              <div className="big">
                {indexer ? Object.keys(indexer.cursors).length : "…"}
              </div>
              <div>
                <small>
                  confirmed through block {indexer?.confirmedThrough ?? "…"}
                </small>
              </div>
            </div>
          </div>

          <h2>Campaigns</h2>
          {campaigns.length === 0 && <p>No campaigns indexed yet.</p>}
          <div className="grid">
            {campaigns.map((c) => (
              <CampaignCard key={c.address} campaign={c} onOpen={openCampaign} />
            ))}
          </div>

          <h2>Credential lookup</h2>
          <div className="card">
            <div style={{ display: "flex", gap: 8 }}>
              <input
                placeholder="0x subject address"
                value={credSubject}
                onChange={(e) => setCredSubject(e.target.value)}
              />
              <button onClick={() => void lookupCredentials()}>check</button>
            </div>
            {credResult && <pre className="dump">{credResult}</pre>}
          </div>
        </>
      )}
    </div>
  );
}
