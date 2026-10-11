# Threat Model (STRIDE)

Scope: the milestone-escrow contracts (`Campaign`, `CampaignFactory`,
`MilestoneVerifier`) and the off-chain trust services that feed them. Written alongside
the code and updated as components are added.

Assets at risk
1. Escrowed user funds held in each `Campaign` contract.
2. The integrity of milestone verification (a false Approve releases money early).
3. Verifier stake, which is the economic security budget of the whole system.
4. Creator reputation, which downstream lenders/investors may rely on.
5. Campaign metadata and evidence availability (IPFS pinning).

Out of scope for now: ML service internals (separate threat model pending),
frontend wallet handling, and the KYC issuer's key custody.

---

## 1. Spoofing

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| S1 | Attacker registers a fake campaign contract to open verification rounds | `MilestoneVerifier.registerCampaign` | Restricted to `admin` and addresses holding the registrar role; only the factory is granted it. Arbitrary callers get `NotRegistrar`. | Implemented + tested |
| S2 | Attacker votes without staking | `MilestoneVerifier.castVote` | Requires `verifiers[msg.sender].active`; unstaking requires withdrawing stake. Reverts `NotActiveVerifier`. | Implemented + tested |
| S3 | Attacker spoofs an oracle attestation | `IOracleAdapter` / `submitOracleVote` | Only the configured oracle address may submit; `oracleWeight` is bounded so it cannot dominate. | Access control implemented + tested |
| S4 | Creator presents someone else's identity credential | `IdentityGate` (planned) | Not implemented. Design constraint recorded in D-007: store credential *hashes* only, verify off-chain, never accept an on-chain hash as proof of possession on its own. | **Open** |
| S5 | Verifier impersonation via the off-chain API | `backend` | Not implemented. Requires signature-based (SIWE-style) auth tying API sessions to a signing key. | **Open** |

## 2. Tampering

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| T1 | Creator swaps evidence after submission | `Campaign.submitEvidence` | The keccak256 `evidenceHash` is committed on-chain; verifiers re-hash the IPFS content and reject on mismatch. `evidenceHash` cannot be overwritten because the milestone is no longer `Pending`. | Implemented + tested |
| T2 | Verifier re-casts a vote to flip the tally | `MilestoneVerifier.castVote` | One vote per `(campaign, index, verifier)`, enforced by the `voteOf` mapping and `AlreadyVoted`. | Implemented + tested |
| T3 | Someone settles a round early to influence it | `settleRound` | Requires `block.timestamp >= voteDeadline`. | Implemented + tested |
| T4 | Admin silently changes voting parameters mid-campaign | `setParameters` | New parameters apply only to rounds opened afterwards; a round snapshots `activeStakeAtOpen` at open time. Admin changes still emit an event. | Implemented |
| T5 | Indexer writes attacker-controlled data into the DB | `backend` indexer | Not implemented. Planned control: idempotent inserts keyed on `(txHash, logIndex)` plus N-confirmation reorg handling. | **Open** |

## 3. Repudiation

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| R1 | Creator denies submitting evidence | `Campaign` | `EvidenceSubmitted` event carries CID, digest and timestamp. | Implemented |
| R2 | Verifier denies voting | `MilestoneVerifier` | `VoteCast` event per vote; `RoundSettled` carries the tallies. | Implemented |
| R3 | Backsers cannot prove contributions | `Campaign` | `Contributed` event per contribution; `contributionOf` is readable per address. | Implemented |
| R4 | Disputes are hard to audit after the fact | `DisputeResolution` | Not implemented. All dispute transitions will emit events and be indexed. | **Open** |

## 4. Information disclosure

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| I1 | PII written on-chain | all contracts | Evidence is CID + digest only; credentials are hashes only. See D-007. | Enforced by design |
| I2 | Backer identity exposure | `Campaign` | `Contributed` links an address to a contribution. This is inherent to a public ledger and is mitigated by using a fresh address or a privacy layer, not by the contract. | Accepted, documented |
| I3 | Private evidence leaked | `Campaign` / IPFS | CIDs are guessable only by brute force, but *are* public once submitted. Evidence that must stay confidential should not be put on IPFS. | Accepted, documented |

## 5. Denial of service

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| D1 | Whale makes milestone settlement impossible by inflating the voter set | `settleRound` | Settlement is O(1); rewards/slashes are claimed lazily. No loop over voters. See D-004. | Mitigated by design |
| D2 | Whale abstains to hold quorum unreachable | `MilestoneVerifier` | Quorum is computed against `activeStakeAtOpen` (a snapshot), so new stake cannot inflate the denominator after the round opens. Non-voters can be penalised via `penalizeNonVoter`. | Implemented |
| D3 | Contributor list grows unboundedly, making refund iteration expensive | `Campaign.sweepDust` | `sweepDust` is the only loop over backers and it is an admin/permissionless cleanup that cannot block refunds. Refunds themselves are O(1) per backer. | Mitigated by design |
| D4 | Bounded milestone count | `Campaign` | `MAX_MILESTONES = 32`, enforced in the constructor. | Implemented |
| D5 | A reverting recipient blocks payouts | `Campaign` | Pull-over-push: recipients claim their own funds, so one reverting address cannot stall others. | Implemented |
| D6 | Griefing disputes at negligible cost | `DisputeResolution` | Not implemented. Will require a bond + cooldown. | **Open** |

## 6. Elevation of privilege

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| E1 | Non-admin changes quorum/threshold | `setParameters`, `setRegistrar`, `transferAdmin`, `setTreasury` | All `onlyAdmin`; tested. | Implemented + tested |
| E2 | Compromised admin key | `MilestoneVerifier` | Single EOA admin. **Known weakness.** A production system should use a multisig or timelock; not implemented. | **Open** |
| E3 | Creator releases funds without verification | `Campaign` | Tranches are released only inside `_releaseTranche`, which is reachable only from `resolveMilestone` when the verifier returns Approve. `claimCreatorBalance` can only withdraw an already-accrued balance. | Implemented + tested |
| E4 | Someone else claims the creator's balance | `claimCreatorBalance` | `onlyCreator`. | Implemented |

---

## Explicitly accepted risks

These are *not* solved. They are recorded so that no reader mistakes this system for
one that is.

1. **Stake concentration.** A verifier holding most of the stake decides most rounds.
   Weighting by stake raises attack cost; it does not bound influence. Mitigation would
   be a cap on per-entity weight, which is configurable in the dispute module but not yet
   applied to milestone voting.
2. **Vote front-running.** Votes are public during the voting window. A verifier can
   observe peers and follow the crowd. The window bounds the opportunity and slashing
   punishes majority-inconsistent behaviour, but a commit-reveal scheme is the real fix
   and is future work.
3. **Oracle trust.** Whatever the oracle says is weighted. A compromised oracle buys
   influence for free.
4. **Admin key compromise.** Single-key control over voting parameters.
5. **No formal verification.** The contracts are tested against enumerated attacks, not
   formally proven. Test coverage is a proxy for assurance, not a guarantee.