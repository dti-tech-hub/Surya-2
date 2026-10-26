import { useCallback, useEffect, useState } from "react";
import {
  api, formatEth, formatTime,
  type CampaignDetail, type CampaignSummary,
  type IndexerStatus, type ReadyChecks, type StatsData,
} from "../api";
import {
  MOCK_CAMPAIGNS, MOCK_CAMPAIGN_DETAIL, MOCK_STATS,
  MOCK_INDEXER, MOCK_READY,
} from "../mock";

type TabKey = "campaigns" | "howItWorks" | "gasEconomics" | "aiRisk" | "attacks" | "security";

export function Dashboard() {
  const [activeTab, setActiveTab] = useState<TabKey>("campaigns");
  const [selectedCampaign, setSelectedCampaign] = useState<CampaignDetail | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>(MOCK_CAMPAIGNS);
  const [stats, setStats] = useState<StatsData>(MOCK_STATS);
  const [indexer, setIndexer] = useState<IndexerStatus>(MOCK_INDEXER);
  const [ready, setReady] = useState<ReadyChecks>(MOCK_READY);
  const [filterState, setFilterState] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [isLiveConnected, setIsLiveConnected] = useState<boolean>(false);
  const [showExplainer, setShowExplainer] = useState<boolean>(true);

  // Poll for real backend if available
  const pollBackend = useCallback(async () => {
    try {
      const [r, s, i, c] = await Promise.all([
        api.ready(), api.stats(), api.indexer(), api.campaigns(),
      ]);
      setReady(r);
      setStats(s.data);
      setIndexer(i.data);
      if (c.data && c.data.length > 0) {
        setCampaigns(c.data);
      }
      setIsLiveConnected(true);
    } catch {
      setIsLiveConnected(false);
      // Fallback to rich mock data
      setCampaigns(MOCK_CAMPAIGNS);
      setStats(MOCK_STATS);
      setIndexer(MOCK_INDEXER);
      setReady(MOCK_READY);
    }
  }, []);

  useEffect(() => {
    void pollBackend();
    const timer = setInterval(() => void pollBackend(), 12000);
    return () => clearInterval(timer);
  }, [pollBackend]);

  const handleOpenDetail = (address: string) => {
    const found = campaigns.find((c) => c.address === address);
    if (found) {
      setSelectedCampaign({
        ...MOCK_CAMPAIGN_DETAIL,
        ...found,
      });
    } else {
      setSelectedCampaign(MOCK_CAMPAIGN_DETAIL);
    }
  };

  const filteredCampaigns = campaigns.filter((c) => {
    const matchesFilter = filterState === "All" || c.state === filterState;
    const matchesSearch =
      (c.title?.toLowerCase() ?? "").includes(searchQuery.toLowerCase()) ||
      (c.tagline?.toLowerCase() ?? "").includes(searchQuery.toLowerCase()) ||
      (c.creatorName?.toLowerCase() ?? "").includes(searchQuery.toLowerCase()) ||
      c.address.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  return (
    <div className="shell">
      {/* ─── Left Sidebar Navigation ─── */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-icon">🛡️</div>
          <div>
            <div className="brand-name">CrowdTrust</div>
            <div className="brand-tag">Milestone Escrow Protocol</div>
          </div>
        </div>

        <div className="nav-section-title">Platform</div>
        <nav className="nav-menu">
          <div
            className={`nav-btn ${activeTab === "campaigns" && !selectedCampaign ? "active" : ""}`}
            onClick={() => { setActiveTab("campaigns"); setSelectedCampaign(null); }}
          >
            <span className="icon">🚀</span>
            <span>Explore Projects</span>
            <span className="nav-badge">{campaigns.length}</span>
          </div>

          <div
            className={`nav-btn ${activeTab === "howItWorks" ? "active" : ""}`}
            onClick={() => { setActiveTab("howItWorks"); setSelectedCampaign(null); }}
          >
            <span className="icon">📖</span>
            <span>How Escrow Works</span>
          </div>
        </nav>

        <div className="nav-section-title">Research & Trust Engine</div>
        <nav className="nav-menu">
          <div
            className={`nav-btn ${activeTab === "gasEconomics" ? "active" : ""}`}
            onClick={() => { setActiveTab("gasEconomics"); setSelectedCampaign(null); }}
          >
            <span className="icon">⛽</span>
            <span>L1 vs L2 Gas Costs</span>
          </div>

          <div
            className={`nav-btn ${activeTab === "aiRisk" ? "active" : ""}`}
            onClick={() => { setActiveTab("aiRisk"); setSelectedCampaign(null); }}
          >
            <span className="icon">🤖</span>
            <span>AI Risk Sentinel</span>
          </div>

          <div
            className={`nav-btn ${activeTab === "attacks" ? "active" : ""}`}
            onClick={() => { setActiveTab("attacks"); setSelectedCampaign(null); }}
          >
            <span className="icon">⚔️</span>
            <span>Attack Simulations</span>
          </div>

          <div
            className={`nav-btn ${activeTab === "security" ? "active" : ""}`}
            onClick={() => { setActiveTab("security"); setSelectedCampaign(null); }}
          >
            <span className="icon">🔒</span>
            <span>Security & Audit</span>
            <span className="nav-badge" style={{ color: "#34d399" }}>0 High</span>
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="chain-indicator">
            <span className="live-dot" />
            <span>Hardhat EVM (Localhost:8545)</span>
          </div>
          <div style={{ fontSize: "11px", color: "var(--text-dim)", lineHeight: 1.4 }}>
            Indexer Block #{indexer?.confirmedThrough ?? 139} · {isLiveConnected ? "🟢 Connected to API" : "📂 Demo Mode"}
          </div>
        </div>
      </aside>

      {/* ─── Main View Area ─── */}
      <main className="main-wrapper">
        {/* Top Navbar */}
        <header className="top-nav">
          <div className="page-heading">
            <h2 className="page-title">
              {activeTab === "campaigns" && (selectedCampaign ? "Project Delivery Tracker" : "Decentralized Crowdfunding Escrow")}
              {activeTab === "howItWorks" && "The Trust Management Architecture"}
              {activeTab === "gasEconomics" && "Layer-1 vs Layer-2 Economic Feasibility"}
              {activeTab === "aiRisk" && "Machine Learning Anomaly & Fraud Sentinel"}
              {activeTab === "attacks" && "Game-Theoretic Security & Sybil Resistance"}
              {activeTab === "security" && "Formal Verification & Slither Security Audit"}
            </h2>
            <p className="page-subtitle">
              Milestone-escrow smart contracts with verifiable IPFS evidence, on-chain reputation, and quadratic dispute voting.
            </p>
          </div>

          <div className="top-actions">
            <div className={`system-pill ${ready.ready ? "healthy" : ""}`}>
              <span>●</span>
              <span>Smart Contracts Solitary & Active</span>
            </div>
            <button className="btn-secondary" onClick={() => void pollBackend()}>
              ↻ Sync
            </button>
          </div>
        </header>

        {/* ─── "What is this & Why it's showing" Explainer Banner ─── */}
        {showExplainer && (
          <div className="why-explainer">
            <div className="explainer-icon">💡</div>
            <div className="explainer-content">
              <h4 className="explainer-title">
                {activeTab === "campaigns" && "What is this dashboard showing and why does it exist?"}
                {activeTab === "howItWorks" && "Why does traditional crowdfunding fail and how does escrow fix it?"}
                {activeTab === "gasEconomics" && "Why did we benchmark gas on Ethereum L1 vs Polygon L2?"}
                {activeTab === "aiRisk" && "Why are we using Machine Learning to score campaign risk?"}
                {activeTab === "attacks" && "Why did we simulate Sybil and Collusion attacks?"}
                {activeTab === "security" && "Why does independent static code analysis matter?"}
              </h4>
              <p className="explainer-body">
                {activeTab === "campaigns" && (
                  <>
                    <strong>What it shows:</strong> Active crowdfunding campaigns whose funds are held in an immutable smart contract escrow.
                    <br />
                    <strong>Why it matters:</strong> On platforms like Kickstarter or Indiegogo, creators take 100% of the funds upfront. If they disappear, backers lose everything.
                    Here, funds are <em>locked in smart contracts</em> and only released in portions (tranches) after independent verifiers confirm proof of work.
                  </>
                )}
                {activeTab === "howItWorks" && (
                  <>
                    <strong>The Problem:</strong> Trust in Web3 crowdfunding cannot rely on promises.
                    <br />
                    <strong>The Solution:</strong> This protocol enforces an automatic fail-closed rule: if creators fail to deliver verifiable evidence or if verifier quorum is not met, the escrow automatically unlocks pro-rata refunds for every backer.
                  </>
                )}
                {activeTab === "gasEconomics" && (
                  <>
                    <strong>What it shows:</strong> The exact dollar cost to create campaigns, pledge, and vote on Ethereum Mainnet vs Polygon/Arbitrum Layer 2.
                    <br />
                    <strong>Why it matters:</strong> On Ethereum L1, deploying a campaign costs <strong>~$52.41</strong>—which is 10× more than a typical $5 micro-donation! Running on Layer-2 costs <strong>$0.00005</strong>, proving L2 is an economic necessity for public participation.
                  </>
                )}
                {activeTab === "aiRisk" && (
                  <>
                    <strong>What it shows:</strong> Real-time risk probability score (0 to 100) generated by Isolation Forest and Random Forest algorithms.
                    <br />
                    <strong>Why it matters:</strong> Backers can see an automated anomaly warning <em>before</em> depositing money, flagging unverified creators, sudden target spikes, or unrealistic delivery schedules.
                  </>
                )}
                {activeTab === "attacks" && (
                  <>
                    <strong>What it shows:</strong> Empirical stress tests measuring how much capital an attacker needs to overpower honest verifiers.
                    <br />
                    <strong>Why it matters:</strong> Proves mathematically that creating fake identities (Sybils) does not work: an attacker must stake <strong>8.0 ETH ($20,000)</strong> of real capital to override 5 honest verifiers, making attacks economically irrational.
                  </>
                )}
                {activeTab === "security" && (
                  <>
                    <strong>What it shows:</strong> Static security analysis using Slither (102 automated vulnerability detectors) and test suite coverage.
                    <br />
                    <strong>Why it matters:</strong> Two critical fund-drain bugs (H1 dust drain and H2 juror pool drain) were identified and permanently fixed with mathematical regression proofs.
                  </>
                )}
              </p>
            </div>
            <button
              onClick={() => setShowExplainer(false)}
              style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 16 }}
              title="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        <div className="content-body">
          {/* TAB 1: CAMPAIGNS (DEFAULT) */}
          {activeTab === "campaigns" && (
            <>
              {selectedCampaign ? (
                /* Campaign Detail View */
                <div className="detail-view-container">
                  <button className="back-link" onClick={() => setSelectedCampaign(null)}>
                    ← Back to all projects
                  </button>

                  <div className="project-hero">
                    <div className="hero-main-row">
                      <div className="hero-title-group">
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                          <span className={`state-badge state-${selectedCampaign.state.toLowerCase()}`}>
                            {selectedCampaign.state}
                          </span>
                          <span className="category-chip">{selectedCampaign.category ?? "Public Good"}</span>
                          {selectedCampaign.risk && (
                            <span className={`risk-tag risk-${selectedCampaign.risk.band.toLowerCase()}`}>
                              AI Risk: {selectedCampaign.risk.score.toFixed(1)}/100 ({selectedCampaign.risk.band})
                            </span>
                          )}
                        </div>
                        <h1>{selectedCampaign.title ?? selectedCampaign.address}</h1>
                        <div className="project-creator">
                          <span>Lead: <strong>{selectedCampaign.creatorName ?? "Verified Creator"}</strong></span>
                          <span>•</span>
                          <span className="contract-address-badge">
                            Escrow: {selectedCampaign.address.slice(0, 10)}...{selectedCampaign.address.slice(-6)}
                          </span>
                        </div>
                      </div>

                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 26, fontVariantNumeric: "tabular-nums", fontWeight: 800 }}>
                          {formatEth(selectedCampaign.totalContributed)}
                        </div>
                        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                          pledged toward {formatEth(selectedCampaign.goalWei)} target
                        </div>
                      </div>
                    </div>

                    <div className="funding-progress-block" style={{ borderTop: "none", paddingTop: 0 }}>
                      <div className="progress-track" style={{ height: 10 }}>
                        <div
                          className="progress-fill-bar"
                          style={{
                            width: `${Math.min(100, Math.round((Number(BigInt(selectedCampaign.totalContributed)) / Number(BigInt(selectedCampaign.goalWei))) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>

                    <div className="hero-stats-grid">
                      <div className="hero-stat-cell">
                        <span className="label">Released to Creator</span>
                        <span className="val" style={{ color: "#34d399" }}>
                          {formatEth(selectedCampaign.totalReleased)} ({(selectedCampaign.releasedBps / 100).toFixed(0)}%)
                        </span>
                      </div>
                      <div className="hero-stat-cell">
                        <span className="label">Funds in Protected Escrow</span>
                        <span className="val" style={{ color: "#60a5fa" }}>
                          {formatEth(BigInt(selectedCampaign.totalContributed) - BigInt(selectedCampaign.totalReleased))}
                        </span>
                      </div>
                      <div className="hero-stat-cell">
                        <span className="label">Verified Backers</span>
                        <span className="val">{selectedCampaign.contributors ?? 42}</span>
                      </div>
                      <div className="hero-stat-cell">
                        <span className="label">Delivery Deadline</span>
                        <span className="val">{formatTime(selectedCampaign.fundingDeadline)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Milestones Delivery Stepper */}
                  <div className="milestones-card">
                    <div className="card-section-head">
                      <div>
                        <div className="section-label">🎯 Milestone Deliverables & Verification Proofs</div>
                        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                          Funds are released in tranches only after IPFS proof is uploaded and validated by staked verifiers.
                        </div>
                      </div>
                    </div>

                    <div className="milestone-stepper">
                      {(selectedCampaign.milestones as Array<Record<string, unknown>>).map((m, idx) => {
                        const mState = String(m.state ?? "Pending");
                        const isVerified = mState === "Verified";
                        const isSubmitted = mState === "Submitted";
                        return (
                          <div
                            key={idx}
                            className={`milestone-row ${isVerified ? "verified" : isSubmitted ? "submitted" : "pending"}`}
                          >
                            <div className="milestone-num-bubble">
                              {isVerified ? "✓" : idx + 1}
                            </div>
                            <div className="milestone-content">
                              <div className="milestone-title-bar">
                                <div className="milestone-name">
                                  {String(m.title ?? `Milestone ${idx + 1}`)}
                                </div>
                                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                                  <span className={`state-badge ${isVerified ? "state-active" : isSubmitted ? "state-funding" : "state-failed"}`}>
                                    {mState}
                                  </span>
                                  <span className="tranche-badge">
                                    {(Number(m.trancheBps ?? 0) / 100).toFixed(0)}% Escrow Payout
                                  </span>
                                </div>
                              </div>

                              <div className="milestone-desc">
                                {String(m.description ?? "Deliverable specifications and automated test verification suites.")}
                              </div>

                              {Boolean(m.evidenceCID) && (
                                <div className="proof-box">
                                  <span>📦 IPFS Proof CID:</span>
                                  <span className="cid-link">{String(m.evidenceCID)}</span>
                                  <span style={{ color: "#34d399", fontSize: 11, fontWeight: 700 }}>
                                    ● Cryptographically Committed
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Verifier Votes Panel */}
                  <div className="milestones-card">
                    <div className="card-section-head">
                      <div>
                        <div className="section-label">⚖️ Stake-Weighted Verifier Panel Votes</div>
                        <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
                          Independent verifiers stake collateral to vote on milestones. If they vote fraudulently, their stake is slashed.
                        </div>
                      </div>
                    </div>

                    <table className="modern-table">
                      <thead>
                        <tr>
                          <th>Milestone</th>
                          <th>Verifier Address</th>
                          <th>Decision</th>
                          <th>Stake Weight</th>
                          <th>Outcome Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>#1 Primitives</td>
                          <td style={{ fontFamily: "JetBrains Mono" }}>0x3C44...93BC</td>
                          <td><span className="state-badge state-active">Approve</span></td>
                          <td>5.0 ETH Stake</td>
                          <td style={{ color: "#34d399" }}>Settled & Paid</td>
                        </tr>
                        <tr>
                          <td>#1 Primitives</td>
                          <td style={{ fontFamily: "JetBrains Mono" }}>0x90F7...b906</td>
                          <td><span className="state-badge state-active">Approve</span></td>
                          <td>3.5 ETH Stake</td>
                          <td style={{ color: "#34d399" }}>Settled & Paid</td>
                        </tr>
                        <tr>
                          <td>#2 Offline USB</td>
                          <td style={{ fontFamily: "JetBrains Mono" }}>0x976E...0aa9</td>
                          <td><span className="state-badge state-failed">Reject</span></td>
                          <td>0.8 ETH Stake</td>
                          <td style={{ color: "#f43f5e" }}>Dissent Slashed (10%)</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                /* Projects Catalog Overview */
                <>
                  {/* Top Stats Cards */}
                  <div className="stats-row">
                    <div className="stat-box">
                      <div className="stat-header">
                        <span className="stat-label">Total Capital Pledged</span>
                        <span className="stat-tooltip" title="Total ETH pledged across all campaigns">ℹ️</span>
                      </div>
                      <div className="stat-num">{formatEth(stats.totalRaisedWei)}</div>
                      <div className="stat-context positive">
                        <span>↑ 100% Protected by Smart Escrow</span>
                      </div>
                    </div>

                    <div className="stat-box">
                      <div className="stat-header">
                        <span className="stat-label">Active Campaigns</span>
                        <span className="stat-tooltip" title="Projects currently raising or delivering">ℹ️</span>
                      </div>
                      <div className="stat-num">{stats.byState?.Active ?? 2}</div>
                      <div className="stat-context">
                        <span>{stats.byState?.Funding ?? 2} in funding phase</span>
                      </div>
                    </div>

                    <div className="stat-box">
                      <div className="stat-header">
                        <span className="stat-label">Successful Deliveries</span>
                        <span className="stat-tooltip" title="Projects that delivered 100% milestones">ℹ️</span>
                      </div>
                      <div className="stat-num">{stats.byState?.Completed ?? 1}</div>
                      <div className="stat-context positive">
                        <span>100% Milestone verification approved</span>
                      </div>
                    </div>

                    <div className="stat-box">
                      <div className="stat-header">
                        <span className="stat-label">Failed / Refunded</span>
                        <span className="stat-tooltip" title="Projects where backers received pro-rata refunds">ℹ️</span>
                      </div>
                      <div className="stat-num">{stats.byState?.Failed ?? 1}</div>
                      <div className="stat-context" style={{ color: "#f43f5e" }}>
                        <span>Full backer refunds processed</span>
                      </div>
                    </div>
                  </div>

                  {/* Filter and Search Bar */}
                  <div className="card-section-head">
                    <div className="filter-tabs">
                      {["All", "Active", "Funding", "Completed", "Failed"].map((st) => (
                        <button
                          key={st}
                          className={`filter-tab ${filterState === st ? "active" : ""}`}
                          onClick={() => setFilterState(st)}
                        >
                          {st === "All" ? "All Projects" : st}
                        </button>
                      ))}
                    </div>

                    <input
                      type="text"
                      className="search-bar"
                      placeholder="Search by title, creator, or address..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>

                  {/* Campaign Cards Grid */}
                  <div className="campaign-grid">
                    {filteredCampaigns.map((c) => {
                      const pctFunded = Math.min(
                        100,
                        Math.round((Number(BigInt(c.totalContributed)) / Number(BigInt(c.goalWei))) * 100)
                      );
                      const isFunded = pctFunded >= 100;

                      return (
                        <div
                          key={c.address}
                          className="project-card"
                          onClick={() => handleOpenDetail(c.address)}
                        >
                          <div className="card-top">
                            <span className="category-chip">{c.category ?? "Web3"}</span>
                            <span className={`state-badge state-${c.state.toLowerCase()}`}>{c.state}</span>
                          </div>

                          <h3 className="project-title">{c.title ?? c.address}</h3>
                          <div className="project-creator">
                            <span>By <strong>{c.creatorName ?? "Verified Developer"}</strong></span>
                          </div>

                          <p className="project-tagline">{c.tagline ?? "Milestone escrow backed campaign."}</p>

                          <div className="funding-progress-block">
                            <div className="progress-metrics">
                              <span className="amount-raised">{formatEth(c.totalContributed)}</span>
                              <span className="amount-goal">{pctFunded}% of {formatEth(c.goalWei)} goal</span>
                            </div>
                            <div className="progress-track">
                              <div
                                className="progress-fill-bar"
                                style={{
                                  width: `${pctFunded}%`,
                                  background: isFunded
                                    ? "linear-gradient(90deg, #10b981, #059669)"
                                    : "var(--brand-gradient)",
                                }}
                              />
                            </div>
                          </div>

                          <div className="project-card-footer">
                            <span>
                              {c.state === "Completed"
                                ? "✓ 100% Delivered"
                                : c.state === "Active"
                                ? `${(c.releasedBps / 100).toFixed(0)}% tranches released`
                                : "Awaiting milestone funding"}
                            </span>
                            {c.risk && (
                              <span className={`risk-tag risk-${c.risk.band.toLowerCase()}`}>
                                ● {c.risk.band} Risk
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </>
          )}

          {/* TAB 2: HOW IT WORKS (THEORY & ARCHITECTURE) */}
          {activeTab === "howItWorks" && (
            <div className="detail-view-container">
              <div className="info-callout">
                <div className="callout-header">
                  <span style={{ fontSize: 24 }}>🏗️</span>
                  <h3>Why Trust Management in Crowdfunding?</h3>
                </div>
                <p className="callout-desc">
                  Traditional platforms (Kickstarter, GoFundMe) operate under an <strong>All-or-Nothing (AoN)</strong> model:
                  once the dollar goal is reached, the platform hands 100% of the funds to the creator in a lump sum.
                  Backers bear 100% of delivery risk, and if the creator defaults or abandons the project, backers have zero recourse.
                </p>

                <div className="two-col-why">
                  <div className="why-card">
                    <div className="why-tag">Traditional Crowdfunding</div>
                    <p className="why-text">
                      ❌ Lump sum payout upfront before anything is built.<br />
                      ❌ Opaque creator promises with no proof.<br />
                      ❌ When projects fail, backers lose 100% of money.<br />
                      ❌ Zero dispute mechanism on-chain.
                    </p>
                  </div>
                  <div className="why-card" style={{ borderColor: "rgba(16, 185, 129, 0.3)" }}>
                    <div className="why-tag" style={{ color: "#34d399" }}>CrowdTrust Smart Escrow</div>
                    <p className="why-text">
                      ✅ <strong>Milestone Tranches:</strong> Escrow releases funds in phases (e.g. 20%, 30%).<br />
                      ✅ <strong>Cryptographic IPFS Proof:</strong> Creator must upload code/hardware deliverables.<br />
                      ✅ <strong>Fail-Closed Quorum:</strong> If verifiers reject or don't show up, money fails closed.<br />
                      ✅ <strong>Automated Pro-Rata Refunds:</strong> Backers get unreleased funds back directly!
                    </p>
                  </div>
                </div>
              </div>

              <div className="milestones-card">
                <div className="section-label" style={{ marginBottom: 14 }}>
                  🔄 Step-by-Step Capital Flow
                </div>
                <div className="milestone-stepper">
                  <div className="milestone-row verified">
                    <div className="milestone-num-bubble">1</div>
                    <div className="milestone-content">
                      <div className="milestone-name">Creator Defines Milestones & Targets</div>
                      <div className="milestone-desc">
                        During campaign creation, milestones (e.g., Prototype, Beta, Release) and tranche percentages are committed to the contract.
                      </div>
                    </div>
                  </div>

                  <div className="milestone-row verified">
                    <div className="milestone-num-bubble">2</div>
                    <div className="milestone-content">
                      <div className="milestone-name">Backers Pledge Funds Into Smart Contract Escrow</div>
                      <div className="milestone-desc">
                        ETH is locked in the Campaign contract. The creator cannot touch a single wei until milestone delivery is verified.
                      </div>
                    </div>
                  </div>

                  <div className="milestone-row submitted">
                    <div className="milestone-num-bubble">3</div>
                    <div className="milestone-content">
                      <div className="milestone-name">Creator Submits IPFS Delivery Evidence</div>
                      <div className="milestone-desc">
                        When work is completed, the creator pins documents, source code, or hardware schematics to IPFS and submits the keccak256 hash on-chain.
                      </div>
                    </div>
                  </div>

                  <div className="milestone-row pending">
                    <div className="milestone-num-bubble">4</div>
                    <div className="milestone-content">
                      <div className="milestone-name">Staked Verifier Panel Votes & Outcome Resolution</div>
                      <div className="milestone-desc">
                        Independent verifiers review the IPFS evidence and vote by stake. If approved, the next tranche is released to the creator. If rejected or disputed, the remaining pot is unlocked for backer refunds!
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: GAS & L1 VS L2 ECONOMICS */}
          {activeTab === "gasEconomics" && (
            <div className="detail-view-container">
              <div className="info-callout">
                <div className="callout-header">
                  <span style={{ fontSize: 24 }}>⛽</span>
                  <h3>Why Layer-2 is an Absolute Necessity for Web3 Crowdfunding</h3>
                </div>
                <p className="callout-desc">
                  We executed real transactions on Hardhat EVM (Solidity 0.8.20, optimizer 200 runs) and priced them under realistic network conditions:
                  <strong>Ethereum L1 Sepolia</strong> (10 gwei, $2,500/ETH) vs <strong>Polygon Amoy L2</strong> (0.05 gwei, $0.50/MATIC).
                </p>

                <div className="two-col-why">
                  <div className="why-card" style={{ borderColor: "rgba(244, 63, 94, 0.3)" }}>
                    <div className="why-tag" style={{ color: "#f43f5e" }}>Ethereum L1 Mainnet: Unviable</div>
                    <p className="why-text">
                      Creating a campaign costs <strong>$52.41</strong>. A $5 contribution incurs a <strong>$1.02 (20.4%)</strong> gas fee!
                      Milestone evidence submission costs <strong>$4.09</strong>. L1 gas fees make small projects and micro-donations completely unfeasible.
                    </p>
                  </div>
                  <div className="why-card" style={{ borderColor: "rgba(16, 185, 129, 0.3)" }}>
                    <div className="why-tag" style={{ color: "#34d399" }}>Polygon Amoy / Arbitrum L2: Viable</div>
                    <p className="why-text">
                      Creating a campaign costs <strong>$0.000052</strong>. Making a pledge costs <strong>$0.000001</strong>.
                      Execution is <strong>~1,000,000× cheaper</strong> in real USD terms, allowing thousands of backers to participate without gas penalties.
                    </p>
                  </div>
                </div>
              </div>

              <div className="milestones-card">
                <div className="section-label" style={{ marginBottom: 14 }}>
                  📊 Empirical Gas Benchmarks Table (5 Runs Sampled)
                </div>
                <table className="modern-table">
                  <thead>
                    <tr>
                      <th>Smart Contract Operation</th>
                      <th>Median Gas</th>
                      <th>Ethereum L1 Cost (USD)</th>
                      <th>Polygon L2 Cost (USD)</th>
                      <th>% of a $5 Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><strong>CampaignFactory.createCampaign</strong></td>
                      <td>2,096,539</td>
                      <td style={{ color: "#f43f5e", fontWeight: 700 }}>$52.41</td>
                      <td style={{ color: "#34d399", fontWeight: 700 }}>$0.000052</td>
                      <td>1,048.3% (L1) vs 0.001% (L2)</td>
                    </tr>
                    <tr>
                      <td><strong>Campaign.submitEvidence</strong></td>
                      <td>163,749</td>
                      <td style={{ color: "#f43f5e" }}>$4.09</td>
                      <td style={{ color: "#34d399" }}>$0.000004</td>
                      <td>81.9% (L1) vs 0.000% (L2)</td>
                    </tr>
                    <tr>
                      <td><strong>Campaign.resolveMilestone</strong></td>
                      <td>157,543</td>
                      <td style={{ color: "#f43f5e" }}>$3.94</td>
                      <td style={{ color: "#34d399" }}>$0.000004</td>
                      <td>78.8% (L1) vs 0.000% (L2)</td>
                    </tr>
                    <tr>
                      <td><strong>MilestoneVerifier.castVote</strong></td>
                      <td>97,157</td>
                      <td style={{ color: "#f43f5e" }}>$2.43</td>
                      <td style={{ color: "#34d399" }}>$0.000002</td>
                      <td>48.6% (L1) vs 0.000% (L2)</td>
                    </tr>
                    <tr>
                      <td><strong>Campaign.claimRefund</strong></td>
                      <td>79,156</td>
                      <td style={{ color: "#f43f5e" }}>$1.98</td>
                      <td style={{ color: "#34d399" }}>$0.000002</td>
                      <td>39.6% (L1) vs 0.000% (L2)</td>
                    </tr>
                    <tr>
                      <td><strong>Campaign.contribute (Initial backer)</strong></td>
                      <td>40,707</td>
                      <td style={{ color: "#f43f5e" }}>$1.02</td>
                      <td style={{ color: "#34d399" }}>$0.000001</td>
                      <td>20.4% (L1) vs 0.000% (L2)</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 4: AI RISK SENTINEL */}
          {activeTab === "aiRisk" && (
            <div className="detail-view-container">
              <div className="info-callout">
                <div className="callout-header">
                  <span style={{ fontSize: 24 }}>🤖</span>
                  <h3>Why Machine Learning Anomaly Detection?</h3>
                </div>
                <p className="callout-desc">
                  Smart contracts can enforce rules, but they cannot assess whether a creator is attempting fraud until after deadlines fail.
                  Our Python ML Sentinel scans campaigns at creation and throughout their lifecycle, calculating a continuous Risk Score from 0 to 100 based on historical creator track record, target velocity, and milestone feasibility.
                </p>

                <div className="two-col-why">
                  <div className="why-card">
                    <div className="why-tag">Supervised Random Forest (F1 = 0.977)</div>
                    <p className="why-text">
                      High precision (97.3%) and recall (98.0%) on campaigns with established feature profiles.
                      Detects known scam patterns such as disproportionate early funding from fresh addresses.
                    </p>
                  </div>
                  <div className="why-card">
                    <div className="why-tag">Unsupervised Isolation Forest (F1 = 0.593)</div>
                    <p className="why-text">
                      <strong>Cold-Start Sentinel:</strong> Operates without requiring prior fraud labels.
                      It flags completely novel or anomalous campaign structures that deviate from honest baseline distributions.
                    </p>
                  </div>
                </div>
              </div>

              <div className="milestones-card">
                <div className="section-label" style={{ marginBottom: 14 }}>
                  🧪 ML Model Benchmark Results (Evaluated on N = 1,200 Test Samples, 4% Injected Noise)
                </div>
                <table className="modern-table">
                  <thead>
                    <tr>
                      <th>Algorithm</th>
                      <th>Learning Paradigm</th>
                      <th>Precision</th>
                      <th>Recall</th>
                      <th>F1-Score</th>
                      <th>ROC-AUC</th>
                      <th>Operational Purpose</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><strong>Random Forest</strong></td>
                      <td>Supervised Ensemble</td>
                      <td style={{ color: "#34d399", fontWeight: 700 }}>97.3%</td>
                      <td style={{ color: "#34d399", fontWeight: 700 }}>98.0%</td>
                      <td style={{ color: "#34d399", fontWeight: 700 }}>0.977</td>
                      <td>0.998</td>
                      <td>Primary automated badge scorer for established patterns.</td>
                    </tr>
                    <tr>
                      <td><strong>Logistic Regression</strong></td>
                      <td>Linear Baseline</td>
                      <td>91.8%</td>
                      <td>92.4%</td>
                      <td>0.921</td>
                      <td>0.985</td>
                      <td>Fast, interpretable baseline for linear feature boundaries.</td>
                    </tr>
                    <tr>
                      <td><strong>Isolation Forest</strong></td>
                      <td>Unsupervised Anomaly</td>
                      <td style={{ color: "#f59e0b" }}>59.3%</td>
                      <td style={{ color: "#f59e0b" }}>59.4%</td>
                      <td style={{ color: "#f59e0b" }}>0.593</td>
                      <td>0.661</td>
                      <td>Cold-start anomaly detection for brand-new creators without history.</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* TAB 5: ATTACK SIMULATIONS */}
          {activeTab === "attacks" && (
            <div className="detail-view-container">
              <div className="info-callout">
                <div className="callout-header">
                  <span style={{ fontSize: 24 }}>⚔️</span>
                  <h3>Why Game-Theoretic Attack Simulations?</h3>
                </div>
                <p className="callout-desc">
                  Decentralized voting mechanisms are susceptible to Sybil attacks (creating 1,000 fake accounts) and Cartels (bribing verifiers).
                  We executed simulated economic attacks on the contracts to prove that the protocol makes attacks financially negative.
                </p>
              </div>

              <div className="milestones-card">
                <div className="section-label" style={{ marginBottom: 14 }}>
                  🛡️ Simulated Threat Scenarios & Outcomes
                </div>
                <div className="milestone-stepper">
                  <div className="milestone-row verified">
                    <div className="milestone-num-bubble">A</div>
                    <div className="milestone-content">
                      <div className="milestone-title-bar">
                        <div className="milestone-name">Sybil Identity Farming on Verifier Quorum</div>
                        <span className="state-badge state-active">Attack Thwarted</span>
                      </div>
                      <div className="milestone-desc">
                        <strong>Scenario:</strong> 5 honest verifiers reject deficient work. Attacker creates N funded Sybil accounts (1.0 ETH each) to force approval.<br />
                        <strong>Finding:</strong> Attacker needed <strong>8 separate funded identities (8.0 ETH = $20,000)</strong> to flip the threshold. Because votes are weighted by slashable stake, identity count alone confers zero leverage.
                      </div>
                    </div>
                  </div>

                  <div className="milestone-row verified">
                    <div className="milestone-num-bubble">B</div>
                    <div className="milestone-content">
                      <div className="milestone-title-bar">
                        <div className="milestone-name">Creator & Verifier Bribery Collusion</div>
                        <span className="state-badge state-active">Collusion Defeated</span>
                      </div>
                      <div className="milestone-desc">
                        <strong>Scenario:</strong> Creator colludes with 2 verifiers against 3 honest verifiers to release unearned funds.<br />
                        <strong>Finding:</strong> 3 honest verifiers (3 ETH) outvoted 2 colluders (2 ETH). <strong>0 wei released</strong>. The 2 colluders were slashed <strong>0.2 ETH each</strong>, resulting in negative expected utility.
                      </div>
                    </div>
                  </div>

                  <div className="milestone-row verified">
                    <div className="milestone-num-bubble">C</div>
                    <div className="milestone-content">
                      <div className="milestone-title-bar">
                        <div className="milestone-name">Dispute Spam / Denial of Service Griefing</div>
                        <span className="state-badge state-funding">Griefing Bounded</span>
                      </div>
                      <div className="milestone-desc">
                        <strong>Scenario:</strong> Malicious backer raises rapid consecutive disputes to lock a creator's milestones permanently.<br />
                        <strong>Finding:</strong> 1st dispute opened; 2 subsequent attempts immediately reverted with <code>CooldownActive</code>. The attacker had to lock <strong>0.05 ETH</strong> which gets slashed if baseless.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 6: SECURITY & AUDIT */}
          {activeTab === "security" && (
            <div className="detail-view-container">
              <div className="info-callout">
                <div className="callout-header">
                  <span style={{ fontSize: 24 }}>🔒</span>
                  <h3>Slither Static Analysis & Vulnerability Remediation</h3>
                </div>
                <p className="callout-desc">
                  Smart contracts handling financial escrow must be formally audited.
                  We ran Trail of Bits' <strong>Slither 0.11.6</strong> across 102 automated detectors. Two real High-severity fund-drain vulnerabilities were caught and completely fixed.
                </p>
              </div>

              <div className="two-col-why">
                <div className="why-card" style={{ borderColor: "rgba(16, 185, 129, 0.3)" }}>
                  <div className="why-tag" style={{ color: "#34d399" }}>Fixed: H1 (arbitrary-send-eth)</div>
                  <p className="why-text">
                    <strong>Bug:</strong> <code>Campaign.sweepDust(address)</code> accepted a caller-supplied address, allowing an attacker to sweep integer rounding dust to themselves.<br />
                    <strong>Fix:</strong> Removed the parameter. The destination is now an <code>immutable treasury</code> set in the constructor. Verified by regression tests.
                  </p>
                </div>

                <div className="why-card" style={{ borderColor: "rgba(16, 185, 129, 0.3)" }}>
                  <div className="why-tag" style={{ color: "#34d399" }}>Fixed: H2 (reentrancy-eth & pool drain)</div>
                  <p className="why-text">
                    <strong>Bug:</strong> <code>DisputeResolution.settleJuror</code> had a Checks-Effects-Interactions violation and paid a flat 1% of the <em>entire global bond pool</em> per juror.<br />
                    <strong>Fix:</strong> Added OpenZeppelin <code>ReentrancyGuard</code>, strict CEI ordering, and limited payouts to 50% of the specific dispute's bond divided pro-rata by weight.
                  </p>
                </div>
              </div>

              <div className="milestones-card" style={{ marginTop: 20 }}>
                <div className="section-label" style={{ marginBottom: 14 }}>
                  ✅ Smart Contract Test Suite & Code Coverage Audit (103 Tests Passing)
                </div>
                <table className="modern-table">
                  <thead>
                    <tr>
                      <th>Contract Name</th>
                      <th>Test Suite File</th>
                      <th>Tests Passed</th>
                      <th>Line Coverage</th>
                      <th>Branch Coverage</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><strong>Campaign.sol</strong></td>
                      <td>test/Campaign.lifecycle.test.ts</td>
                      <td>26 tests</td>
                      <td style={{ color: "#34d399", fontWeight: 700 }}>89.2%</td>
                      <td>74.2%</td>
                    </tr>
                    <tr>
                      <td><strong>DisputeResolution.sol</strong></td>
                      <td>test/DisputeResolution.test.ts</td>
                      <td>29 tests</td>
                      <td style={{ color: "#34d399", fontWeight: 700 }}>96.3%</td>
                      <td>82.9%</td>
                    </tr>
                    <tr>
                      <td><strong>CampaignFactory.sol</strong></td>
                      <td>test/CampaignFactory.test.ts</td>
                      <td>5 tests</td>
                      <td style={{ color: "#34d399", fontWeight: 700 }}>96.3%</td>
                      <td>83.3%</td>
                    </tr>
                    <tr>
                      <td><strong>ReputationRegistry.sol</strong></td>
                      <td>test/ReputationRegistry.test.ts</td>
                      <td>10 tests</td>
                      <td style={{ color: "#34d399", fontWeight: 700 }}>94.8%</td>
                      <td>81.8%</td>
                    </tr>
                    <tr>
                      <td><strong>MilestoneVerifier.sol</strong></td>
                      <td>test/MilestoneVerifier.test.ts</td>
                      <td>23 tests</td>
                      <td style={{ color: "#34d399", fontWeight: 700 }}>83.9%</td>
                      <td>71.0%</td>
                    </tr>
                    <tr style={{ background: "rgba(255, 255, 255, 0.04)", fontWeight: 700 }}>
                      <td><strong>Total Protocol Suite</strong></td>
                      <td>10 Hardhat Suites</td>
                      <td>103 Passing</td>
                      <td style={{ color: "#60a5fa" }}>88.7% Lines</td>
                      <td>75.6% Branches</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
