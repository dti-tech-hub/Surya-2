# Blockchain-Based Trust Management for Crowdfunding: Architecture, Implementation, and Empirical Evaluation

**Conference paper reference document — research prototype**

> **Status and evidence policy.** This document records what was actually implemented and measured. It is **not** a submitted paper and must not be presented as one without the stated limitations.
>
> - Contracts, backend, indexer, frontend, and ML service run on a **local Hardhat EVM**.
> - **No public testnet deployment** (Sepolia, Amoy, or otherwise) has been performed. Public-network latency, throughput, and L1 data-availability costs are **`NOT YET MEASURED`**.
> - ML metrics are computed on a **synthetic** corpus. They measure recovery of an injected signal, not real-world fraud detection.
> - Attack simulations are **`SIMULATED`** protocol executions.
> - The pilot survey has **no human participants**. Its data status is **`NOT YET MEASURED`**; the bundled sample CSV is synthetic and must never be reported as a finding.
> - Every numeric table is labelled `MEASURED`, `SIMULATED`, `MOCK/PROTOTYPE`, or `NOT YET MEASURED`.

---

## Abstract

Traditional crowdfunding platforms concentrate custody, milestone judgement, and dispute settlement in a central operator. Backers therefore bear delivery risk with limited enforceable recourse, while creators face weak incentives to deliver on schedule. This work presents the architecture, formal design, and local empirical evaluation of a blockchain-based trust-management prototype for milestone crowdfunding. The implementation combines five components: (i) a milestone escrow with fail-closed release and pro-rata refunds; (ii) stake-weighted verifier consensus over content-addressed evidence; (iii) a DID/VC identity prototype whose credential hashes are anchored on-chain; (iv) an integer-only on-chain reputation registry with time decay and a byte-exact Python mirror; and (v) a bond-backed dispute module with linear or quadratic juror weighting.

The evaluation is deliberately scoped to a local EVM. Gas consumption is measured across five samples per operation, with medians of 2,576,665 gas for campaign creation, 189,140 for evidence submission, 119,427 for a verifier vote, and 184,614 for milestone resolution. A full lifecycle run executes 33 measured transactions, raises 12 ETH against a 10 ETH goal, releases 7.2 ETH, refunds 4.8 ETH, and leaves zero escrow. A cost model combining measured gas with stated gas-price and token-price assumptions yields a 1,666.67× L1-to-L2 cost ratio, but excludes L1 data-availability fees and is not a testnet measurement. The contract suite passes 117 tests with 90.09% statement coverage and 90.31% line coverage. On a synthetic corpus of 4,000 campaigns with 4% label noise, Random Forest reaches F1 = 0.9766, Logistic Regression F1 = 0.9209, and Isolation Forest F1 = 0.5933. Three simulated adversarial scenarios establish the capital cost of a Sybil takeover, the failure of a 2-of-5 collusion attempt, and the bounded cost of dispute griefing. Static analysis reports 78 raw findings, including three High-impact `arbitrary-send-eth` results that are triaged as false positives. No real-user study, public deployment, or formal verification is claimed.

---

## 1. Introduction and Objectives

### 1.1 Problem

Reward-based crowdfunding creates a temporal mismatch: backers transfer capital before deliverables exist, while the platform controls disbursement and dispute handling. This produces four recurring failures:

1. **Moral hazard after funding.** A creator who receives the full raise has little contractual incentive to continue.
2. **Opaque adjudication.** Platform dispute processes are internal, discretionary, and difficult to audit.
3. **Identity laundering.** Reputation is siloed per platform, so a failed creator can reappear under a new identity.
4. **Economic exclusion.** Layer-1 transaction fees can exceed the value of small pledges.

### 1.2 Objectives

| ID | Objective | Implemented artifact |
|---|---|---|
| **O1** | Milestone escrow with automated release and refunds | `Campaign.sol`, lifecycle and security tests |
| **O2** | L1-vs-L2 economic analysis | `benchmarks/run-benchmarks.ts`, `compare-l1-l2.ts` |
| **O3** | Content-addressed evidence plus stake-weighted verifier consensus | `MilestoneVerifier.sol`, backend evidence adapter |
| **O4** | Deterministic on-chain reputation and anomaly scoring | `ReputationRegistry.sol`, `ml-service/` |
| **O5** | Bonded, stake-weighted dispute resolution | `DisputeResolution.sol`, dispute tests |

