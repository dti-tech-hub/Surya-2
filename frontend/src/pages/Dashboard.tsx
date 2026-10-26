import React, { useCallback, useEffect, useState } from "react";
import {
  api, formatEth, formatTime,
  type CampaignDetail, type CampaignSummary,
  type IndexerStatus, type ReadyChecks, type StatsData,
} from "../api";
import {
  MOCK_CAMPAIGNS, MOCK_CAMPAIGN_DETAIL, MOCK_STATS,
  MOCK_INDEXER, MOCK_READY,
} from "../mock";

/* ─── Types ─── */
type View = "overview" | "campaigns" | "gasMetrics" | "mlMetrics" | "security" | "attacks";

/* ─── Gas benchmark data (from benchmarks/results/bench-hardhat.csv) ─── */
const GAS_DATA = [
  { op: "createCampaign",     median: 2_096_539, avg: 2_444_146, l1Usd: 52.41,  l2Usd: 0.000052  },
  { op: "submitEvidence",     median: 163_749,   avg: 164_216,   l1Usd: 4.09,   l2Usd: 0.000004  },
  { op: "resolveMilestone",   median: 157_543,   avg: 131_042,   l1Usd: 3.94,   l2Usd: 0.000004  },
  { op: "castVote",           median: 97_157,    avg: 76_904,    l1Usd: 2.43,   l2Usd: 0.000002  },
  { op: "claimRefund",        median: 79_156,    avg: 79_156,    l1Usd: 1.98,   l2Usd: 0.000002  },
  { op: "claimCreatorBalance",median: 57_144,    avg: 56_786,    l1Usd: 1.43,   l2Usd: 0.000001  },
  { op: "contribute",         median: 40_707,    avg: 136_502,   l1Usd: 1.02,   l2Usd: 0.000001  },
];

/* ─── ML metrics (from ml-service/models/metrics.json) ─── */
const ML_DATA = [
  {
    name: "Isolation Forest", type: "Unsupervised",
    precision: 0.5928, recall: 0.5939, f1: 0.5933, roc: 0.6614, pr: 0.6317,
    color: "#a78bfa",
    tn: 420, fp: 226, fn: 225, tp: 329,
    note: "Cold-start baseline — never sees labels.",
  },
  {
    name: "Logistic Regression", type: "Supervised",
    precision: 0.9176, recall: 0.9242, f1: 0.9209, roc: 0.9849, pr: 0.9837,
    color: "#60a5fa",
    tn: 600, fp: 46, fn: 42, tp: 512,
    note: "Strong linear baseline with 92.67% accuracy.",
  },
  {
    name: "Random Forest", type: "Supervised",
    precision: 0.9731, recall: 0.9801, f1: 0.9766, roc: 0.9978, pr: 0.9974,
    color: "#34d399",
    tn: 631, fp: 15, fn: 11, tp: 543,
    note: "Best overall: F1 = 0.977, ROC-AUC = 0.998.",
  },
];

/* ─── Attack sim data ─── */
const ATTACK_DATA = [
  {
    id: "A",
    name: "Sybil Staking Attack",
    desc: "Attacker spawns funded Sybil identities to flip a 5-verifier panel.",
    params: [
      ["Honest verifiers","5"], ["Stake/identity","1.0 ETH"],
      ["Quorum","50%"], ["Threshold","60%"],
    ],
    result: "Tipping point at 8 Sybils (8.0 ETH = $20,000). Identity count alone confers zero leverage.",
    outcome: "thwarted",
    capital: "$20,000",
  },
  {
    id: "B",
    name: "Creator–Verifier Collusion",
    desc: "2 corrupt verifiers vote Approve on deficient evidence while 3 honest verifiers reject.",
    params: [
      ["Honest verifiers","3"], ["Corrupt verifiers","2"],
      ["Stake/verifier","1.0 ETH"], ["Slash rate","20%"],
    ],
    result: "0 wei released. Colluders slashed 0.2 ETH each — collusion is economically negative.",
    outcome: "thwarted",
    capital: "−0.2 ETH each",
  },
  {
    id: "C",
    name: "Dispute Griefing Spam",
    desc: "Attacker spams rapid consecutive disputes to lock all campaign milestones.",
    params: [
      ["Bond","0.05 ETH"], ["Cooldown","24 hours"],
      ["Milestones targeted","3"],
    ],
    result: "1 dispute opened; 2 blocked by per-campaign cooldown. Attacker locked 0.05 ETH ($125).",
    outcome: "bounded",
    capital: "0.05 ETH locked",
  },
];

