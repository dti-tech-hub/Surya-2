# 🔗 Blockchain-Based Trust Management for Crowdfunding

<div align="center">

![Solidity](https://img.shields.io/badge/Solidity-0.8.20-363636?style=for-the-badge&logo=solidity)
![Hardhat](https://img.shields.io/badge/Hardhat-2.x-yellow?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript)
![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)
![Tests](https://img.shields.io/badge/Tests-103%20passing-brightgreen?style=for-the-badge)
![Coverage](https://img.shields.io/badge/Coverage-88.7%25-yellowgreen?style=for-the-badge)

**A B.Tech CSE Final-Year Project**

*Milestone-escrow crowdfunding with verifiable identity, on-chain reputation, and stake-weighted dispute resolution — built transparently with every number produced by a script, not estimated.*

</div>

---

## 📖 What Is This Project?

Traditional crowdfunding platforms (Kickstarter, Indiegogo) suffer from a fundamental trust problem: backers send money to creators with **no enforceable accountability** for how funds are used. Campaigns can fail silently, creators can disappear with funds, and there is no objective mechanism for dispute resolution.

This project proposes and implements a **blockchain-based trust management framework** that replaces platform-level promises with **smart-contract-enforced guarantees**:

| Problem | Solution Implemented |
|---|---|
| Funds misused after collection | Milestone-based escrow — funds released only on verified delivery |
| Anonymous creators with no track record | On-chain `ReputationRegistry` with verifiable DID/VC credential anchoring |
| No recourse for backers | Stake-weighted dispute resolution with automatic refunds and juror slashing |
| Subjective milestone evaluation | Cryptographic evidence (IPFS CIDs), multi-verifier voting, oracle adapter |
| High L1 gas costs excluding small campaigns | L1 vs L2 benchmarking harness with live gas price comparison |
| Sybil attacks on voting | Every vote costs slashable capital; identity count alone confers no power |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Presentation Layer                        │
│              React dApp  ← (schema written, not built)          │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP / REST
┌──────────────────────────▼──────────────────────────────────────┐
│                       Application Layer                          │
│   Express API (schema + repos done)  │  Veramo DID/VC (stub)   │
│   Event Indexer (stub)               │  Python ML Service (done)│
└──────┬───────────────────────────────┬────────────────────────-─┘
       │ ethers.js                     │ SQLite / IPFS
┌──────▼───────────────────────────────────────────────────────────┐
│                        Blockchain Layer  (Solidity 0.8.20)       │
│                                                                  │
│  CampaignFactory ──deploys──► Campaign (milestone escrow)        │
│                                    │                             │
│                          MilestoneVerifier (stake-weighted vote)  │
│                                    │                             │
│                          ReputationRegistry (on-chain scores)    │
│                                    │                             │
│                          DisputeResolution (bonds + slashing)    │
│                                    │                             │
│                          CredentialRegistry (DID/VC anchoring)   │
└──────────────────────────────────────────────────────────────────┘
```

### How Trust Flows

1. **Campaign Creation** — Creator deploys via `CampaignFactory`, defining milestones, targets, and verifier stakes.
2. **Funding** — Backers contribute ETH held in escrow; no funds touch the creator until a milestone is approved.
3. **Milestone Submission** — Creator pins evidence to IPFS, submits `(CID, keccak256)` on-chain.
4. **Verifier Voting** — Registered verifiers cast stake-weighted votes during a window. Quorum failure defaults to **Reject** — the escrow fails closed.
5. **Dispute** — Any backer may post a bond to contest a milestone. Jurors vote with linear or quadratic stake weighting; resolution routes balance, returns or slashes bonds, and updates reputation.
6. **Reputation** — Every resolution (approval, rejection, dispute outcome) updates the creator and verifier scores in `ReputationRegistry`, mirrored exactly in the off-chain Python model.

---

## 📁 Repository Layout

```
blockchain-crowdfunding-trust/
│
├── contracts/                  # All Solidity smart contracts
│   ├── Campaign.sol            # Core milestone escrow logic
│   ├── CampaignFactory.sol     # Factory pattern — one deploy per campaign
│   ├── MilestoneVerifier.sol   # Stake-weighted voting + oracle adapter
│   ├── ReputationRegistry.sol  # On-chain reputation scoring
│   ├── DisputeResolution.sol   # Bonds, quadratic/linear juror weights, slashing
│   ├── CredentialRegistry.sol  # DID/VC credential anchoring
│   ├── interfaces/
│   │   └── IOracleAdapter.sol  # Oracle adapter interface
│   └── mocks/
│       ├── MockOracleAdapter.sol
│       └── ReentrantBacker.sol # Re-entrancy attack mock for tests
│
├── test/                       # Hardhat test suites (103 tests total)
│   ├── Campaign.lifecycle.test.ts       # 14 tests: escrow lifecycle end-to-end
│   ├── Campaign.security.test.ts        # 12 tests: access control, oracle
│   ├── CampaignFactory.test.ts
│   ├── MilestoneVerifier.test.ts        # 11 tests: quorum, double-vote prevention
│   ├── ReputationRegistry.test.ts       # 10 tests incl. on-chain/off-chain parity
│   ├── DisputeResolution.test.ts        # 13 tests: bonds, voting, slashing
│   ├── DisputeResolution.coverage.test.ts # 15 additional coverage tests
│   ├── CredentialRegistry.test.ts
│   ├── Security.regression.test.ts      # Regression tests for H1/H2 security fixes
│   └── helpers.ts
│
├── scripts/
│   ├── deploy.ts               # Deploy + permission wiring script
│   └── seed.ts                 # Seed script for local testing
│
├── benchmarks/                 # Gas benchmarking harness
│   ├── run-benchmarks.ts       # Measures local EVM gas per operation
│   ├── compare-l1-l2.ts        # Combines measured gas with live gas prices
│   └── results/                # Committed benchmark outputs (CSV + JSON)
│
├── evaluation/                 # Attack simulations and usability study
│   ├── attack-simulations.ts   # Sybil, collusion, griefing scenarios
│   ├── survey/                 # Study instrument + analysis pipeline
│   └── results/                # Attack simulation outputs
│
├── security/                   # Static analysis and threat model
│   ├── SLITHER_REPORT.md       # Full Slither findings with triage
│   ├── THREAT_MODEL.md         # STRIDE analysis of all trust boundaries
│   ├── slither-report.json     # Raw Slither JSON
│   └── triage_slither.py       # Triage automation script
│
├── ml-service/                 # Python ML fraud detection service
│   ├── data_generation.py      # Synthetic campaign data generator
│   ├── train.py                # Trains IsolationForest, RandomForest, LR
│   ├── reputation.py           # Off-chain mirror of ReputationRegistry.sol
│   ├── ml_service_api.py       # FastAPI service (http://localhost:8000/docs)
│   ├── plot_results.py         # Metric visualizations
│   ├── models/                 # Trained model files + metrics.json
│   └── Dockerfile
│
├── backend/                    # Express API + SQLite backend
│   └── src/
│       ├── db/                 # Schema, migrations, repository layer (21 tests)
│       ├── routes/             # API routes (stub)
│       ├── chain/              # Chain event listener (stub)
│       └── indexer/            # Event indexer (stub)
│
├── frontend/                   # React dApp (structure only, not built)
│
├── docs/
│   └── DECISIONS.md            # All significant architectural decisions
│
├── .github/workflows/          # GitHub Actions CI pipeline
├── docker-compose.yml          # Full-stack compose (written, not tested live)
├── hardhat.config.ts           # Hardhat config (Sepolia, Amoy, Arbitrum Sepolia)
├── .env.example                # Environment variable template
└── tsconfig.json
```

---

## 🛠️ Tech Stack & Why We Chose It

### Blockchain / Smart Contracts

| Technology | Version | Why |
|---|---|---|
| **Solidity** | 0.8.20 | Stable, well-audited, native overflow protection. 0.8.20 is the latest minor before 0.8.21's custom errors overhaul. |
| **Hardhat** | 2.x | Mature plugin ecosystem, fast in-process EVM, Hardhat 3 was in alpha with breaking changes (documented in DECISIONS.md). |
| **OpenZeppelin Contracts** | 5.x | Industry-standard `ReentrancyGuard`, `Ownable`, `Pausable`. Avoids reimplementing security primitives. |
| **ethers.js** | 6.x | TypeScript-first, tree-shakeable, required by Hardhat v2 plugins. |
| **hardhat-gas-reporter** | 2.x | Per-function gas tracking, USD conversion with live gas prices. |
| **solidity-coverage** | 0.8.x | Istanbul-based branch coverage for Solidity. |
| **Slither** | latest | Trail of Bits static analyser; 102 detectors, runs in CI. |

### Backend & Indexer

| Technology | Why |
|---|---|
| **Node.js / Express** | Lightweight REST layer; same runtime as the Hardhat scripts. |
| **SQLite (node:sqlite)** | Zero-dependency embedded DB for the indexed event cache. Chosen over `better-sqlite3` to avoid native compilation issues (see DECISIONS.md D-008). |
| **TypeScript** | End-to-end type safety across contracts, scripts, and backend. |

### ML / Analytics

| Technology | Why |
|---|---|
| **Python 3.10+** | Scientific stack (scikit-learn, pandas, matplotlib) lives here. |
| **scikit-learn** | IsolationForest (unsupervised anomaly), RandomForest and Logistic Regression (supervised). Three models chosen to compare unsupervised vs supervised under the same synthetic corpus. |
| **FastAPI** | Async Python HTTP server; auto-generates OpenAPI docs at `/docs`. |
| **pandas / matplotlib** | Data wrangling and metric visualizations. |

### Infrastructure

| Technology | Why |
|---|---|
| **Docker Compose** | Single-command local environment (PostgreSQL, ML service, backend). |
| **GitHub Actions** | CI on every push: compile → lint → test → Slither. |
| **IPFS (Pinata)** | Decentralized, content-addressed evidence storage. CIDs are committed on-chain; evidence is immutable. |

---

## 🚀 Quick Start

### Prerequisites

- Node.js ≥ 18 (or use the bundled `node18/` portable runtime)
- Python ≥ 3.10
- Git

### 1 — Clone & Install

```bash
git clone https://github.com/dti-tech-hub/Surya-2.git
cd Surya-2
npm install --legacy-peer-deps
```

### 2 — Compile & Test Contracts

```bash
npx hardhat compile
npx hardhat test
```

### 3 — Coverage & Gas Report

```bash
npx hardhat coverage           # HTML report in coverage/
REPORT_GAS=true npx hardhat test   # Per-function gas table
```

### 4 — Local Deployment

```bash
# Terminal 1 — start local Hardhat node
npx hardhat node

# Terminal 2 — deploy contracts + wire permissions
npx hardhat run scripts/deploy.ts --network localhost
```

### 5 — Backend

```bash
cd backend
npm install
npm run migrate
npm test        # 21 repository-layer tests
```

### 6 — ML Service

```bash
cd ml-service
pip install -r requirements.txt
python data_generation.py      # Generate synthetic dataset
python train.py                # Train all three models
python plot_results.py         # Visualize metrics
python ml_service_api.py       # Start API at http://127.0.0.1:8000/docs
```

### 7 — Full Stack via Docker (optional)

```bash
cp .env.example .env           # Fill in any keys you have
docker compose up --build
```

> **Note:** Copy `.env.example` to `.env` before any command that touches a real network.

---

## ✅ Project Status — Honest Accounting

| Objective | Status | Evidence |
|---|---|---|
| **O1** Milestone escrow with automated release and refunds | ✅ **Done** | `Campaign.sol`, 14 lifecycle tests: success path, failed funding, pro-rata refunds, rejected milestone, double-claim refusal |
| **O2** Gas & cost benchmarking (L1 vs L2) | ⚠️ **Partial** | Gas **measured** locally. Live gas prices **fetched**. **No live testnet deployment** (no funded key). L1-vs-L2 USD comparison is a model under stated assumptions. |
| **O3** IPFS evidence + stake-weighted verifier voting + oracle | ✅ **Done (contract level)** | `MilestoneVerifier.sol`: quorum snapshot, oracle adapter. IPFS upload path exists; **Pinata not configured**, so live pinning untested. |
| **O4** On-chain reputation + ML anomaly detection | ✅ **Done (with caveat)** | `ReputationRegistry.sol` verified byte-exact against Python mirror. ML trains and scores. **Data is synthetic** — metrics measure generator recovery, not real fraud. |
| **O5** Dispute resolution with stake-weighted jurors | ✅ **Done** | `DisputeResolution.sol`, 29 tests. Bonds, linear/quadratic weight curve, cooldown, juror slashing. |

### What Is Not Yet Built

| Component | Status |
|---|---|
| Backend API routes, event indexer, Veramo agent | **Partial** — DB schema, migrations, and repositories complete + tested (21 tests). Routes and indexer are stubs. |
| React dApp (frontend/) | **Not built** — directory structure only |
| Docker Compose | **Written, not executed** — images were never built in this environment |
| User study | **Instrument and analysis pipeline only** — all survey data is synthetic; no participants recruited |
| Formal verification | **None** — all assurance from tests and Slither |

---

## 📊 Measured Results

All figures below were produced by scripts in this repository and are fully reproducible. Raw output lives under `benchmarks/results/`, `evaluation/results/`, and `ml-service/models/metrics.json`.

### Gas Costs (Local EVM — Measured)

| Operation | Gas (median) | @ 10 gwei / \$2,500 ETH |
|---|---|---|
| `CampaignFactory.createCampaign` | 2,426,705 | ~\$60 |
| `Campaign.submitEvidence` | 164,194 | ~\$4.10 |
| `Campaign.resolveMilestone` | 159,723 | ~\$4.00 |
| `MilestoneVerifier.castVote` | 97,697 | ~\$2.44 |
| `Campaign.claimRefund` | 79,156 | ~\$1.98 |
| `Campaign.claimCreatorBalance` | 56,786 | ~\$1.42 |
| `Campaign.closeFunding` | 42,193 | ~\$1.05 |

> **Key finding:** `createCampaign` costs ~\$60 on L1, which is ~12× a \$5 contribution. L1 is unviable for small campaigns — this is why L2 comparison matters.

### ML Model Performance (Synthetic Data)

| Model | Precision | Recall | F1 | ROC-AUC |
|---|---|---|---|---|
| Isolation Forest (unsupervised) | 0.593 | 0.594 | 0.593 | 0.661 |
| Random Forest | 0.973 | 0.980 | 0.977 | 0.998 |
| Logistic Regression | 0.918 | 0.924 | 0.921 | 0.985 |

> **Caveat:** These numbers measure a synthetic generator with deliberate 4% label noise and overlapping class distributions. Isolation Forest near-chance is the *useful* result: it never sees a label, which is the real deployment condition.

### Attack Simulations

| Scenario | Outcome |
|---|---|
| Sybil staking vs 5 honest verifiers | Attacker needed 6–8 funded identities (6–8 ETH) to flip the round. Capital cost is the sybil deterrent. |
| Creator + 2 colluding verifiers vs 3 honest | Collusion **failed**. 0 wei released; colluders' bonds slashed 0.2 ETH each. |
| Dispute griefing | 1 dispute opened, 2 blocked by per-campaign cooldown, 0.05 ETH locked. |

---

## 🔒 Security

`slither` (102 detectors) reports **0 High** findings in the final codebase. Two High findings were discovered during development and fixed:

| ID | Finding | Severity | Fix |
|---|---|---|---|
| **H1** | `sweepDust(address)` sent ETH to a caller-supplied address while NatSpec claimed otherwise | High | Parameter removed; `treasury` is now immutable |
| **H2** | `settleJuror` had a CEI violation + no reentrancy guard + could drain ~N% of bond pool per juror in N disputes | High | Added `nonReentrant`, fixed CEI ordering, changed reward to pro-rata by weight from the dispute's own bond |

Each fix has a regression test in `test/Security.regression.test.ts` that **fails** if the fix is reverted.

See [`security/SLITHER_REPORT.md`](security/SLITHER_REPORT.md) for full triage of remaining Medium findings, and [`security/THREAT_MODEL.md`](security/THREAT_MODEL.md) for the STRIDE analysis including five risks the system explicitly does **not** solve (stake concentration, vote front-running, oracle trust, admin key compromise, absence of formal verification).

---

## 🧪 Test Summary

```
Solidity Tests   103 passing   88.7% line coverage
  Campaign              89.2%
  MilestoneVerifier     83.9%
  ReputationRegistry    94.8%
  CampaignFactory       96.3%
  DisputeResolution     96.3%
  CredentialRegistry    77.4%   ← below 90% target (untested view branches)

Backend Tests     21 passing
  Repositories, idempotency, reorg rollback, FK cascade
```

---

## 🗺️ Objective → Module → Evidence

| Objective | Primary Module | Test Evidence |
|---|---|---|
| O1 – Milestone escrow | `contracts/Campaign.sol` | `test/Campaign.lifecycle.test.ts` (14 tests) |
| O2 – L1 vs L2 benchmarking | `benchmarks/run-benchmarks.ts`, `compare-l1-l2.ts` | `benchmarks/results/*.json` |
| O3 – Evidence + voting + oracle | `contracts/MilestoneVerifier.sol` | `test/MilestoneVerifier.test.ts` (11), `Campaign.security.test.ts` (12) |
| O4 – Reputation + anomaly detection | `contracts/ReputationRegistry.sol`, `ml-service/` | `test/ReputationRegistry.test.ts` (10 incl. byte-exact on/off-chain parity) |
| O5 – Dispute resolution | `contracts/DisputeResolution.sol` | `test/DisputeResolution.test.ts` (13) + `coverage.test.ts` (15) |
| Security | Slither + threat model | `security/SLITHER_REPORT.md`, `THREAT_MODEL.md` |
| Attack analysis | `evaluation/attack-simulations.ts` | `evaluation/results/attack-simulations.json` |

---

## 📚 Key Architectural Decisions

Full rationale for every decision is in [`docs/DECISIONS.md`](docs/DECISIONS.md). Highlights:

- **Hardhat 2 over Hardhat 3** — Hardhat 3 was in alpha with frequent breaking API changes; 2.x had the stable plugin ecosystem needed for `hardhat-gas-reporter` and `solidity-coverage`.
- **`node:sqlite` over `better-sqlite3`** — Avoids native compilation on Windows; the built-in module is sufficient for the index/cache workload.
- **SQLite over PostgreSQL** — Appropriate for the current scale; migration path to PostgreSQL is documented with real limits.
- **`viaIR: true` in Solidity** — Required to prevent EVM stack-depth errors that `solidity-coverage` instrumentation introduces in `DisputeResolution.settleJuror`.
- **Synthetic ML data with label noise** — First iteration used disjoint feature ranges and produced F1 = 1.0 on every model, which measured the generator, not any signal. Data was redesigned to overlap classes and inject 4% noise.

---

## 📄 License

MIT © 2024 — see [LICENSE](LICENSE) for full text.

---

<div align="center">

*Built as a B.Tech CSE Final-Year Project — every figure in this README was produced by a script in this repository, not estimated.*

</div>