### 1.3 Contributions and Non-Claims

**Implemented contributions.** A working five-component prototype; an end-to-end local lifecycle with verifier slashing and dispute-driven refunds; byte-exact on-chain/off-chain reputation parity tests; a reorg-safe SQLite indexer; a DID/VC prototype; and a reproducible artifact pipeline in which the dashboard reads generated JSON rather than hardcoded numbers.

**Explicit non-claims.** This work does **not** claim a public deployment, production security, real-user usability, real fraud-detection performance, or formal correctness. Those are recorded as limitations, not inferred from the local results.

---

## 2. System Architecture

### 2.1 Contract Suite

```
CampaignFactory
  ├── deploys Campaign (one contract per campaign)
  ├── registers Campaign with MilestoneVerifier
  ├── authorises one DisputeResolution module per Campaign
  └── acts as ReputationRegistry registrar
Campaign
  ├── holds escrow
  ├── opens verification rounds
  ├── applies verifier and dispute outcomes
  └── writes milestone/campaign outcomes to ReputationRegistry
MilestoneVerifier
  ├── verifier staking and withdrawal locks
  ├── stake-weighted voting and quorum
  ├── oracle adapter vote with bounded weight
  └── lazy settlement, slashing, and non-voter penalties
DisputeResolution
  ├── juror staking and linear/quadratic weights
  ├── bonded dispute raising and optional challenge bonds
  ├── tally-derived outcomes
  └── pushes the verdict into Campaign escrow
CredentialRegistry
  └── anchors credential hashes and revocation state
ReputationRegistry
  └── integer-only scoring, slash penalty, and harmonic time decay
```

### 2.2 Lifecycle

1. **Creation.** `CampaignFactory.createCampaign` validates that tranche basis points sum to 10,000, deploys `Campaign`, registers it with the verifier, binds the dispute module once, and registers the campaign as a reputation writer.
2. **Funding.** Backers call `contribute` while the campaign is in `Funding` and before the deadline. Contributions are pooled; individual amounts are recorded for pro-rata refunds.
3. **Close.** After the deadline, anyone may call `closeFunding`. Goal met → `Active`; goal missed → `Failed`, making the unreleased pot refundable.
4. **Evidence.** The creator submits `(CID, keccak256 digest)` for a pending milestone. This opens a verifier round and snapshots active stake.
5. **Verification.** Staked verifiers vote `Approve` or `Reject`. Quorum failure resolves as `Reject`. Approval releases a tranche computed from the actual amount raised.
6. **Dispute.** A backer with a non-zero contribution may post the dispute bond. Jurors vote; after the window, anyone may resolve. `Refund`, `Release`, or 50/50 `Partial` is applied to the campaign.
7. **Claims.** Creator balance and backer refunds are pull-based. Rounding dust is sweepable only to the immutable treasury after every backer has claimed.
8. **Reputation.** Milestone delivery, campaign outcome, dispute outcome, verifier correctness, and slashes update the reputation profile.

### 2.3 Evidence and Identity

**Evidence adapter order.** Pinata (if `PINATA_JWT`), then a local Kubo IPFS daemon (if `IPFS_API_URL`), then a local content-addressed store. The fallback is surfaced as `local-content-store` and is **not** IPFS. The lifecycle demo used the fallback; its CIDs are real SHA-256-based CIDv1 raw identifiers but are not pinned or retrievable from the IPFS network.

**DID/VC prototype.** DIDs follow `did:ethr:<chainId>:<address>`. Credentials are W3C-style JSON documents with an Ethereum `personal_sign` proof typed `EthereumPersonalSignature2021`. The backend verifies the signature and expiry. `CredentialRegistry` stores only a credential hash, schema type, holder, issuer, and revocation/expiry metadata; it does not store personal data and does not by itself prove possession of a credential.

### 2.4 Off-Chain Services

