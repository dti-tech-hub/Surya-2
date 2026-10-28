import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  formatEth,
  formatTime,
  type AppConfig,
  type CampaignDetail,
  type CampaignSummary,
  type IndexerStatus,
  type ReadyChecks,
  type ResearchResults,
  type StatsData,
} from "../api";
import {
  campaignContract,
  connectDemoWallet,
  connectWallet,
  disputeContract,
  ensureChain,
  factoryContract,
  hashFile,
  verifierContract,
  type WalletConnection,
} from "../chain";
import { parseEther, keccak256, toUtf8Bytes } from "ethers";

type TabKey = "projects" | "create" | "howItWorks" | "results";

const STATE_FILTERS = ["All", "Active", "Funding", "Completed", "Failed"] as const;
const MILESTONE_STATES = ["Pending", "Submitted", "Verified", "Rejected"];

/** Reads a possibly-named property off an untyped row without crashing. */
function field(row: unknown, key: string): string {
  if (row && typeof row === "object" && key in row) {
    const v = (row as Record<string, unknown>)[key];
    if (v !== undefined && v !== null) return String(v);
  }
  return "";
}

function rowField(row: unknown, ...keys: string[]): string {
  for (const key of keys) {
    const value = field(row, key);
    if (value) return value;
  }
  return "";
}

function milestoneState(row: unknown): string {
  const raw = rowField(row, "state") || "Pending";
  if (/^\d+$/.test(raw)) return MILESTONE_STATES[Number(raw)] ?? "Pending";
  return raw;
}

function progressPct(contributed: string, goal: string): number {
  const c = BigInt(contributed || "0");
  const g = BigInt(goal || "0");
  if (g === 0n) return 0;
  return Number((c * 10_000n) / g) / 100;
}

