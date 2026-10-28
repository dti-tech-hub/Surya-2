# 🔗 Blockchain-Based Trust Management for Crowdfunding

<div align="center">

![Solidity](https://img.shields.io/badge/Solidity-0.8.20-363636?style=for-the-badge&logo=solidity)
![Hardhat](https://img.shields.io/badge/Hardhat-2.x-yellow?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript)
![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python)
![Contracts Tests](https://img.shields.io/badge/Contracts%20Tests-117%20passing-brightgreen?style=for-the-badge)
![Backend Tests](https://img.shields.io/badge/Backend%20Tests-30%20passing-brightgreen?style=for-the-badge)
![Coverage](https://img.shields.io/badge/Coverage-90.09%25%20statements-yellowgreen?style=for-the-badge)
![Slither](https://img.shields.io/badge/Slither-78%20raw%20findings-orange?style=for-the-badge)

**A B.Tech CSE Final-Year Project — research prototype, not a production deployment**

*Milestone escrow, DID/VC identity, on-chain reputation, stake-weighted disputes, and L2 cost modelling. Every number in this README comes from a committed script or artifact, and every label says what kind of number it is.*

</div>

---

## 📖 What Is This Project?

Traditional crowdfunding platforms ask backers to send money to creators with **no enforceable accountability** for how it is used. Campaigns can fail silently, creators can disappear, and disputes are resolved by the platform rather than by an objective, auditable process.

This project implements a **blockchain-based trust-management prototype** that replaces platform promises with smart-contract-enforced guarantees:

| Problem | Implemented mechanism |
|---|---|
| Funds misused after collection | Milestone escrow; tranches release only after verification |
| Anonymous creators with no track record | On-chain `ReputationRegistry` plus DID/VC credential anchoring |
| No recourse for backers | Stake-weighted dispute resolution with bonds, refunds, and slashing |
| Subjective milestone evaluation | Evidence CID + keccak256 digest, multi-verifier voting, oracle adapter |
| High L1 gas costs | L1-vs-L2 cost model built from locally measured gas |
| Sybil attacks on voting | Every vote requires slashable stake; identity count alone confers no weight |

> **Honest status.** The contracts, backend, indexer, frontend, and ML service run locally and are tested. **No public testnet deployment has been performed**, no real pilot survey has been run, and the ML metrics are from a synthetic corpus. Sections below label every result as `MEASURED`, `SIMULATED`, `MOCK/PROTOTYPE`, or `NOT YET MEASURED`.

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Presentation layer                           │
│   React dApp (built): campaigns, contributions, evidence, voting,    │
│   disputes, reputation, live research-results dashboard              │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTP / REST
┌───────────────────────────────▼──────────────────────────────────────┐
│                        Application layer                             │
│   Express API + reorg-safe event indexer + DID/VC prototype          │
│   Evidence adapter: Pinata → local Kubo IPFS → local content store   │
│   FastAPI ML service: anomaly score from campaign features           │
└──────┬───────────────────────────────────────┬───────────────────────┘
       │ ethers.js                             │ SQLite / local store
┌──────▼───────────────────────────────────────▼───────────────────────┐
│                     Blockchain layer (Solidity 0.8.20)               │
│                                                                      │
│  CampaignFactory ──deploys──► Campaign (milestone escrow)            │
│         │                          │                                 │
│         │ registers                ├──► MilestoneVerifier           │
│         │                          ├──► ReputationRegistry          │
│         │                          └──► DisputeResolution           │
│         └──────────────────────────────► CredentialRegistry          │
└──────────────────────────────────────────────────────────────────────┘
```

### How Trust Flows

1. **Campaign creation** — The creator calls `CampaignFactory.createCampaign`. The factory deploys a fresh `Campaign`, registers it with `MilestoneVerifier`, authorises one dispute module, and acts as the reputation registrar.
2. **Funding** — Backers contribute ETH into escrow. The creator cannot withdraw during funding.
3. **Milestone evidence** — The creator uploads evidence and submits `(CID, keccak256 digest)` on-chain.
4. **Verifier voting** — Staked verifiers vote during a fixed window. Quorum failure defaults to **Reject**; the escrow fails closed.
5. **Dispute** — A backer posts a bond to contest a milestone. Jurors vote with linear or quadratic stake weighting. The tally determines the outcome; settlement is permissionless and applies the result to the campaign.
6. **Reputation** — Milestone and campaign outcomes are written to `ReputationRegistry`. The same integer formula is mirrored in Python and checked for byte-exact parity.

### Identity and evidence

- DIDs use the `did:ethr:<chainId>:<address>` shape.
- Verifiable credentials are W3C-style JSON documents signed with an Ethereum `personal_sign` proof (`EthereumPersonalSignature2021`).
- Only the credential hash is anchored in `CredentialRegistry`; personal data is never written on-chain.
- Evidence storage tries Pinata, then a local Kubo IPFS node, then a local content-addressed store. The fallback is reported as **`local-content-store`** and is **not IPFS**.

---

## 🏷️ Evidence Labels

| Label | Meaning in this repository |
|---|---|
| **`MEASURED`** | Produced by executing the committed code on the local Hardhat EVM. Gas values are real EVM execution measurements. Local latency and throughput are **not** public-network measurements. |
| **`SIMULATED`** | Protocol or economic behaviour modelled by a script, or a cost derived from measured gas × assumed prices. Not a live-network measurement. |
| **`MOCK/PROTOTYPE`** | A deliberately non-production component: mock oracle, DID/VC prototype, local content store, or SQLite instead of a production database. |
| **`NOT YET MEASURED`** | The experiment has not been run. No value is substituted. |

Artifacts are committed under `benchmarks/results/`, `evaluation/results/`, `ml-service/models/`, `coverage/`, and `security/`.

---

## 🚀 Quick Start

### ⚡ One-Click Windows Launchers

For rapid local testing on Windows, two launcher scripts are provided in the repository root:

- `start-full-project.bat` — Automates the entire stack in one click: spins up the local Hardhat node (port 8545), compiles & deploys contracts, seeds sample campaigns, starts the Express API & indexer (port 4000), and opens the frontend dashboard in your browser at `http://localhost:5180`.
- `start-dashboard.bat` — Quick shortcut to start the Vite frontend dashboard server alone at `http://localhost:5180`.

---

### Prerequisites

- Node.js ≥ 18 (backend requires ≥ 22.5 for `node:sqlite`)
- Python ≥ 3.10
- Git

### 1 — Install and test contracts

```bash
npm install --legacy-peer-deps
npx hardhat compile              # also generates TypeChain bindings
npm run typecheck                # compile + tsc --noEmit
npx hardhat test                 # 117 passing across 8 suites
npm run coverage                 # coverage + coverage/coverage-summary.json
```

### 2 — Run a local chain

```bash
# Terminal 1
npx hardhat node

# Terminal 2 — deploy, then seed or run the full lifecycle demo
npx hardhat run scripts/deploy.ts --network localhost
npx hardhat run scripts/seed.ts --network localhost
npx hardhat run scripts/demo.ts --network localhost
```

`scripts/demo.ts` performs the full measured lifecycle: funding, overfunding, evidence, verifier voting, slashing, a dispute, refunds, and reputation updates. It writes `evaluation/results/demo-lifecycle.json`.

### 3 — Backend API and indexer

```bash
cd backend
npm install
npm run migrate
npm test                        # 30 passing tests (migrations, repos, DID/VC, CIDs)
npm run dev                     # http://127.0.0.1:4000
```

The indexer polls the configured chain, stores events in SQLite, handles confirmations and reorg rollback, and exposes campaign, milestone, contribution, dispute, reputation, identity, evidence, and research-result routes.

### 4 — Frontend dApp

```bash
cd frontend
npm install
npm run dev                     # Vite dev server on http://localhost:5180
npm run build                   # typecheck + production build
```

> **Note on Port 5180:** The frontend dev server runs on port 5180 (instead of default 5173) to avoid port collisions and ensure standard EIP-1193 / EIP-6963 browser wallet extensions (such as MetaMask) inject properly into `http://localhost:5180`.

### 5 — ML service

```bash
cd ml-service
python -m pip install -r requirements.txt
python data_generation.py       # synthetic corpus
python train.py                 # Isolation Forest, Random Forest, Logistic Regression
python plot_results.py
python ml_service_api.py        # http://127.0.0.1:8000/docs
```

> On this Windows environment the repository-local `.venv` was blocked by an Application Control policy on a `scipy` DLL. The committed metrics were reproduced with the system `python`; the venv path is not required.

### 6 — Docker Compose (optional)

```bash
cp .env.example .env
docker compose up --build
```

> The Compose file is committed but **was not validated live** in this environment. Treat it as a deployment starting point, not as tested infrastructure.

---

## 📊 Verified Results

### 1. Gas costs — `MEASURED` (local Hardhat EVM, 5 samples)

Source: `benchmarks/results/bench-hardhat.json` (`simulated: true` refers to network conditions, not to the gas values).

| Operation | Min | Median | Max |
|---|---:|---:|---:|
| `CampaignFactory.createCampaign` | 2,576,665 | **2,576,665** | 2,593,765 |
| `Campaign.contribute` | 38,627 | **38,627** | 139,523 |
| `Campaign.submitEvidence` | 189,140 | **189,140** | 206,240 |
| `MilestoneVerifier.castVote` | 119,427 | **119,427** | 119,427 |
| `Campaign.resolveMilestone` | 184,614 | **184,614** | 221,752 |
| `Campaign.claimCreatorBalance` | 55,064 | **55,064** | 55,064 |

Gas depends on bytecode, calldata, and the active gas schedule; these values apply to EVMs using the same schedule. **Latency, throughput, and L1 data-availability cost do not transfer.**

### 2. L1-vs-L2 cost model — `SIMULATED`

Source: `benchmarks/results/l1-vs-l2-comparison.json`. Assumptions: L1 Ethereum Sepolia at **10 gwei**, ETH **$2,500**; L2 Polygon Amoy at **30 gwei**, POL **$0.50**. Combined gas-price × token-price ratio: **1,666.67×**.

| Operation | Median gas | L1 cost (USD) | L2 cost (USD) | L1 cost as % of a $5 pledge |
|---|---:|---:|---:|---:|
| `createCampaign` | 2,576,665 | $64.4166 | $0.038650 | 1,288.33% |
| `contribute` | 38,627 | $0.9657 | $0.000579 | 19.31% |
| `submitEvidence` | 189,140 | $4.7285 | $0.002837 | 94.57% |
| `castVote` | 119,427 | $2.9857 | $0.001791 | 59.71% |
| `resolveMilestone` | 184,614 | $4.6154 | $0.002769 | 92.31% |
| `claimCreatorBalance` | 55,064 | $1.3766 | $0.000826 | 27.53% |

> **Caveats, stated explicitly:** `deployedToTestnet` is `false`. L2 figures exclude the L1 data-availability charge for calldata, which is often the dominant rollup cost. Gas prices are operator assumptions captured at run time, and token prices are assumptions, not measurements. No public-testnet latency or throughput was measured.

### 3. Full lifecycle demo — `MEASURED` (local Hardhat EVM)

Source: `evaluation/results/demo-lifecycle.json`. **33 measured transactions**, 38 logged steps.

| Outcome | Value |
|---|---:|
| Raised | 12.0 ETH against a 10.0 ETH goal (2.0 ETH overfunded) |
| Released to creator | 7.2 ETH (60% first tranche, computed on actual raised) |
| Refunded to backers | 4.8 ETH pro-rata |
| Escrow remaining | 0 wei |
| Final campaign state | `Failed` after the dispute resolved as `Refund` |
| Creator reputation | 3,891 (`Bronze`) |
| Verifier scores | 999 / 999 / 0 (third verifier slashed for minority votes and non-voting) |

Evidence in this run used the `local-content-store` provider. The CIDs are real local content hashes, **not IPFS pins**.

### 4. Tests and coverage — `MEASURED`

Source: `coverage/coverage-summary.json`, generated by `npm run coverage`.

| Contract | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| `Campaign.sol` | 89.40% | 56.82% | 92.86% | 90.82% |
| `CampaignFactory.sol` | 100.00% | 66.67% | 100.00% | 97.06% |
| `CredentialRegistry.sol` | 81.82% | 62.50% | 77.78% | 77.42% |
| `DisputeResolution.sol` | 96.53% | 73.13% | 95.83% | 96.74% |
| `MilestoneVerifier.sol` | 88.10% | 55.19% | 80.00% | 85.34% |
| `ReputationRegistry.sol` | 91.23% | 72.41% | 94.44% | 95.38% |
| `MockOracleAdapter.sol` | 100.00% | 100.00% | 100.00% | 100.00% |
| `ReentrantBacker.sol` (test mock) | 27.27% | 10.00% | 60.00% | 43.75% |
| **Total** | **90.09%** | **62.10%** | **89.17%** | **90.31%** |

- **Solidity tests: 117 passing, 0 failing.**
- **Backend tests: 30 passing, 0 failing.**
- Branch coverage is lower than line coverage because the instrumenter counts every `require`/`revert` path, including defensive branches that tests cannot always reach.

### 5. ML fraud detection — `SIMULATED` (synthetic corpus)

Source: `ml-service/models/metrics.json`. **These metrics measure recovery of a synthetic signal; they are not evidence of real-world fraud-detection performance.**

| Model | Precision | Recall | F1 | ROC-AUC | PR-AUC |
|---|---:|---:|---:|---:|---:|
| Random Forest | 0.9731 | 0.9801 | **0.9766** | 0.9978 | 0.9974 |
| Logistic Regression | 0.9176 | 0.9242 | 0.9209 | 0.9849 | 0.9837 |
| Isolation Forest (unsupervised) | 0.5928 | 0.5939 | 0.5933 | 0.6614 | 0.6317 |

Corpus: `N = 4,000` (2,800 train / 1,200 test), fraud rate 46.18%, 4% label noise, deliberately overlapping feature distributions. The unsupervised model never sees a label and is the relevant cold-start comparison.

### 6. Attack simulations — `SIMULATED`

Source: `evaluation/results/attack-simulations.json`.

| Scenario | Result |
|---|---|
| **Sybil staking** against 5 honest verifiers (1 ETH each) | Attack failed until **8 attacker identities / 8.0 ETH**. Identity count alone confers no influence; each identity costs slashable capital. |
| **Creator–verifier collusion**: 3 honest vs 2 colluding verifiers | Collusion failed. **0 wei released**; each colluder slashed **0.2 ETH** (20%). |
| **Dispute griefing**: 3 milestones, 0.05 ETH bond, 24 h cooldown | **1 dispute raised**, **2 blocked** by cooldown, **0.05 ETH** locked. |

Limitations are recorded in the artifact: the Sybil model only covers capital-funded identities, collusion is modelled as on-chain vote selling, and the dispute cooldown is per address per campaign rather than a global rate limit.

### 7. Static analysis — `MEASURED` (Slither 0.11.6)

Source: `security/slither-report-new.json` and `security/slither-summary.md`.

| Impact | Count |
|---|---:|
| High | 3 |
| Medium | 14 |
| Low | 34 |
| Informational | 21 |
| Optimization | 6 |
| **Total** | **78** |

The **3 High-impact results are all `arbitrary-send-eth` findings in `DisputeResolution` with Medium confidence**. They are triaged as false positives in [`security/SLITHER_REPORT.md`](security/SLITHER_REPORT.md):

1. `_settleCorrectJuror` pays a juror reward to `msg.sender`, but only after the caller is confirmed as a voter who has not claimed; it is a pull payment to an entitled juror.
2. `_settleIncorrectJuror` sends a slash to the immutable `treasury`, not to a caller-supplied address.
3. `_settleBonds` returns the raiser's bond to the recorded raiser and the remainder to the immutable treasury.

Two earlier High findings (caller-chosen dust destination and a juror-settlement accounting/reentrancy defect) were real and were fixed; regression tests remain in `test/Security.regression.test.ts`.

### 8. Pilot survey — `NOT YET MEASURED`

No human participants have been recruited. `evaluation/survey/survey_template.csv` is an empty, header-only data template. `evaluation/survey/sample_responses_SAMPLE_ONLY.csv` contains **synthetic rows that exercise the analysis pipeline**; any SUS score or trust comparison produced from it **must never be reported as a finding**.

---

## 🔒 Security Analysis

- **Threat model:** [`security/THREAT_MODEL.md`](security/THREAT_MODEL.md) — STRIDE analysis across escrow, verifier consensus, dispute panel, identity anchors, and the off-chain indexer.
- **Static analysis and triage:** [`security/SLITHER_REPORT.md`](security/SLITHER_REPORT.md).
- **Regression tests:** `test/Security.regression.test.ts` pins the two historical High fixes, including the bound on juror rewards and the immutable dust destination.
- **Access control:** factory-only campaign registration, factory-only dispute-module binding, admin-gated parameters, and pull-based refunds/withdrawals.
- **Fail-closed quorum:** if the verifier panel does not reach quorum, the milestone is rejected rather than approved.
- **Verifier stake locking:** stake used in a live round is locked, cannot be withdrawn, and can be slashed after settlement; non-voters can be penalised permissionlessly.

**What this does not prove:** no formal verification, no independent audit, and no public-testnet deployment. Slither is a static analyser, not a proof of absence of bugs. Stake concentration, vote front-running, oracle key compromise, admin key compromise, and off-chain collusion remain explicit risks.

---

## 🚫 What Is Not Measured

| Item | Status | Why |
|---|---|---|
| Public-testnet deployment (Sepolia / Amoy) | **`NOT YET MEASURED`** | No funded deployer key; no transactions were sent to a public network. |
| Public-network latency and throughput | **`NOT YET MEASURED`** | Requires a live deployment and repeated transactions. |
| L1 data-availability cost for rollup calldata | **`NOT YET MEASURED`** | The L2 model explicitly excludes it. |
| Pinata / Kubo IPFS pinning | **`NOT YET MEASURED`** | No provider credentials or daemon were configured; the demo used `local-content-store`. |
| Real pilot survey | **`NOT YET MEASURED`** | No human participants. |
| Real-world ML fraud labels | **`NOT YET MEASURED`** | The corpus is synthetic. |
| Docker Compose stack | **`MOCK/PROTOTYPE`** | Written but not executed live in this environment. |
| Formal verification | **`NOT YET MEASURED`** | Assurance comes from tests, coverage, and static analysis only. |

---

## 📁 Repository Layout

```
blockchain-crowdfunding-trust/
├── contracts/                  # Solidity 0.8.20 contracts
│   ├── Campaign.sol            # Milestone escrow, actual-raise tranches, pro-rata refunds
│   ├── CampaignFactory.sol     # Deployment, registration, dispute wiring, reputation registrar
│   ├── MilestoneVerifier.sol   # Stake-weighted voting, quorum, slashing, oracle adapter
│   ├── ReputationRegistry.sol  # Integer reputation scoring, decay, registrar whitelisting
│   ├── DisputeResolution.sol   # Bonds, juror staking, linear/quadratic tally-derived outcomes
│   ├── CredentialRegistry.sol  # DID/VC hash anchoring and revocation
│   ├── interfaces/
│   │   └── IDisputeModule.sol  # Factory-dispute decoupling interface
│   └── mocks/                  # Mock oracle, re-entrancy attacker mock
├── test/                       # 117 Hardhat tests (unit, security, lifecycle, integration fixes)
│   ├── Campaign.lifecycle.test.ts
│   ├── Campaign.security.test.ts
│   ├── DisputeResolution.test.ts
│   ├── DisputeResolution.coverage.test.ts
│   ├── MilestoneVerifier.test.ts
│   ├── ReputationRegistry.test.ts
│   ├── Security.regression.test.ts
│   └── Integration.fixes.test.ts
├── scripts/
│   ├── deploy.ts               # Deploy and wire permissions
│   ├── seed.ts                 # Local development data with realistic deliverables
│   ├── demo.ts                 # Full measured lifecycle demo (33 transactions)
│   └── coverage-summary.mjs    # Converts coverage-final.json for the API
├── benchmarks/                 # Gas and L1/L2 harness; see benchmarks/README.md
│   ├── run-benchmarks.ts
│   ├── compare-l1-l2.ts
│   └── results/                # Measured EVM gas & cost model artifacts
├── evaluation/
│   ├── attack-simulations.ts   # Sybil, collusion, griefing simulations
│   ├── results/                # Committed artifacts & demo lifecycle run
│   └── survey/                 # Instrument, template, synthetic sample, analysis
├── security/                   # Slither 0.11.6 output, triage, STRIDE threat model
├── ml-service/                 # Synthetic data, training, FastAPI service
├── backend/                    # Express API, SQLite indexer, DID/VC, evidence (30 tests)
├── frontend/                   # React dApp, EIP-1193 wallet connector, research dashboard
├── docs/                       # Decisions (DECISIONS.md) & conference paper reference
├── deployments/                # Local deployment manifests
├── start-full-project.bat      # 1-click full stack launcher for Windows
├── start-dashboard.bat         # 1-click dashboard launcher for Windows
├── LICENSE                     # MIT License
└── .github/workflows/          # CI pipeline
```

---

## 🗺️ Objective → Module → Evidence

| Objective | Primary module | Evidence |
|---|---|---|
| O1 — Milestone escrow | `contracts/Campaign.sol` | `test/Campaign.lifecycle.test.ts`, `test/Campaign.security.test.ts`, demo artifact |
| O2 — L1/L2 benchmarking | `benchmarks/run-benchmarks.ts`, `compare-l1-l2.ts` | `benchmarks/results/bench-hardhat.json`, `l1-vs-l2-comparison.json` |
| O3 — Evidence + verifier consensus | `contracts/MilestoneVerifier.sol`, backend evidence adapter | `test/MilestoneVerifier.test.ts`, `test/Campaign.security.test.ts`, demo artifact |
| O4 — Reputation + anomaly detection | `contracts/ReputationRegistry.sol`, `ml-service/` | Parity tests in `test/ReputationRegistry.test.ts`, `ml-service/models/metrics.json` |
| O5 — Dispute resolution | `contracts/DisputeResolution.sol` | `test/DisputeResolution*.test.ts`, demo artifact |
| Security | Slither + threat model + regression tests | `security/SLITHER_REPORT.md`, `THREAT_MODEL.md`, `test/Security.regression.test.ts` |
| Attack analysis | `evaluation/attack-simulations.ts` | `evaluation/results/attack-simulations.json` |
| Identity | `CredentialRegistry.sol`, backend identity service | Backend DID/VC tests and credential E2E |
| Usability | `evaluation/survey/` | Instrument + template only; **no findings** |

---

## 📚 Key Architectural Decisions

Full rationale is in [`docs/DECISIONS.md`](docs/DECISIONS.md). Highlights:

- **Hardhat 2 over Hardhat 3** — Hardhat 3's ESM/top-level-await requirements conflicted with the Node runtime and plugin ecosystem used here.
- **One contract per campaign** — fresh deployment costs ~2.58M gas but gives each campaign immutable references and a smaller blast radius than a clone.
- **`node:sqlite` over native bindings** — avoids Windows native-build failures while providing WAL-mode indexing.
- **Fail-closed quorum** — non-participation rejects a milestone rather than releasing funds.
- **Actual-raise tranches** — tranche amounts are computed from `totalContributed`, so overfunding surplus is released on completion instead of being stranded.
- **Tally-derived disputes** — `resolve` is permissionless; ties become 50/50 `Partial`; no votes become `Refund` and slash the raiser bond.
- **Synthetic ML with label noise** — an earlier disjoint-feature dataset produced F1 = 1.0 and measured only the generator; it was replaced with overlapping classes and 4% noise.
- **Local content store is not IPFS** — the fallback is named `local-content-store` everywhere it surfaces.

---

## 📄 License

MIT © 2024 — see [LICENSE](LICENSE) for full text.

---

<div align="center">

*Built as a B.Tech CSE Final-Year Project. Every figure above is produced by code in this repository and labeled with its evidence class — local measurement, simulation, prototype, or not yet measured.*

</div>