- **Indexer:** polls configured contracts, writes events to SQLite with `(tx_hash, log_index)` idempotency, confirms after a configurable depth, and rolls back orphaned blocks.
- **API:** campaign, milestone, contribution, dispute, reputation, identity, evidence, health, config, and research-results routes. Evidence uploads are size-limited and content-addressed.
- **Frontend:** React dApp with campaign list/detail, contributions, evidence upload, verifier actions, dispute actions, and a results dashboard that renders artifact JSON.
- **ML service:** FastAPI endpoint returning a risk score and feature contributions. It is a demonstration service, not an on-chain oracle.

---

## 3. Formal Model

### 3.1 Milestone Escrow

Let `C` be `totalContributed`, `B_k` the basis points of milestone `k`, and `BPS = 10,000`. The constructor enforces `sum(B_k) = BPS` and `1 ≤ M ≤ 32`.

For a verified milestone, the contract uses a cumulative release:

```
newBps   = releasedBps + B_k
cumulative = floor(C * newBps / BPS)
tranche  = min(cumulative - totalReleased, C - totalReleased)
```

This computes each tranche from the **actual amount raised**, not the goal. On the final milestone, `newBps = BPS`, so any overfunding surplus is released rather than stranded. The cumulative form also avoids per-step rounding accumulation.

For a partial dispute outcome with creator share `p` basis points:

```
tranche_k = floor(C * B_k / BPS)
amount    = min(floor(tranche_k * p / BPS), C - totalReleased)
```

The campaign then enters `Failed`, so the remainder is refundable.

For a failed or cancelled campaign, each backer's refund is:

```
r_i = floor(c_i * (C - totalReleased) / C)
```

**Solvency.** Since `sum_i c_i = C` and every `r_i` is floored,

```
sum_i r_i ≤ (C - totalReleased) / C * sum_i c_i = C - totalReleased
```

so refunds plus released tranches cannot exceed deposits. Integer dust is bounded by the number of backers and is recoverable only through `sweepDust()` to the immutable treasury after all claims.

### 3.2 Stake-Weighted Verifier Consensus

At round open, the contract snapshots `S_open = activeStake`. Let `V_app`, `V_rej`, and `W_oracle` be the approve weight, reject weight, and bounded oracle weight. Then `V_voted = V_app + V_rej + W_oracle`.

```
required = floor(S_open * quorumBps / BPS)

if V_voted < required:                 outcome = Reject
else if floor(V_app * BPS / V_voted)
        >= thresholdBps:               outcome = Approve
else:                                  outcome = Reject
```

Quorum failure is **fail-closed**: insufficient participation never releases escrow.

**Settlement.** `settleRound` computes the tally in O(1) and reserves the current reward pool to that round. `claimSettlement` is pull-based:

- Correct voter: `share = floor(poolShare * weight / correctWeight)`, capped at the remaining pool.
- Incorrect voter: `slash = floor(min(voteWeight, currentStake) * slashBps / BPS)`.
- Non-voter: `slash = floor(currentStake * slashBps / BPS)`, callable permissionlessly for a verifier active at round open.
- A fraction `rewardBps` of each slash seeds future round rewards; the remainder goes to the treasury.

Verifier withdrawals are locked while any round is open and for a post-settlement non-voter window, preventing vote-then-withdraw evasion.

### 3.3 Reputation Scoring

All values are integers in basis points. For a subject with counters:

```
delivery   = milestonesOnTime / milestonesTotal          (0 if no milestones)
completion = campaignsCompleted / (campaignsCompleted + campaignsFailed)
dispute    = disputeWins / (disputeWins + disputeLosses)
integrity  = votesCorrect / votesTotal                    (0 if no votes)
```

Each ratio is converted to basis points with floor division. The raw score is:

```
raw = (4000*delivery + 3000*completion + 2000*dispute + 1000*integrity) / 10000
penalty = min(floor(slashedWei / 1e18) * 50, 5000)
raw = max(raw - penalty, 0)
age = block.timestamp - lastUpdated
score = floor(raw * HALF_LIFE / (HALF_LIFE + age))
```

`HALF_LIFE = 180 days`. Tiers: Platinum ≥ 8,000; Gold ≥ 6,500; Silver ≥ 4,000; Bronze ≥ 2,000; otherwise Unrated. The formula is mirrored in `ml-service/reputation.py` and checked against the contract across deterministic profiles.

### 3.4 Dispute Resolution