function short(address: string): string {
  return address.length > 16 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
}

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<TabKey>("projects");
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [indexer, setIndexer] = useState<IndexerStatus | null>(null);
  const [ready, setReady] = useState<ReadyChecks | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  const [filterState, setFilterState] = useState<string>("All");
  const [selected, setSelected] = useState<CampaignDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    try {
      const [r, s, i, c] = await Promise.all([
        api.ready(), api.stats(), api.indexer(), api.campaigns(),
      ]);
      setReady(r);
      setStats(s.data);
      setIndexer(i.data);
      setCampaigns(c.data);
      setConnected(true);
      setError(null);
    } catch (e) {
      setConnected(false);
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadSummary();
    const timer = setInterval(() => void loadSummary(), 12_000);
    return () => clearInterval(timer);
  }, [loadSummary]);

  useEffect(() => {
    api.config().then((r) => setConfig(r.data)).catch(() => undefined);
  }, []);

  const openDetail = useCallback(async (address: string) => {
    setDetailError(null);
    try {
      const d = await api.campaign(address);
      setSelected({ ...d.data, address });
      setActiveTab("projects");
    } catch (e) {
      setDetailError((e as Error).message);
    }
  }, []);

  const connect = async () => {
    setWalletError(null);
    try {
      if (config) await ensureChain(config.chainId);
      setWallet(await connectWallet());
      void loadSummary();
    } catch (e) {
      setWalletError((e as Error).message);
    }
  };

  const connectDemo = async () => {
    setWalletError(null);
    try {
      setWallet(await connectDemoWallet());
      void loadSummary();
    } catch (e) {
      setWalletError((e as Error).message);
    }
  };

  const refreshDetail = useCallback(async () => {
    if (!selected) return;
    try {
      const d = await api.campaign(selected.address);
      setSelected({ ...d.data, address: selected.address });
      void loadSummary();
    } catch (e) {
      setDetailError((e as Error).message);
    }
  }, [selected, loadSummary]);

  const filtered = campaigns.filter((c) => filterState === "All" || c.state === filterState);
  const wrongChain =
    wallet && config && wallet.chainId !== config.chainId ? config.chainId : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-name">CrowdTrust</span>
            <span className="brand-sub">Milestone escrow · stake-weighted governance</span>
          </div>
          <div className="top-status">
            <span className={`status-dot ${connected ? "ok" : "err"}`} />
            <span>{connected ? "API connected" : "API offline"}</span>
            {indexer && (
              <span className="dim">
                · chain {indexer.chainId} · block {indexer.confirmedThrough}
              </span>
            )}
            {wallet ? (
              <span className="wallet-pill" title={wallet.address}>
                {short(wallet.address)}
              </span>
            ) : (
              <>
                <button className="btn primary" onClick={() => void connect()}>Connect MetaMask</button>
                <button className="btn" title="Local-only signing key used by `npx hardhat node` (account #0, 10,000 test ETH)." onClick={() => void connectDemo()}>
                  Use demo account
                </button>
              </>
            )}
            <button className="btn" onClick={() => void loadSummary()}>Refresh</button>
          </div>
        </div>
        <nav className="tabs">
          {([
            ["projects", "Projects"],
            ["create", "Create"],
            ["howItWorks", "How it works"],
            ["results", "Results"],
          ] as Array<[TabKey, string]>).map(([key, label]) => (
            <button
              key={key}
              className={`tab ${activeTab === key ? "active" : ""}`}
              onClick={() => { setActiveTab(key); if (key !== "projects") setSelected(null); }}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="content">
        {error && !connected && (
          <div className="notice">
            Backend not reachable ({error}). Start it with{" "}
            <code>cd backend &amp;&amp; npm run dev</code>, then refresh.
          </div>
        )}
        {walletError && <div className="notice">{walletError}</div>}
        {wrongChain !== null && (
          <div className="notice warn">
            Wallet is on chain {wallet?.chainId}; this deployment is on chain {wrongChain}.{" "}
            <button className="btn" onClick={() => config && void ensureChain(config.chainId)}>Switch chain</button>
          </div>
        )}

        {activeTab === "projects" && (
          selected ? (
            <CampaignPanel
              detail={selected}
              config={config}
              wallet={wallet}
              onBack={() => setSelected(null)}
              onRefresh={() => void refreshDetail()}
              error={detailError}
            />
          ) : (
            <>
              <div className="meta-line">
                {stats && (
                  <>
                    <span>{stats.campaigns} campaigns</span>
                    <span>·</span>
                    <span>{formatEth(stats.totalRaisedWei)} pledged</span>
                    <span>·</span>
                    <span>{stats.byState?.Active ?? 0} active, {stats.byState?.Completed ?? 0} completed, {stats.byState?.Failed ?? 0} failed</span>
                  </>
                )}
                {connected && ready && !ready.ready && (
                  <span className="warn">Readiness checks failing</span>
                )}
              </div>

              <div className="filter-row">
                {STATE_FILTERS.map((st) => (
                  <button
                    key={st}
                    className={`btn tab-mini ${filterState === st ? "active" : ""}`}
                    onClick={() => setFilterState(st)}
                  >
                    {st}
                  </button>
                ))}
              </div>

              {filtered.length === 0 ? (
                <div className="notice">
                  No campaigns indexed yet. Create one from the Create tab after connecting a wallet.
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>State</th>
                      <th>Raised / Goal</th>
                      <th>Progress</th>
                      <th>Released</th>
                      <th>Risk</th>
                      <th>Deadline</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => {
                      const pct = progressPct(c.totalContributed, c.goalWei);
                      return (
                        <tr key={c.address} className="clickable" onClick={() => void openDetail(c.address)}>
                          <td>
                            <span className="mono">{short(c.address)}</span>
                          </td>
                          <td><span className={`pill ${c.state.toLowerCase()}`}>{c.state}</span></td>
                          <td className="num">
                            {formatEth(c.totalContributed)} / {formatEth(c.goalWei)}
                          </td>
                          <td>
                            <div className="bar"><div style={{ width: `${Math.min(100, pct)}%` }} /></div>
                            <span className="dim small">{pct.toFixed(1)}%</span>
                          </td>
                          <td className="num">{(c.releasedBps / 100).toFixed(0)}%</td>
                          <td>
                            {c.risk ? (
                              <span className={`risk ${c.risk.band.toLowerCase()}`}>
                                {c.risk.score.toFixed(1)} ({c.risk.band})
                              </span>
                            ) : (
                              <span className="dim">—</span>
                            )}
                          </td>
                          <td className="small">{formatTime(c.fundingDeadline)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )
        )}

        {activeTab === "create" && (
          <CreateCampaign
            config={config}
            wallet={wallet}
            onCreated={(address) => void openDetail(address)}
          />
        )}

        {activeTab === "howItWorks" && <HowItWorks />}
        {activeTab === "results" && <Results />}
      </main>

      <footer className="footer">
        {config ? `Chain ${config.chainId} · evidence: ${config.evidence.provider}` : "Loading configuration"}
        {" · "}API <code>{api.base}</code>
      </footer>
    </div>
  );
}

interface CampaignPanelProps {
  detail: CampaignDetail;
  config: AppConfig | null;
  wallet: WalletConnection | null;
  onBack: () => void;
  onRefresh: () => void;
  error: string | null;
}

function CampaignPanel({ detail, config, wallet, onBack, onRefresh, error }: CampaignPanelProps) {
  const pct = progressPct(detail.totalContributed, detail.goalWei);
  const isCreator = Boolean(wallet && wallet.address.toLowerCase() === detail.creator.toLowerCase());
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [bond, setBond] = useState<bigint | null>(null);

  useEffect(() => {
    if (!config?.contracts.disputes || !wallet) return;
    disputeContract(config.contracts.disputes, wallet.signer)
      .disputeBond()
      .then((b: bigint) => setBond(b))
      .catch(() => undefined);
  }, [config, wallet]);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setMessage(null);
    setActionError(null);
    try {
      const tx = (await action()) as { hash?: string; wait?: () => Promise<unknown> };
      if (tx?.wait) await tx.wait();
      setMessage(`${label} confirmed${tx?.hash ? ` (${tx.hash.slice(0, 12)}…)` : ""}.`);
      onRefresh();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const contribute = async () => {
    if (!wallet) return;
    await run("Contribution", () =>
      campaignContract(detail.address, wallet.signer).contribute({ value: parseEther(amount) })
    );
  };

  const submitEvidence = async (index: number, file: File) => {
    if (!wallet) return;
    await run(`Evidence for milestone ${index + 1}`, async () => {
      const upload = await api.uploadEvidence(file);
      const digest = await hashFile(file);
      return campaignContract(detail.address, wallet.signer).submitEvidence(
        index,
        upload.data.cid,
        digest
      );
    });
  };

  const vote = async (index: number, choice: 0 | 1) => {
    if (!wallet || !config?.contracts.verifier) return;
    await run(`${choice === 1 ? "Approval" : "Rejection"} vote`, () =>
      verifierContract(config.contracts.verifier!, wallet.signer).castVote(
        detail.address,
        index,
        choice
      )
    );
  };

  const resolve = async (index: number) => {
    if (!wallet) return;
    await run(`Resolve milestone ${index + 1}`, () =>
      campaignContract(detail.address, wallet.signer).resolveMilestone(index)
    );
  };

  const raiseDispute = async (index: number) => {
    if (!wallet || !config?.contracts.disputes || bond === null) return;
    await run(`Dispute milestone ${index + 1}`, () =>
      disputeContract(config.contracts.disputes!, wallet.signer).raiseDispute(
        detail.address,
        index,
        { value: bond }
      )
    );
  };

  const resolveDispute = async (key: string) => {
    if (!wallet || !config?.contracts.disputes) return;
    await run("Resolve dispute", () =>
      disputeContract(config.contracts.disputes!, wallet.signer).resolve(key)
    );
  };

  const claimRefund = async () => {
    if (!wallet) return;
    await run("Refund claim", () => campaignContract(detail.address, wallet.signer).claimRefund());
  };

  const claimCreator = async () => {
    if (!wallet) return;
    await run("Creator withdrawal", () =>
      campaignContract(detail.address, wallet.signer).claimCreatorBalance()
    );
  };

  return (
    <section>
      <button className="btn" onClick={onBack}>← Back to projects</button>
      {error && <div className="notice">Could not load full detail: {error}</div>}

      <h2 className="mono title">{detail.address}</h2>
      <div className="meta-line">
        <span className={`pill ${detail.state.toLowerCase()}`}>{detail.state}</span>
        {detail.risk && (
          <span className={`risk ${detail.risk.band.toLowerCase()}`}>
            risk {detail.risk.score.toFixed(1)} ({detail.risk.band})
          </span>
        )}
        {isCreator && <span className="pill creator">you are the creator</span>}
      </div>

      <div className="bar tall"><div style={{ width: `${Math.min(100, pct)}%` }} /></div>

      <table className="kv">
        <tbody>
          <tr><th>Creator</th><td className="mono">{detail.creator}</td></tr>
          <tr><th>Goal</th><td>{formatEth(detail.goalWei)}</td></tr>
          <tr><th>Raised</th><td>{formatEth(detail.totalContributed)} ({pct.toFixed(1)}%)</td></tr>
          <tr><th>Released</th><td>{formatEth(detail.totalReleased)} ({(detail.releasedBps / 100).toFixed(0)}%)</td></tr>
          <tr><th>Contributors</th><td>{detail.contributors ?? "—"}</td></tr>
          <tr><th>Funding deadline</th><td>{formatTime(detail.fundingDeadline)}</td></tr>
        </tbody>
      </table>

      <div className="actions-panel">
        <h3>Actions</h3>
        {!wallet ? (
          <p className="dim">Connect MetaMask to contribute, submit evidence, vote, or resolve.</p>
        ) : (
          <>
            <div className="action-row">
              <label>Contribute</label>
              <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <span className="dim">ETH</span>
              <button className="btn primary" disabled={busy !== null} onClick={() => void contribute()}>
                {busy === "Contribution" ? "Sending…" : "Contribute"}
              </button>
            </div>
            <div className="action-row">
              <button
                className="btn"
                disabled={busy !== null || detail.state !== "Failed"}
                onClick={() => void claimRefund()}
              >
                Claim refund
              </button>
              <button
                className="btn"
                disabled={busy !== null || !isCreator}
                onClick={() => void claimCreator()}
              >
                Withdraw creator balance
              </button>
            </div>
            {bond !== null && (
              <p className="dim small">Dispute bond: {formatEth(bond)} per dispute.</p>
            )}
          </>
        )}
        {message && <div className="notice ok">{message}</div>}
        {actionError && <div className="notice">{actionError}</div>}
      </div>

      <h3>Milestones</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>State</th>
            <th>Tranche</th>
            <th>Evidence</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {(detail.milestones as unknown[]).map((m, idx) => {
            const state = milestoneState(m);
            const bps = rowField(m, "trancheBps", "tranche_bps");
            const cid = rowField(m, "evidenceCID", "evidence_cid");
            const submitted = state === "Submitted";
            return (
              <tr key={idx}>
                <td>{idx + 1}</td>
                <td><span className={`pill ${state.toLowerCase()}`}>{state}</span></td>
                <td className="num">{bps ? `${(Number(bps) / 100).toFixed(0)}%` : "—"}</td>
                <td className="mono small">
                  {cid ? (
                    <a href={`${api.base}/api/evidence/${cid}`} target="_blank" rel="noreferrer">
                      {cid.slice(0, 14)}…
                    </a>
                  ) : "—"}
                </td>
                <td className="action-cell">
                  {wallet && detail.state === "Active" && (state === "Pending" || state === "Rejected") && (
                    <>
                      <label className="btn file-btn">
                        {isCreator ? "Upload evidence" : "Creator upload"}
                        <input
                          type="file"
                          hidden
                          disabled={!isCreator || busy !== null}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void submitEvidence(idx, file);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    </>
                  )}
                  {wallet && submitted && config?.contracts.verifier && (
                    <>
                      <button className="btn" disabled={busy !== null} onClick={() => void vote(idx, 1)}>Approve</button>
                      <button className="btn" disabled={busy !== null} onClick={() => void vote(idx, 0)}>Reject</button>
                      <button className="btn" disabled={busy !== null} onClick={() => void resolve(idx)}>Resolve</button>
                    </>
                  )}
                  {wallet && submitted && config?.contracts.disputes && bond !== null && (
                    <button className="btn" disabled={busy !== null} onClick={() => void raiseDispute(idx)}>
                      Dispute
                    </button>
                  )}
                  {state === "Rejected" && wallet && config?.contracts.disputes && bond !== null && (
                    <button className="btn" disabled={busy !== null} onClick={() => void raiseDispute(idx)}>
                      Appeal
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {detail.milestones.length === 0 && (
            <tr><td colSpan={5} className="dim">No milestones indexed.</td></tr>
          )}
        </tbody>
      </table>

      <h3>Disputes</h3>
      <table className="data-table">
        <thead>
          <tr><th>Key</th><th>Milestone</th><th>State</th><th>Outcome</th><th>Deadline</th><th>Action</th></tr>
        </thead>
        <tbody>
          {(detail.disputes as unknown[]).map((d, i) => {
            const key = rowField(d, "dispute_key", "disputeKey");
            const voting = rowField(d, "state") === "Voting";
            return (
              <tr key={key || i}>
                <td className="mono small">{key ? `${key.slice(0, 12)}…` : "—"}</td>
                <td>{rowField(d, "milestone_index", "milestoneIndex")}</td>
                <td>{rowField(d, "state") || "—"}</td>
                <td>{rowField(d, "outcome") || "—"}</td>
                <td className="small">{formatTime(Number(rowField(d, "vote_deadline", "voteDeadline") || 0))}</td>
                <td>
                  {wallet && voting && config?.contracts.disputes && (
                    <button className="btn" disabled={busy !== null} onClick={() => void resolveDispute(key)}>
                      Resolve
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {detail.disputes.length === 0 && <tr><td colSpan={6} className="dim">No disputes.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

function CreateCampaign({
  config,
  wallet,
  onCreated,
}: {
  config: AppConfig | null;
  wallet: WalletConnection | null;
  onCreated: (address: string) => void;
}) {
  const [goal, setGoal] = useState("10");
  const [fundingDays, setFundingDays] = useState("30");
  const [titles, setTitles] = useState(["Prototype", "Production", "Delivery"]);
  const [cids, setCids] = useState(["spec-0", "spec-1", "spec-2"]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!wallet || !config?.contracts.factory) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const block = await wallet.provider.getBlock("latest");
      const now = block?.timestamp ?? Math.floor(Date.now() / 1000);
      const fundingDeadline = now + Number(fundingDays) * 86_400;
      const params = {
        goal: parseEther(goal),
        fundingDeadline,
        trancheBps: [4_000, 3_000, 3_000],
        descriptionHashes: titles.map((t) => keccak256(toUtf8Bytes(t))),
        specificationCIDs: cids,
        milestoneDeadlines: [10, 20, 30].map((d) => fundingDeadline + d * 86_400),
        treasury: "0x0000000000000000000000000000000000000000",
      };
      const factory = factoryContract(config.contracts.factory, wallet.signer);
      const tx = await factory.createCampaign(params);
      await tx.wait();
      const count = (await factory.campaignCount()) as bigint;
      const address = (await factory.campaignAt(count - 1n)) as string;
      setMessage(`Campaign deployed at ${address}. The indexer will pick it up within one poll.`);
      window.setTimeout(() => onCreated(address), 6_000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="prose">
      <h2>Create a campaign</h2>
      <p>
        This submits a real transaction to <code>CampaignFactory</code> from your connected wallet.
        Milestones use a 40 / 30 / 30 tranche schedule and deadlines 10, 20 and 30 days after funding
        closes. Description hashes are computed in the browser; specification CIDs can be any string
        (use a real IPFS CID for production).
      </p>
      <div className="form-grid">
        <label>Goal (ETH)<input className="input" value={goal} onChange={(e) => setGoal(e.target.value)} /></label>
        <label>Funding window (days)<input className="input" value={fundingDays} onChange={(e) => setFundingDays(e.target.value)} /></label>
      </div>
      {titles.map((title, i) => (
        <div className="form-grid" key={i}>
          <label>Milestone {i + 1} title
            <input className="input" value={title} onChange={(e) => setTitles(titles.map((t, j) => (j === i ? e.target.value : t)))} />
          </label>
          <label>Specification CID
            <input className="input" value={cids[i]} onChange={(e) => setCids(cids.map((c, j) => (j === i ? e.target.value : c)))} />
          </label>
        </div>
      ))}
      <button className="btn primary" disabled={!wallet || busy || !config?.contracts.factory} onClick={() => void create()}>
        {busy ? "Deploying…" : "Create campaign"}
      </button>
      {!wallet && <p className="dim">Connect MetaMask first.</p>}
      {message && <div className="notice ok">{message}</div>}
      {error && <div className="notice">{error}</div>}
    </section>
  );
}

function HowItWorks() {
  return (
    <section className="prose">
      <h2>How it works</h2>
      <p>
        On traditional platforms a campaign that reaches its goal pays the creator everything at once.
        If the project is abandoned, backers have no recourse. This system moves the money into a smart
        contract and releases it incrementally, only on verified delivery.
      </p>
      <ol>
        <li>
          <strong>Create.</strong> The creator defines milestones, each with a tranche percentage, a
          deadline and a specification. Factory-deployed campaign contracts hold the funds in escrow.
        </li>
        <li>
          <strong>Fund.</strong> Backers send ETH to the campaign contract. The creator cannot withdraw
          pledged funds directly.
        </li>
        <li>
          <strong>Prove.</strong> For each milestone the creator uploads evidence (IPFS when configured,
          otherwise a local content-addressed store clearly labelled as such) and submits the CID and
          the keccak256 digest on chain.
        </li>
        <li>
          <strong>Verify.</strong> Registered verifiers, each holding slashable stake, vote during the
          voting window. Approval releases the tranche; rejection or missed quorum fails closed.
        </li>
        <li>
          <strong>Resolve.</strong> A backer can raise a bonded dispute. Jurors vote stake-weighted; the
          verdict is tally-derived and permissionlessly settled, then applied to the escrow. Outcomes
          update on-chain reputation.
        </li>
      </ol>
      <p>
        DIDs use the <code>did:ethr</code> identifier shape; verifiable credentials are signed JSON
        documents whose hashes are attested by <code>CredentialRegistry</code>. No personal data is
        written on chain.
      </p>
    </section>
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function Results() {
  const [data, setData] = useState<ResearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.research().then((r) => setData(r.data)).catch((e) => setError((e as Error).message));
  }, []);

  const benchmarkRows = useMemo(() => {
    if (!data?.benchmarks) return [];
    const byOp = new Map<string, number[]>();
    for (const sample of data.benchmarks.gas) {
      const list = byOp.get(sample.operation) ?? [];
      list.push(Number(sample.gasUsed));
      byOp.set(sample.operation, list);
    }
    return [...byOp.entries()].map(([operation, values]) => ({
      operation,
      samples: values.length,
      medianGas: Math.round(median(values)),
    }));
  }, [data]);

  if (error) return <section className="prose"><div className="notice">Results unavailable: {error}</div></section>;
  if (!data) return <section className="prose"><p className="dim">Loading measured results…</p></section>;

  return (
    <section className="prose">
      <h2>Measured results</h2>
      <p className="dim small">
        Every table below is rendered from artifact JSON served by the backend. Missing artifacts are
        shown as unavailable, never replaced with remembered values.
      </p>

      <h3>Gas benchmarks</h3>
      {data.benchmarks ? (
        <>
          <p className="small">
            {data.benchmarks.network} · {data.benchmarks.simulated ? "SIMULATED network conditions (local EVM)" : "measured"} ·{" "}
            {new Date(data.benchmarks.measuredAt).toLocaleString()}
          </p>
          <table className="data-table">
            <thead><tr><th>Operation</th><th>Samples</th><th>Median gas</th></tr></thead>
            <tbody>
              {benchmarkRows.map((r) => (
                <tr key={r.operation}><td className="mono">{r.operation}</td><td>{r.samples}</td><td className="num">{r.medianGas.toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
          <p className="dim small">
            Gas depends only on bytecode and calldata, so these values transfer to any EVM; latency and
            throughput do not. {data.benchmarks.notes.join(" ")}
          </p>
        </>
      ) : <div className="notice">No benchmark artifact. Run <code>npx hardhat run benchmarks/run-benchmarks.ts</code>.</div>}

      <h3>L1 vs L2 cost model</h3>
      {data.costModel ? (
        <>
          <p className="small">
            Gas price ratio {data.costModel.ratios.gasPriceRatio}× · token price ratio{" "}
            {data.costModel.ratios.tokenPriceRatio}× · L1/L2 cost ratio{" "}
            {data.costModel.ratios.combinedCostRatio.toLocaleString()}×.
            {!data.costModel.deployedToTestnet && " No testnet deployment: latency and L1 data-availability fees are not measured."}
          </p>
          <table className="data-table">
            <thead><tr><th>Operation</th><th>Median gas</th><th>L1 USD</th><th>L2 USD</th><th>L2 / L1</th></tr></thead>
            <tbody>
              {data.costModel.operations.map((r) => (
                <tr key={r.operation}>
                  <td className="mono">{r.operation}</td>
                  <td className="num">{r.medianGas.toLocaleString()}</td>
                  <td className="num">${r.l1Usd.toFixed(4)}</td>
                  <td className="num">${r.l2Usd.toFixed(6)}</td>
                  <td className="num">{r.l2OverL1Pct.toFixed(3)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="dim small">
            {data.costModel.caveats.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </>
      ) : <div className="notice">No cost-model artifact. Run <code>npx hardhat run benchmarks/compare-l1-l2.ts</code>.</div>}

      <h3>Anomaly detection (synthetic corpus)</h3>
      {data.ml ? (
        <>
          <p className="small">
            N = {data.ml.dataset.n_samples}, fraud rate {(data.ml.dataset.fraud_rate * 100).toFixed(2)}%,{" "}
            {data.ml.dataset.synthetic ? "synthetic labels" : "real labels"}.
          </p>
          <table className="data-table">
            <thead><tr><th>Model</th><th>Precision</th><th>Recall</th><th>F1</th><th>ROC-AUC</th></tr></thead>
            <tbody>
              {([
                ["Random Forest", data.ml.random_forest],
                ["Logistic Regression", data.ml.logistic_regression],
                ["Isolation Forest (unsupervised)", data.ml.isolation_forest],
              ] as Array<[string, Record<string, number>]>).map(([name, m]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td className="num">{m.precision.toFixed(3)}</td>
                  <td className="num">{m.recall.toFixed(3)}</td>
                  <td className="num">{m.f1.toFixed(3)}</td>
                  <td className="num">{m.roc_auc.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dim small">
            Supervised scores measure recovery of a synthetic signal, not real fraud detection. The
            unsupervised Isolation Forest never sees labels and is the relevant deployment comparison.
          </p>
        </>
      ) : <div className="notice">No ML metrics artifact. Run the training pipeline in <code>ml-service</code>.</div>}

      <h3>Attack simulations</h3>
      {data.attacks ? (
        <>
          <p className="small">{data.attacks.simulated ? "SIMULATED on the local EVM — protocol behaviour, not live economics." : "Executed."}</p>
          {data.attacks.results.map((r) => (
            <div className="result-card" key={r.id}>
              <strong>{r.id}. {r.name}</strong>
              <p>{r.conclusion}</p>
              <p className="dim small">Limitation: {r.limitations}</p>
            </div>
          ))}
        </>
      ) : <div className="notice">No attack-simulation artifact.</div>}

      <h3>Static analysis and coverage</h3>
      {data.coverage ? (
        <>
          <p className="small">
            Solidity coverage generated by <code>solidity-coverage</code> on the local Hardhat EVM.
            Branch coverage is lower than statement and line coverage because every
            require/revert path is counted. Raw artifact:{" "}
            <code>coverage/coverage-summary.json</code>.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Statements</th>
                <th>Branches</th>
                <th>Functions</th>
                <th>Lines</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.coverage)
                .filter(([name]) => name !== "total")
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, entry]) => (
                  <tr key={name}>
                    <td className="mono small">{name.replace(/^contracts[\\/]/, "")}</td>
                    <td className="num">{entry.statements.pct.toFixed(2)}%</td>
                    <td className="num">{entry.branches.pct.toFixed(2)}%</td>
                    <td className="num">{entry.functions.pct.toFixed(2)}%</td>
                    <td className="num">{entry.lines.pct.toFixed(2)}%</td>
                  </tr>
                ))}
              {data.coverage.total && (
                <tr>
                  <td><strong>Total</strong></td>
                  <td className="num"><strong>{data.coverage.total.statements.pct.toFixed(2)}%</strong></td>
                  <td className="num"><strong>{data.coverage.total.branches.pct.toFixed(2)}%</strong></td>
                  <td className="num"><strong>{data.coverage.total.functions.pct.toFixed(2)}%</strong></td>
                  <td className="num"><strong>{data.coverage.total.lines.pct.toFixed(2)}%</strong></td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      ) : (
        <div className="notice">
          Coverage summary has not been generated in this checkout; run <code>npm run coverage</code>.
        </div>
      )}
      <p className="small">
        Slither raw output is stored in <code>security/slither-report-new.json</code>. The triage in{" "}
        <code>security/SLITHER_REPORT.md</code> explains the current High-impact{" "}
        <code>arbitrary-send-eth</code> results as false positives; a severity count is not a
        security guarantee.
      </p>

      <h3>Pilot survey</h3>
      <div className="notice warn">
        <strong>{data.survey.status}.</strong> {data.survey.detail} Template:{" "}
        <code>{data.survey.path}</code>.
      </div>
    </section>
  );
}