/* ─── Helpers ─── */
function pct(value: number): string { return `${(value * 100).toFixed(1)}%`; }
function shortAddr(a: string) { return `${a.slice(0,6)}…${a.slice(-4)}`; }

function progress(contributed: string, goal: string): number {
  const c = BigInt(contributed);
  const g = BigInt(goal);
  if (g === 0n) return 0;
  return Math.min(100, Number((c * 100n) / g));
}

function StatCard({
  label, value, sub, icon, color,
}: {
  label: string; value: string | number; sub?: string; icon?: string; color?: string;
}) {
  return (
    <div className="stat-card" style={{ "--accent-color": color } as React.CSSProperties}>
      {icon && <div className="icon">{icon}</div>}
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

function ProgressBar({ pct: p, color }: { pct: number; color?: string }) {
  return (
    <div className="progress-bar">
      <div
        className="progress-fill"
        style={{ width: `${p}%`, background: color }}
      />
    </div>
  );
}

/* ─── Views ─── */

function OverviewView({
  stats, indexer, campaigns,
}: {
  stats: StatsData | null;
  indexer: IndexerStatus | null;
  campaigns: CampaignSummary[];
}) {
  const totalRaisedEth = stats ? formatEth(stats.totalRaisedWei) : "—";
  const sparkValues = [3, 5, 4, 7, 6, 9, 8, 12, 10, 14];
  void sparkValues; // reserved for chart

  return (
    <div className="section">
      <div className="section-title">Protocol Overview</div>

      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <StatCard
          label="Total Campaigns"
          value={stats?.campaigns ?? "…"}
          sub={`${stats?.byState?.Active ?? 0} active · ${stats?.byState?.Completed ?? 0} completed`}
          icon="🏗️"
          color="#3b82f6"
        />
        <StatCard
          label="Total Raised"
          value={totalRaisedEth}
          sub="across all campaigns"
          icon="⬡"
          color="#34d399"
        />
        <StatCard
          label="Events Indexed"
          value={indexer?.eventsIndexed ?? "…"}
          sub={`chain ID ${indexer?.chainId ?? "…"} · block ${indexer?.confirmedThrough ?? "…"}`}
          icon="📡"
          color="#a78bfa"
        />
        <StatCard
          label="Contracts Monitored"
          value={indexer ? Object.keys(indexer.cursors).length : "…"}
          sub="Factory · Verifier · Reputation · Disputes"
          icon="🔐"
          color="#fbbf24"
        />
        <StatCard
          label="Smart Contract Tests"
          value="103"
          sub="88.7% line coverage"
          icon="✅"
          color="#34d399"
        />
        <StatCard
          label="Security Findings"
          value="0 High"
          sub="2 fixed (H1 + H2) · Slither 0.11.6"
          icon="🛡️"
          color="#f87171"
        />
      </div>

      <div className="section-title" style={{ marginTop: 24 }}>Campaign State Distribution</div>
      <div style={{ display: "flex", gap: 14, marginBottom: 28, flexWrap: "wrap" }}>
        {[
          { label: "Funding",   color: "#60a5fa", count: stats?.byState?.Funding ?? 0 },
          { label: "Active",    color: "#34d399", count: stats?.byState?.Active ?? 0 },
          { label: "Completed", color: "#a78bfa", count: stats?.byState?.Completed ?? 0 },
          { label: "Failed",    color: "#f87171", count: stats?.byState?.Failed ?? 0 },
        ].map(({ label, color, count }) => (
          <div
            key={label}
            style={{
              background: "var(--panel)", border: "1px solid var(--line)",
              borderRadius: 10, padding: "14px 20px", minWidth: 120, flex: "1 1 100px",
              borderLeft: `4px solid ${color}`,
            }}
          >
            <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color }}>{count}</div>
          </div>
        ))}
      </div>

      <div className="section-title">Gas Cost at a Glance (L1 vs L2)</div>
      <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
        <table className="gas-table">
          <thead>
            <tr>
              <th>Operation</th>
              <th>Median Gas</th>
              <th>L1 Cost</th>
              <th>L2 Cost</th>
              <th style={{ width: 130 }}>Bar (vs max)</th>
            </tr>
          </thead>
          <tbody>
            {GAS_DATA.slice(0, 4).map((row) => (
              <tr key={row.op}>
                <td style={{ fontFamily: "Consolas,monospace", fontSize: 12 }}>{row.op}</td>
                <td>{row.median.toLocaleString()}</td>
                <td style={{ color: "#f87171" }}>\${row.l1Usd.toFixed(2)}</td>
                <td style={{ color: "#34d399" }}>\$≈0</td>
                <td className="gas-bar-cell">
                  <div className="gas-bar-wrap">
                    <div
                      className="gas-bar-fill"
                      style={{ width: `${(row.median / 2_100_000) * 100}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-title">Recent Campaigns</div>
      <div className="campaigns-grid">
        {campaigns.slice(0, 3).map((c) => (
          <CampaignCardMini key={c.address} campaign={c} onOpen={() => {}} />
        ))}
      </div>
    </div>
  );
}

function CampaignCardMini({
  campaign, onOpen,
}: {
  campaign: CampaignSummary; onOpen: (a: string) => void;
}) {
  const p = progress(campaign.totalContributed, campaign.goalWei);
  const band = (campaign.risk?.band ?? "").toLowerCase();
  const stateClass = `state-${campaign.state.toLowerCase()}`;

  return (
    <div className="campaign-card" onClick={() => onOpen(campaign.address)}>
      <div className="cam-head">
        <span className={`cam-state ${stateClass}`}>{campaign.state}</span>
        {campaign.risk && (
          <span className={`risk-badge risk-${band}`}>
            {campaign.risk.score.toFixed(0)} · {campaign.risk.band}
          </span>
        )}
      </div>
      <div className="cam-addr">{shortAddr(campaign.address)}</div>
      <div className="progress-wrap">
        <div className="progress-label">
          <span>{formatEth(campaign.totalContributed)}</span>
          <span>{p}%</span>
        </div>
        <ProgressBar pct={p} />
      </div>
      <div className="cam-meta">
        <span>Goal: {formatEth(campaign.goalWei)}</span>
        <span>📅 {formatTime(campaign.fundingDeadline)}</span>
      </div>
    </div>
  );
}

function CampaignsView({
  campaigns, onOpen,
}: {
  campaigns: CampaignSummary[]; onOpen: (a: string) => void;
}) {
  const [filter, setFilter] = useState("All");
  const states = ["All", "Funding", "Active", "Completed", "Failed"];
  const filtered = filter === "All" ? campaigns : campaigns.filter((c) => c.state === filter);

  return (
    <div className="section">
      <div className="section-title">All Campaigns</div>

      <div className="tabs">
        {states.map((s) => (
          <button key={s} className={`tab${filter === s ? " active" : ""}`} onClick={() => setFilter(s)}>
            {s}
            {s !== "All" && (
              <span style={{ marginLeft: 5, opacity: .6, fontSize: 11 }}>
                ({campaigns.filter((c) => c.state === s).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">🔍</div>
          No campaigns in state "{filter}"
        </div>
      ) : (
        <div className="campaigns-grid">
          {filtered.map((c) => (
            <CampaignCardMini key={c.address} campaign={c} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

function CampaignDetailPane({
  detail, onBack,
}: {
  detail: CampaignDetail; onBack: () => void;
}) {
  const p = progress(detail.totalContributed, detail.goalWei);
  const milestones = detail.milestones as Array<Record<string, unknown>>;
  const disputes = detail.disputes as Array<Record<string, unknown>>;

  return (
    <div className="detail-pane">
      <button className="back-btn" onClick={onBack}>← Back to Campaigns</button>

      <div className="detail-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className={`cam-state state-${detail.state.toLowerCase()}`}>{detail.state}</span>
            {detail.risk && (
              <span className={`risk-badge risk-${detail.risk.band.toLowerCase()}`}>
                Risk {detail.risk.score.toFixed(1)} · {detail.risk.band}
              </span>
            )}
          </div>
          <div className="detail-address">{detail.address}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{formatEth(detail.totalContributed)}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>of {formatEth(detail.goalWei)} goal</div>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <div className="progress-label">
          <span style={{ color: "var(--muted)", fontSize: 12 }}>Funding Progress</span>
          <span style={{ fontWeight: 700 }}>{p}%</span>
        </div>
        <div style={{ height: 10, background: "var(--line)", borderRadius: 5, overflow: "hidden" }}>
          <div
            style={{
              height: "100%", borderRadius: 5,
              width: `${p}%`,
              background: p >= 100 ? "var(--green)" : "linear-gradient(90deg,#3b82f6,#34d399)",
            }}
          />
        </div>
      </div>

      <div className="detail-grid">
        <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, padding: 16 }}>
          <div className="section-title" style={{ marginBottom: 12 }}>Campaign Info</div>
          <table className="info-table">
            <tbody>
              <tr><th>Creator</th><td className="mono">{shortAddr(detail.creator)}</td></tr>
              <tr><th>Goal</th><td>{formatEth(detail.goalWei)}</td></tr>
              <tr><th>Raised</th><td>{formatEth(detail.totalContributed)}</td></tr>
              <tr><th>Released</th><td>{formatEth(detail.totalReleased)} ({(detail.releasedBps / 100).toFixed(0)}%)</td></tr>
              <tr><th>Contributors</th><td>{detail.contributors}</td></tr>
              <tr><th>Deadline</th><td>{formatTime(detail.fundingDeadline)}</td></tr>
            </tbody>
          </table>
        </div>

        <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, padding: 16 }}>
          <div className="section-title" style={{ marginBottom: 12 }}>Milestones ({milestones.length})</div>
          {milestones.length === 0 ? (
            <div style={{ color: "var(--muted)", fontSize: 13 }}>No milestones</div>
          ) : (
            <ul className="milestone-list">
              {milestones.map((m, i) => {
                const state = String(m.state ?? "Pending").toLowerCase();
                const stateClass = `ms-${state === "verified" ? "verified" : state === "rejected" ? "rejected" : state === "submitted" ? "submitted" : "pending"}`;
                return (
                  <li key={i} className="milestone-item">
                    <span className="ms-index">#{i}</span>
                    <div className="ms-body">
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                        <span className={`ms-state ${stateClass}`}>{String(m.state ?? "Pending")}</span>
                        <span style={{ fontSize: 12, color: "var(--muted)" }}>
                          {Number(m.trancheBps ?? 0) / 100}% of escrow
                        </span>
                      </div>
                      {Boolean(m.evidenceCID) ? (
                        <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "Consolas" }}>
                          CID: {String(m.evidenceCID).slice(0, 20)}…
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, padding: 16 }}>
        <div className="section-title" style={{ marginBottom: 12 }}>
          Disputes ({disputes.length})
        </div>
        {disputes.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 0" }}>
            ✅ No active disputes for this campaign.
          </div>
        ) : (
          <pre className="dump">{JSON.stringify(disputes, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}

function GasMetricsView() {
  const maxGas = Math.max(...GAS_DATA.map((d) => d.median));

  return (
    <div className="section">
      <div className="section-title">Gas Benchmarks</div>
      <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>
        Measured on Hardhat local EVM (Solidity 0.8.20, optimizer 200 runs, viaIR: true) across 5 independent
        samples. Costs modeled at <strong>10 gwei / $2,500 ETH</strong> (L1 Sepolia) and{" "}
        <strong>0.05 gwei / $0.50 MATIC</strong> (L2 Polygon Amoy).
      </div>

      <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden", marginBottom: 24 }}>
        <table className="gas-table">
          <thead>
            <tr>
              <th>Operation</th>
              <th>Median Gas</th>
              <th>Avg Gas</th>
              <th>L1 Cost (USD)</th>
              <th>L2 Cost (USD)</th>
              <th style={{ width: 140 }}>% of Max</th>
            </tr>
          </thead>
          <tbody>
            {GAS_DATA.map((row) => (
              <tr key={row.op}>
                <td style={{ fontFamily: "Consolas,monospace", fontSize: 12 }}>{row.op}</td>
                <td style={{ color: "var(--text)" }}>{row.median.toLocaleString()}</td>
                <td style={{ color: "var(--muted)", fontSize: 12 }}>{row.avg.toLocaleString()}</td>
                <td style={{ color: "#f87171", fontWeight: 600 }}>\${row.l1Usd.toFixed(2)}</td>
                <td style={{ color: "#34d399", fontWeight: 600 }}>\$≈0</td>
                <td className="gas-bar-cell">
                  <div className="gas-bar-wrap">
                    <div
                      className="gas-bar-fill"
                      style={{ width: `${(row.median / maxGas) * 100}%` }}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="section-title">Key Finding: L1 vs L2</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        <div
          style={{
            flex: "1 1 280px", background: "rgba(248,113,113,.06)",
            border: "1px solid rgba(248,113,113,.2)", borderRadius: 12, padding: 20,
          }}
        >
          <div style={{ fontSize: 13, color: "#f87171", fontWeight: 600, marginBottom: 8 }}>⚠️ Ethereum L1 (Sepolia)</div>
          <div style={{ fontSize: 32, fontWeight: 700, color: "#f87171" }}>$52.41</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>
            createCampaign ≈ <strong>1,048%</strong> of a $5 pledge.
            L1 is <strong>not viable</strong> for micro-crowdfunding.
          </div>
        </div>
        <div
          style={{
            flex: "1 1 280px", background: "rgba(52,211,153,.06)",
            border: "1px solid rgba(52,211,153,.2)", borderRadius: 12, padding: 20,
          }}
        >
          <div style={{ fontSize: 13, color: "#34d399", fontWeight: 600, marginBottom: 8 }}>✅ Polygon Amoy L2</div>
          <div style={{ fontSize: 32, fontWeight: 700, color: "#34d399" }}>$0.000052</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 6 }}>
            createCampaign ≈ <strong>0.001%</strong> of a $5 pledge.
            ~<strong>1,000,000×</strong> cheaper than L1.
          </div>
        </div>
        <div
          style={{
            flex: "1 1 280px", background: "rgba(59,130,246,.06)",
            border: "1px solid rgba(59,130,246,.2)", borderRadius: 12, padding: 20,
          }}
        >
          <div style={{ fontSize: 13, color: "#60a5fa", fontWeight: 600, marginBottom: 8 }}>ℹ️ Benchmark Scope</div>
          <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
            Execution gas is chain-state-independent and measured locally.
            L2 figures <em>exclude</em> L1 data-availability calldata charges (rollup DA cost).
            Treat L2 costs as an optimistic lower bound.
          </div>
        </div>
      </div>
    </div>
  );
}

function MlMetricsView() {
  return (
    <div className="section">
      <div className="section-title">ML Fraud Detection</div>
      <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>
        Trained and evaluated on <strong>N = 4,000</strong> synthetic campaigns (2,800 train / 1,200 test),
        with overlapping feature distributions and <strong>4% injected label noise</strong> to simulate
        real-world reporting error. Fraud contamination rate: <strong>46.18%</strong>.
      </div>

      <div className="ml-models">
        {ML_DATA.map((m) => (
          <div className="ml-card" key={m.name} style={{ borderTop: `3px solid ${m.color}` }}>
            <div className="ml-name">
              {m.name}
              <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400, marginLeft: 8 }}>
                {m.type}
              </span>
            </div>

            {([ ["Precision", m.precision], ["Recall", m.recall], ["F1-Score", m.f1], ["ROC-AUC", m.roc] ] as [string, number][]).map(([label, val]) => (
              <div key={label} className="ml-metric">
                <div>
                  <div className="ml-label">{label}</div>
                  <div className="ml-bar" style={{ width: 140 }}>
                    <div className="ml-bar-fill" style={{ width: `${val * 100}%`, background: m.color }} />
                  </div>
                </div>
                <div className="ml-val" style={{ color: m.color }}>{pct(val)}</div>
              </div>
            ))}

            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {([["TP", m.tp, "#34d399"], ["FP", m.fp, "#f87171"], ["TN", m.tn, "#34d399"], ["FN", m.fn, "#f87171"]] as [string, number, string][]).map(([label, val, color]) => (
                <div key={label} style={{ background: "var(--panel2)", borderRadius: 6, padding: "6px 10px", textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color }}>{val}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{label}</div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 12, fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
              {m.note}
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 20, background: "rgba(251,191,36,.06)", border: "1px solid rgba(251,191,36,.2)", borderRadius: 10, padding: 16, fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
        <strong style={{ color: "#fbbf24" }}>⚠️ Caveat:</strong> These metrics measure recovery of injected
        synthetic signal, <em>not real-world crowdfunding fraud</em>. Isolation Forest near-chance (F1 ≈ 0.59)
        is the useful cold-start result: it never sees labels, which is the actual deployment condition for new campaigns.
      </div>
    </div>
  );
}

function SecurityView() {
  return (
    <div className="section">
      <div className="section-title">Static Security Analysis</div>
      <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 20 }}>
        Slither 0.11.6 · 102 detectors · run via crytic-compile on the Hardhat project.
      </div>

      <div className="severity-grid" style={{ marginBottom: 24 }}>
        {[
          { label: "High",          before: 2,  after: 0,  cls: "sev-high"   },
          { label: "Medium",        before: 8,  after: 10, cls: "sev-medium" },
          { label: "Low",           before: 34, after: 32, cls: "sev-low"    },
          { label: "Informational", before: 12, after: 12, cls: "sev-info"   },
          { label: "Optimization",  before: 7,  after: 6,  cls: "sev-info"   },
          { label: "Total",         before: 63, after: 60, cls: ""           },
        ].map(({ label, before, after, cls }) => (
          <div className="sev-card" key={label}>
            <div className={`sev-count ${cls}`}>{after}</div>
            <div className="sev-label">{label}</div>
            <div className="sev-before">was {before} → now {after}</div>
          </div>
        ))}
      </div>

      <div className="section-title">High Findings — Both Fixed</div>
      <div className="vuln-list">
        <div className="vuln-card">
          <div className="vuln-head">
            <span className="vuln-id">H1</span>
            <span className="vuln-title">arbitrary-send-eth · Campaign.sweepDust(address)</span>
            <span className="vuln-fixed">✅ FIXED</span>
          </div>
          <div className="vuln-desc">
            <strong>Bug:</strong> sweepDust() accepted the payout destination as a parameter.
            Any caller could pass their own address to drain accrued wei dust despite NatSpec claiming funds go to treasury.
            <br /><br />
            <strong>Fix:</strong> Parameter removed. treasury is now an immutable address set in the constructor.
            Regression test in Security.regression.test.ts asserts zero-argument interface.
          </div>
        </div>
        <div className="vuln-card">
          <div className="vuln-head">
            <span className="vuln-id">H2</span>
            <span className="vuln-title">reentrancy-eth + pool drain · DisputeResolution.settleJuror</span>
            <span className="vuln-fixed">✅ FIXED</span>
          </div>
          <div className="vuln-desc">
            <strong>Three compounding defects:</strong>
            (1) CEI violation — casesCorrect incremented after ETH transfer,
            (2) No reentrancy guard,
            (3) Reward = totalBondEscrow / 100 (flat 1% of the global pool) — a juror in N disputes could drain ~N% of the entire escrow.
            <br /><br />
            <strong>Fix:</strong> Added OpenZeppelin ReentrancyGuard (nonReentrant), strict CEI ordering,
            and isolated reward accounting to d.bondEscrowed (this dispute's bond only), distributed
            pro-rata by weight: reward = (d.bondEscrowed × 50%) × (myWeight / majorityWeight).
          </div>
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 24 }}>Test Coverage</div>
      <div style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
        <table className="gas-table">
          <thead>
            <tr><th>Contract</th><th>Tests</th><th>Line Coverage</th><th>Progress</th></tr>
          </thead>
          <tbody>
            {[
              ["Campaign.sol", 26, 89.2],
              ["MilestoneVerifier.sol", 23, 83.9],
              ["ReputationRegistry.sol", 10, 94.8],
              ["CampaignFactory.sol", 5, 96.3],
              ["DisputeResolution.sol", 29, 96.3],
              ["CredentialRegistry.sol", 10, 77.4],
            ].map(([name, tests, pct]) => (
              <tr key={String(name)}>
                <td style={{ fontFamily: "Consolas,monospace", fontSize: 12 }}>{name}</td>
                <td>{tests}</td>
                <td style={{ fontWeight: 600, color: Number(pct) >= 90 ? "#34d399" : "#fbbf24" }}>
                  {pct}%
                </td>
                <td style={{ width: 140 }}>
                  <div className="gas-bar-wrap">
                    <div className="gas-bar-fill" style={{ width: `${pct}%`, background: Number(pct) >= 90 ? "#34d399" : "#fbbf24" }} />
                  </div>
                </td>
              </tr>
            ))}
            <tr style={{ borderTop: "2px solid var(--line)", fontWeight: 600 }}>
              <td>Total</td><td>103</td>
              <td style={{ color: "#60a5fa" }}>88.7%</td>
              <td><div className="gas-bar-wrap"><div className="gas-bar-fill" style={{ width: "88.7%" }} /></div></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AttacksView() {
  return (
    <div className="section">
      <div className="section-title">Game-Theoretic Attack Simulations</div>
      <div style={{ color: "var(--muted)", fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>
        Run by evaluation/attack-simulations.ts against the local Hardhat EVM.
        All results are deterministic and committed to evaluation/results/attack-simulations.json.
      </div>

      <div className="attack-list">
        {ATTACK_DATA.map((a) => (
          <div className="attack-card" key={a.id}>
            <div className="attack-head">
              <div>
                <span style={{ fontSize: 12, color: "var(--muted)", marginRight: 10 }}>
                  Scenario {a.id}
                </span>
                <span className="attack-name">{a.name}</span>
              </div>
              <span
                className={`attack-result ${a.outcome === "thwarted" || a.outcome === "bounded" ? "attack-thwarted" : "attack-failed"}`}
              >
                {a.outcome === "thwarted" ? "✅ Thwarted" : a.outcome === "bounded" ? "🔒 Bounded" : "❌ Exploited"}
              </span>
            </div>

            <div className="attack-desc">{a.desc}</div>

            <div className="attack-params">
              {a.params.map(([k, v]) => (
                <span key={k} className="attack-param">
                  {k}: <strong>{v}</strong>
                </span>
              ))}
              <span className="attack-param">
                Attacker cost: <strong>{a.capital}</strong>
              </span>
            </div>

            <div
              style={{
                marginTop: 12, padding: "10px 14px", borderRadius: 8,
                background: "rgba(52,211,153,.06)", border: "1px solid rgba(52,211,153,.15)",
                fontSize: 13, color: "var(--text)", lineHeight: 1.55,
              }}
            >
              <strong style={{ color: "#34d399" }}>Outcome: </strong>{a.result}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Status pill helper ─── */
function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`pill ${ok ? "ok" : "bad"}`}>
      <span className="pill-dot" />
      {label}
    </span>
  );
}

/* ─── Main Dashboard ─── */
export function Dashboard() {
  const [view, setView]             = useState<View>("overview");
  const [ready, setReady]           = useState<ReadyChecks | null>(null);
  const [stats, setStats]           = useState<StatsData | null>(null);
  const [indexer, setIndexer]       = useState<IndexerStatus | null>(null);
  const [campaigns, setCampaigns]   = useState<CampaignSummary[]>([]);
  const [selected, setSelected]     = useState<CampaignDetail | null>(null);
  const [error, setError]           = useState<string>("");
  const [backendOk, setBackendOk]   = useState<boolean | null>(null);
  const [credSubject, setCredSubject] = useState("");
  const [credResult, setCredResult]   = useState("");

  const refresh = useCallback(async () => {
    try {
      const [r, s, i, c] = await Promise.all([
        api.ready(), api.stats(), api.indexer(), api.campaigns(),
      ]);
      setReady(r);
      setStats(s.data);
      setIndexer(i.data);
      setCampaigns(c.data);
      setError("");
      setBackendOk(true);
    } catch {
      // Backend not running — fall back to realistic mock data
      setBackendOk(false);
      setReady(MOCK_READY);
      setStats(MOCK_STATS);
      setIndexer(MOCK_INDEXER);
      setCampaigns(MOCK_CAMPAIGNS);
      setError("");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  const openCampaign = useCallback(async (address: string) => {
    if (!backendOk) {
      // Return mock detail
      const found = MOCK_CAMPAIGNS.find((c) => c.address === address);
      setSelected(found ? { ...MOCK_CAMPAIGN_DETAIL, ...found } : MOCK_CAMPAIGN_DETAIL);
      setView("campaigns");
      return;
    }
    try {
      const d = await api.campaign(address);
      setSelected(d.data);
    } catch (e) {
      setError(`Campaign detail failed: ${(e as Error).message}`);
    }
  }, [backendOk]);

  const lookupCredentials = useCallback(async () => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(credSubject.trim())) {
      setCredResult("Enter a valid 0x address.");
      return;
    }
    if (!backendOk) {
      setCredResult(JSON.stringify({ subject: credSubject.trim(), credentials: [], canLaunchCampaign: false }, null, 2));
      return;
    }
    try {
      const r = await api.credentials(credSubject.trim());
      setCredResult(JSON.stringify(r.data, null, 2));
    } catch (e) {
      setCredResult(`lookup failed: ${(e as Error).message}`);
    }
  }, [credSubject, backendOk]);

  const navItems: { id: View; icon: string; label: string }[] = [
    { id: "overview",   icon: "🏠", label: "Overview"        },
    { id: "campaigns",  icon: "🏗️",  label: "Campaigns"       },
    { id: "gasMetrics", icon: "⛽",  label: "Gas Benchmarks"  },
    { id: "mlMetrics",  icon: "🤖",  label: "ML Metrics"      },
    { id: "attacks",    icon: "⚔️",  label: "Attack Sims"     },
    { id: "security",   icon: "🛡️",  label: "Security Audit"  },
  ];

  const renderContent = () => {
    if (selected && view === "campaigns") {
      return (
        <CampaignDetailPane
          detail={selected}
          onBack={() => setSelected(null)}
        />
      );
    }
    switch (view) {
      case "overview":   return <OverviewView stats={stats} indexer={indexer} campaigns={campaigns} />;
      case "campaigns":  return (
        <>
          <CampaignsView campaigns={campaigns} onOpen={openCampaign} />
          <div style={{ padding: "0 28px 24px" }}>
            <div className="section-title">Credential Lookup</div>
            <div className="cred-form">
              <input
                placeholder="0x creator address"
                value={credSubject}
                onChange={(e) => setCredSubject(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void lookupCredentials()}
              />
              <button onClick={() => void lookupCredentials()}>Check</button>
            </div>
            {credResult && <pre className="dump">{credResult}</pre>}
          </div>
        </>
      );
      case "gasMetrics": return <GasMetricsView />;
      case "mlMetrics":  return <MlMetricsView />;
      case "attacks":    return <AttacksView />;
      case "security":   return <SecurityView />;
    }
  };

  return (
    <div className="shell">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-logo">
          <h2>⬡ CrowdTrust</h2>
          <span>Blockchain Escrow</span>
        </div>
        {navItems.map((n) => (
          <div
            key={n.id}
            className={`nav-item${view === n.id ? " active" : ""}`}
            onClick={() => { setView(n.id); setSelected(null); }}
          >
            <span className="nav-icon">{n.icon}</span>
            {n.label}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ padding: "16px 20px", borderTop: "1px solid var(--line)" }}>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>Chain ID</div>
          <div style={{ fontFamily: "Consolas,monospace", fontSize: 13, color: "var(--blue)" }}>
            {indexer?.chainId ?? "31337"}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>Mode</div>
          <div style={{ fontSize: 12, color: backendOk === false ? "#fbbf24" : "#34d399" }}>
            {backendOk === false ? "📂 Demo (mock data)" : "🔴 Live"}
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="main-content">
        {/* Topbar */}
        <div className="topbar">
          <div>
            <div className="topbar-title">
              {navItems.find((n) => n.id === view)?.icon}{" "}
              {navItems.find((n) => n.id === view)?.label}
            </div>
          </div>
          <div className="topbar-right">
            <div className="statusbar">
              <StatusPill ok={ready?.checks.database?.ok ?? false} label={`DB: ${ready?.checks.database?.detail ?? "…"}`} />
              <StatusPill ok={ready?.checks.chain?.ok ?? false} label={`Chain: ${ready?.checks.chain?.detail ?? "…"}`} />
              <StatusPill ok={ready?.checks.ml?.ok ?? false} label={`ML: ${ready?.checks.ml?.detail ?? "…"}`} />
              <StatusPill ok={indexer?.running ?? false} label={`Indexer: ${indexer?.eventsIndexed ?? "…"} events`} />
            </div>
            <button className="refresh-btn" onClick={() => void refresh()}>
              🔄 Refresh
            </button>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {backendOk === false && (
          <div style={{
            background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.25)",
            borderRadius: 8, padding: "8px 28px", fontSize: 12, color: "#fbbf24",
            display: "flex", alignItems: "center", gap: 8,
          }}>
            📂 <strong>Demo mode</strong> — backend not detected at {api.base}.
            {" "}Showing realistic mock data. Run <code style={{ background: "rgba(0,0,0,.3)", padding: "1px 5px", borderRadius: 3 }}>cd backend && npm run dev</code> to connect live.
          </div>
        )}

        {renderContent()}
      </div>
    </div>
  );
}