Defaults: bond `0.05 ETH`, voting window `3 days`, cooldown `1 day`, juror minimum stake `0.1 ETH`, juror slash `10%`, reward share `50%` of a losing raiser bond. The raiser must be an on-chain backer with a non-zero contribution; the bond is read at raise time.

Juror weight:

```
ω(stake) = stake                      if exponent == 1e18 (linear)
         = floor(sqrt(stake))         if exponent == 0.5e18 (quadratic)
```

At resolution, let `F` be weight for refund and `G` weight for the creator:

```
if votedWeight == 0:      outcome = Refund;  raiser bond is slashed to treasury
else if F > G:            outcome = Refund
else if G > F:            outcome = Release
else:                     outcome = Partial, 50/50
```

`resolve` is permissionless after the deadline. The campaign applies `Refund` (fail and unlock refunds), `Release` (release the tranche), or `Partial` (release the creator share and fail the campaign for the remainder). Jurors are rewarded from the dispute's own reserved pool; incorrect jurors are slashed; ties reward all voters and slash nobody.

---

## 4. Threat Model

### 4.1 STRIDE Summary

| ID | Threat | Defense | Status |
|---|---|---|---|
| **S1** | Fake campaign registers itself for verification rewards | `MilestoneVerifier.registerCampaign` restricted to the factory/registrar | Implemented + tested |
| **S2** | Unstaked address votes | `verifiers[msg.sender].active` and minimum stake required | Implemented + tested |
| **S3** | Malicious oracle attestation | Oracle address fixed; oracle weight bounded | Implemented + tested (mock oracle) |
| **S4** | Credential impersonation | DID/VC signature verification; on-chain hash anchoring | **Prototype**; hash alone is not proof of possession |
| **S5** | Off-chain API impersonation | No SIWE-style session binding | **Open** |
| **T1** | Evidence swapped after submission | keccak256 digest committed; milestone leaves `Pending` | Implemented + tested |
| **T2** | Double voting | Per-round vote key mapping | Implemented + tested |
| **T3** | Early settlement | Deadline check in verifier and dispute resolution | Implemented + tested |
| **T4** | Admin changes parameters mid-round | Round snapshots active stake and parameters | Implemented + tested |
| **T5** | Indexer corruption / reorg | `(tx_hash, log_index)` idempotency and reorg rollback | Implemented + tested |
| **R1** | Creator denies evidence submission | `EvidenceSubmitted` event with CID, digest, deadline | Implemented |
| **R2** | Verifier denies vote | `VoteCast` / `RoundSettled` events | Implemented |
| **R3** | Backer cannot prove contribution | `Contributed` event and `contributionOf` | Implemented + tested |
| **R4** | Dispute history unauditable | Dispute events indexed by the backend | Implemented + tested locally |
| **I1** | PII on-chain | Only CIDs, hashes, and addresses | Enforced by design |
| **I2** | Address linkage | Inherent to a public ledger | Accepted |
| **I3** | Public evidence leakage | CIDs are public once submitted | Accepted |
| **D1** | Unbounded settlement loop | O(1) tally; pull-based claims | Mitigated by design |
| **D2** | Abstention blocks quorum | Quorum snapshot plus non-voter penalty | Implemented + tested |
| **D3** | Backer list blocks refunds | Refunds are O(1); `sweepDust` is bounded | Mitigated by design |
| **D4** | Unbounded milestones | `MAX_MILESTONES = 32` | Implemented |
| **D5** | Reverting recipient blocks payouts | Pull-over-push | Implemented |
| **D6** | Dispute griefing | Bond + per-campaign cooldown | Implemented + simulated |
| **E1** | Non-admin changes parameters | `onlyAdmin` on parameter/admin functions | Implemented + tested |
| **E2** | Compromised admin key | Single EOA admin | **Open / accepted** |
| **E3** | Creator releases without verification | Release only through verifier or bound dispute module | Implemented + tested |
| **E4** | Third party claims creator balance | `onlyCreator` | Implemented + tested |
| **E5** | Creator points disputes at their own module | Factory binds the module once | Implemented + tested |

### 4.2 Accepted Risks

1. **Stake concentration.** A capital-rich verifier can hold decisive weight. Quadratic weighting mitigates this in disputes but not in milestone voting.
2. **Vote front-running.** Votes are public during the window. Commit-reveal is future work.
3. **Oracle compromise.** The oracle carries bounded but nonzero influence. The shipped adapter is a mock.
4. **Admin key compromise.** A single EOA controls parameters. A multisig/timelock is required for production.
5. **Off-channel collusion.** On-chain stake weighting cannot detect a creator and verifier coordinating privately.
6. **No formal verification.** Assurance comes from tests, coverage, and static analysis, not proofs.

---

## 5. Experimental Methodology

### 5.1 Environment

| Component | Version / setting |
|---|---|
| OS | Windows (local development machine) |
| Node.js | v24.14.1 |
| Hardhat | 2.29.1 |
| Solidity | 0.8.20 |
| Optimizer | enabled, 200 runs |
| `viaIR` | true |
| Test framework | Hardhat + Chai |
| Type bindings | TypeChain 8.3.2 (`ethers-v6`) |
| Coverage | `solidity-coverage` |
| Static analysis | Slither 0.11.6 |
| Python | 3.14.5 |
| scikit-learn | 1.8.0 |
| pandas | 3.0.1 |
| NumPy | 2.4.4 |
| SciPy | 1.17.1 |

### 5.2 Measurement Labels

- **Gas:** `MEASURED` on the local Hardhat EVM, five samples per operation; median reported.
- **Lifecycle:** `MEASURED` on a local Hardhat node, with transaction hashes recorded.
- **Coverage and tests:** `MEASURED` locally.
- **Cost model:** `SIMULATED`; measured gas multiplied by stated gas-price and token-price assumptions.
- **ML:** `SIMULATED`; synthetic corpus and labels.
- **Attack simulations:** `SIMULATED`; actual contracts executed on the local EVM with modelled adversaries.
- **Survey:** `NOT YET MEASURED`; no participants.
- **Public testnet:** `NOT YET MEASURED`; no funded deployer key and no deployment.

### 5.3 Reproducibility Commands

```bash
npm install --legacy-peer-deps
npx hardhat compile
npm run typecheck
npx hardhat test
npm run coverage

npx hardhat node
npx hardhat run scripts/deploy.ts --network localhost
npx hardhat run scripts/demo.ts --network localhost

npx hardhat run benchmarks/run-benchmarks.ts
BENCH_L1_GWEI=10 BENCH_L2_GWEI=30 BENCH_ETH_USD=2500 BENCH_POL_USD=0.5 \
  npx hardhat run benchmarks/compare-l1-l2.ts
npx hardhat run evaluation/attack-simulations.ts

cd ml-service && python data_generation.py && python train.py && python plot_results.py
```

The cost-model command carries its assumptions explicitly. A bare run uses live
`eth_gasPrice` and refuses implausible testnet values rather than emitting them. On
PowerShell, set the four `BENCH_*` environment variables before running the command.

The demo writes `evaluation/results/demo-lifecycle.json`; benchmarks write `benchmarks/results/`; coverage writes `coverage/coverage-summary.json`; ML writes `ml-service/models/metrics.json`.

---

## 6. Results

### 6.1 Gas Consumption — `MEASURED` (local EVM)

Source: `benchmarks/results/bench-hardhat.json`; five samples per operation.

| Operation | Min | Median | Max |
|---|---:|---:|---:|
| `CampaignFactory.createCampaign` | 2,576,665 | **2,576,665** | 2,593,765 |
| `Campaign.contribute` | 38,627 | **38,627** | 139,523 |
| `Campaign.submitEvidence` | 189,140 | **189,140** | 206,240 |
| `MilestoneVerifier.castVote` | 119,427 | **119,427** | 119,427 |
| `Campaign.resolveMilestone` | 184,614 | **184,614** | 221,752 |
| `Campaign.claimCreatorBalance` | 55,064 | **55,064** | 55,064 |

The benchmark harness does not sample `claimRefund`; the lifecycle demo measured 83,970 gas and 66,870 gas for two backer refunds. Gas depends on bytecode, calldata, and the active gas schedule; these values apply to EVMs using the same schedule, but latency and throughput do not transfer.

### 6.2 L1-vs-L2 Cost Model — `SIMULATED`

Source: `benchmarks/results/l1-vs-l2-comparison.json`. Assumptions: L1 Sepolia at 10 gwei and ETH = $2,500; L2 Amoy at 30 gwei and POL = $0.50. Combined ratio = 1,666.67×. `deployedToTestnet = false`.

| Operation | Median gas | L1 USD | L2 USD | L1 % of $5 pledge | L2 % of $5 pledge |
|---|---:|---:|---:|---:|---:|
| `createCampaign` | 2,576,665 | $64.4166 | $0.038650 | 1,288.33% | 0.773% |
| `contribute` | 38,627 | $0.9657 | $0.000579 | 19.31% | 0.012% |
| `submitEvidence` | 189,140 | $4.7285 | $0.002837 | 94.57% | 0.057% |
| `castVote` | 119,427 | $2.9857 | $0.001791 | 59.71% | 0.036% |
| `resolveMilestone` | 184,614 | $4.6154 | $0.002769 | 92.31% | 0.055% |
| `claimCreatorBalance` | 55,064 | $1.3766 | $0.000826 | 27.53% | 0.017% |

**Interpretation.** Under these assumptions, L1 campaign creation consumes more than twelve times a $5 pledge. L2 execution is cheaper, but the L2 column **excludes the L1 data-availability charge**, which is frequently the dominant rollup cost. The correct conclusion is that L2 is a plausible deployment target worth measuring, not that a 1,666.67× real-world saving has been demonstrated.

### 6.3 Full Lifecycle Demo — `MEASURED` (local Hardhat)

Source: `evaluation/results/demo-lifecycle.json`. The run logged 38 steps and **33 measured transactions**.

| Metric | Value |
|---|---:|
| Goal | 10.0 ETH |
| Raised | 12.0 ETH (2.0 ETH overfunded) |
| First tranche | 60% → 7.2 ETH released |
| Second milestone | Rejected; dispute resolved as `Refund` |
| Total refunded | 4.8 ETH |
| Escrow remaining | 0 wei |
| Final state | `Failed` |
| Creator reputation | 3,891 (`Bronze`) |
| Verifier 1 / 2 / 3 scores | 999 / 999 / 0 |
| Evidence provider | `local-content-store` (not IPFS) |

The third verifier was slashed for a minority milestone vote, penalised for not voting in the second round, and slashed again for a minority dispute vote. The creator withdrew 7.2 ETH before the campaign failed; backers then claimed 2.8 ETH and 2.0 ETH pro-rata.

### 6.4 Tests and Coverage — `MEASURED`

| Contract | Statements | Branches | Functions | Lines |
|---|---:|---:|---:|---:|
| `Campaign.sol` | 89.40% | 56.82% | 92.86% | 90.82% |
| `CampaignFactory.sol` | 100.00% | 66.67% | 100.00% | 97.06% |
| `CredentialRegistry.sol` | 81.82% | 62.50% | 77.78% | 77.42% |
| `DisputeResolution.sol` | 96.53% | 73.13% | 95.83% | 96.74% |
| `MilestoneVerifier.sol` | 88.10% | 55.19% | 80.00% | 85.34% |
| `ReputationRegistry.sol` | 91.23% | 72.41% | 94.44% | 95.38% |
| `MockOracleAdapter.sol` | 100.00% | 100.00% | 100.00% | 100.00% |
| `ReentrantBacker.sol` (mock) | 27.27% | 10.00% | 60.00% | 43.75% |
| **Total** | **90.09%** | **62.10%** | **89.17%** | **90.31%** |

- Solidity: **117 passing, 0 failing**.
- Backend: **30 passing, 0 failing**.
- Coverage totals include test mocks; branch coverage is lower because every defensive `require`/`revert` path is counted.

### 6.5 ML Anomaly Detection — `SIMULATED` (synthetic corpus)

Source: `ml-service/models/metrics.json`. Corpus: 4,000 campaigns, 2,800 train / 1,200 test, 46.18% fraud rate after 4% label noise, seed 42.

| Model | Precision | Recall | F1 | ROC-AUC | PR-AUC | Accuracy |
|---|---:|---:|---:|---:|---:|---:|
| Random Forest | 0.9731 | 0.9801 | **0.9766** | 0.9978 | 0.9974 | 97.83% |
| Logistic Regression | 0.9176 | 0.9242 | 0.9209 | 0.9849 | 0.9837 | 92.67% |
| Isolation Forest | 0.5928 | 0.5939 | 0.5933 | 0.6614 | 0.6317 | 62.42% |

| Model | TN | FP | FN | TP |
|---|---:|---:|---:|---:|
| Isolation Forest | 420 | 226 | 225 | 329 |
| Logistic Regression | 600 | 46 | 42 | 512 |
| Random Forest | 631 | 15 | 11 | 543 |

**Interpretation.** The supervised models recover the injected synthetic signal well. The unsupervised Isolation Forest is near chance on this corpus. That is the useful negative result: it is the only model that never sees a label, which is the deployment condition when no labelled fraud history exists. None of these numbers establishes real-world fraud-detection performance.

### 6.6 Adversarial Simulations — `SIMULATED`

Source: `evaluation/results/attack-simulations.json`.

| Scenario | Setup | Observed outcome |
|---|---|---|
| **A. Sybil staking** | 5 honest verifiers × 1 ETH; quorum 50%, threshold 60% | Approval flipped only at **8 attacker identities / 8.0 ETH**. Identities 1–7 failed. |
| **B. Creator–verifier collusion** | 3 honest vs 2 colluding verifiers × 1 ETH; slash 20%, reward share 50% | **0 wei released**; each colluder’s stake fell from 1.0 to 0.8 ETH. |
| **C. Dispute griefing** | 3 milestones; 0.05 ETH bond; 24 h cooldown | **1 dispute raised**, **2 blocked**; **0.05 ETH** locked. |

**Limitations.** Scenario A models only capital-funded Sybil identities, not compromised or socially engineered verifiers. Scenario B models on-chain vote selling, not private coordination. Scenario C uses one backer; a coalition of distinct addresses could each satisfy the cooldown. These are model limitations, not implementation bugs.

### 6.7 Static Analysis — `MEASURED` (Slither 0.11.6)

Source: `security/slither-report-new.json`; 78 raw findings.

| Impact | Count |
|---|---:|
| High | 3 |
| Medium | 14 |
| Low | 34 |
| Informational | 21 |
| Optimization | 6 |
| **Total** | **78** |

The three High-impact findings are `arbitrary-send-eth` in `DisputeResolution`, all with Medium confidence:

1. `_settleCorrectJuror` transfers a juror reward to `msg.sender`. The caller must be a recorded voter who has not claimed; the reward is bounded by the dispute’s reserved pool; state is updated before the transfer. This is a pull payment to an entitled juror, not an arbitrary destination.
2. `_settleIncorrectJuror` transfers a slash to the immutable `treasury`.
3. `_settleBonds` returns the raiser’s bond to the recorded raiser and the remainder to the immutable treasury.

All three are triaged as false positives in `security/SLITHER_REPORT.md`. This does not mean the code is proven safe: Slither is a static analyser, the detector set is incomplete, and no formal verification or independent audit was performed.

**Medium findings.** Four `divide-before-multiply` results (accepted to preserve deterministic integer/parity behaviour; rounding loss is bounded), two `incorrect-equality` results (intentional enum/sentinel checks), four `reentrancy-no-eth` results (guarded by `nonReentrant` and trusted internal calls), and four `uninitialized-local` results (assigned before read). Low, informational, and optimization findings are summarized in the report.

### 6.8 Pilot Survey — `NOT YET MEASURED`

No human participants were recruited. `evaluation/survey/survey_template.csv` is a header-only template. `sample_responses_SAMPLE_ONLY.csv` is a synthetic file used solely to validate `analysis.py`; its output is stamped `SAMPLE DATA` and must not be reported as a finding. Any SUS score, trust-before/after difference, or effect size from that file describes generated numbers.

---

## 7. Threats to Validity

### 7.1 Construct Validity

- Gas is a real EVM measurement, but **gas is not cost**. USD figures depend on assumed gas prices and token prices.
- The L1/L2 comparison excludes L1 data-availability cost, so L2 figures are optimistic.
- The demo is a scripted scenario, not a sample of real campaigns.

### 7.2 Internal Validity

- The test suite is broad but not exhaustive; 62.10% branch coverage leaves defensive paths unexercised.
- Slither findings are detector outputs, not confirmed vulnerabilities; triage is manual and could miss an issue.
- The ML split is stratified and the vectoriser is fit on training data only, but the corpus is generated by a single script with a single seed.

### 7.3 External Validity

- No public testnet or mainnet deployment was performed.
- No real users, campaigns, evidence, or disputes were observed.
- The synthetic ML corpus cannot establish real-world fraud-detection performance.
- The `local-content-store` fallback is not IPFS and provides no network availability guarantee.

### 7.4 Conclusion Validity

- Attack simulations are deterministic scenarios, not statistical estimates of attacker behaviour.
- The survey has no data, so no usability or trust claim is made.
- The reputation model’s weights (4,000/3,000/2,000/1,000) are design choices, not empirically calibrated parameters.

### 7.5 Security Validity

- No formal verification, independent audit, or bug bounty.
- Single-EOA admin and oracle keys remain centralisation risks.
- Vote front-running and off-channel collusion are not solved.
- The mock oracle is explicitly non-production.

---

## 8. Conclusion

The prototype demonstrates that the five trust components can be composed into a working local system: escrowed funding, stake-weighted verification, DID/VC hash anchoring, deterministic reputation, and bonded dispute resolution. The measured lifecycle shows the escrow remaining solvent through overfunding, a rejected milestone, verifier slashing, a dispute-driven refund, and full backer compensation. The test and coverage results provide reasonable assurance for a prototype, and the static-analysis triage documents both historical fixes and current false positives.

The evaluation does **not** establish production readiness. The missing evidence is specific and material: a funded public-testnet deployment, real latency/throughput and L1 data-availability measurements, real IPFS pinning, a human pilot study, real fraud labels, an independent audit, and formal verification. Those are the correct next steps; substituting modelled or synthetic values for them would invalidate the paper’s claims.

---

## Appendix: Variable Lookup

| Symbol | Type / unit | Meaning |
|---|---|---|
| `C` | `uint256` wei | `totalContributed`, the actual amount raised |
| `B_k` | `uint16` bps | Tranche share of milestone `k`; `sum B_k = 10,000` |
| `BPS` | `uint256` | 10,000 basis points |
| `R_pot` | `uint256` wei | `C - totalReleased`, refundable pot |
| `r_i` | `uint256` wei | Pro-rata refund for backer `i` |
| `S_open` | `uint128` wei | Active verifier stake snapshotted at round open |
| `V_app`, `V_rej` | `uint128` wei | Approve and reject vote weight |
| `W_oracle` | `uint256` wei | Bounded oracle vote weight |
| `ω_j` | `uint256` | Juror weight under the configured curve |
| `S(t)` | `uint256` bps | Decayed reputation score in `[0, 10,000]` |
| `T_half` | `uint256` seconds | Reputation half-life, 180 days |
| `B_dispute` | `uint256` wei | Dispute bond, default 0.05 ETH |
| `p` | `uint16` bps | Creator share in a `Partial` dispute outcome |

---

## Artifact Index

| Artifact | Contents | Label |
|---|---|---|
| `benchmarks/results/bench-hardhat.json` | Per-transaction gas, local throughput samples, caveats | Gas `MEASURED`; throughput local/simulated |
| `benchmarks/results/l1-vs-l2-comparison.json` | Gas × assumed price cost model | `SIMULATED` |
| `evaluation/results/demo-lifecycle.json` | Full lifecycle transactions, gas, outcomes, reputation | `MEASURED` (local) |
| `evaluation/results/attack-simulations.json` | Sybil, collusion, griefing scenarios | `SIMULATED` |
| `ml-service/models/metrics.json` | Synthetic ML metrics and confusion matrices | `SIMULATED` |
| `coverage/coverage-summary.json` | Solidity coverage summary | `MEASURED` |
| `security/slither-report-new.json` | Raw Slither findings | `MEASURED` (static analysis) |
| `security/slither-summary.md` | Detector counts | `MEASURED` (static analysis) |
| `security/SLITHER_REPORT.md` | High/Medium triage and limitations | Analysis |
| `evaluation/survey/survey_template.csv` | Header-only survey template | `NOT YET MEASURED` |
| `evaluation/survey/sample_responses_SAMPLE_ONLY.csv` | Synthetic pipeline-validation rows | `SIMULATED` / sample only |
