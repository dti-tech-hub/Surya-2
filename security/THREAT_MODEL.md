# Threat Model (STRIDE)

Scope: the milestone-escrow contracts (`Campaign`, `CampaignFactory`,
`MilestoneVerifier`, `DisputeResolution`, `ReputationRegistry`, `CredentialRegistry`) and
the off-chain trust services that feed them (`backend`, `frontend`, evidence adapter).
Written alongside the code and updated as components were added.

**Assets at risk**

1. Escrowed user funds held in each `Campaign` contract.
2. The integrity of milestone verification (a false Approve releases money early).
3. Verifier and juror stake, the economic security budget of the protocol.
4. Creator reputation, which downstream users may rely on.
5. Campaign metadata and evidence availability (IPFS pinning or local store).
6. Credential integrity and the privacy of holder data.

**Out of scope / not fully covered:** ML service internals, wallet key custody, KYC
issuer operations, and production key management for the admin/oracle/treasury roles.

---

## 1. Spoofing

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| S1 | Attacker registers a fake campaign contract to open verification rounds | `MilestoneVerifier.registerCampaign` | Restricted to `admin` and addresses holding the registrar role; only the factory is granted it. Arbitrary callers get `NotRegistrar`. | Implemented + tested |
| S2 | Attacker votes without staking | `MilestoneVerifier.castVote` | Requires `verifiers[msg.sender].active`; unstaking requires withdrawing stake. Reverts `NotActiveVerifier`. | Implemented + tested |
| S3 | Attacker spoofs an oracle attestation | `IOracleAdapter` / `submitOracleVote` | Only the configured oracle address may submit; `oracleWeight` is bounded so it cannot dominate. The shipped adapter is a **mock**. | Access control implemented + tested; oracle is `MOCK/PROTOTYPE` |
| S4 | Creator presents someone else's identity credential | `CredentialRegistry`, backend identity service | DIDs use `did:ethr`; VCs are signed JSON with an `EthereumPersonalSignature2021` proof. Only the credential hash is anchored on-chain. The hash alone is **not** proof of possession; the backend verifies the signature and expiry. | **Prototype**; not a production identity system |
| S5 | Verifier impersonation via the off-chain API | `backend` | No SIWE-style session binding. The API is read-mostly and chain actions are signed by the wallet, but privileged off-chain sessions are not authenticated. | **Open** |
| S6 | Fake evidence upload to the API | `backend` evidence route | Size limit, content-addressed storage, and on-chain digest commitment. Upload does not prove the evidence is truthful. | Upload path implemented; truthfulness out of scope |

## 2. Tampering

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| T1 | Creator swaps evidence after submission | `Campaign.submitEvidence` | The keccak256 `evidenceHash` is committed on-chain; verifiers re-hash the content and reject on mismatch. `evidenceHash` cannot be overwritten because the milestone is no longer `Pending`. | Implemented + tested |
| T2 | Verifier re-casts a vote to flip the tally | `MilestoneVerifier.castVote` | One vote per `(campaign, index, verifier)`, enforced by `voteOf` and `AlreadyVoted`. | Implemented + tested |
| T3 | Someone settles a round early to influence it | `settleRound`, `DisputeResolution.resolve` | Both require `block.timestamp >= deadline`. | Implemented + tested |
| T4 | Admin silently changes voting parameters mid-campaign | `setParameters` | New parameters apply only to rounds opened afterwards; the round snapshots active stake at open. Admin changes emit events. | Implemented |
| T5 | Indexer writes attacker-controlled data into the DB | `backend` indexer | Idempotent inserts keyed on `(tx_hash, log_index)`, confirmation depth, and orphan-block rollback. | Implemented + tested |
| T6 | Creator points a campaign at a malicious dispute module | `Campaign.setDisputeModule` | Only the factory can bind a module, and a campaign can bind only once. | Implemented + tested |
| T7 | Dispute verdict is not applied to escrow | `Campaign.resolveDispute` | Only the bound module may call; outcome encoding is validated; campaign state and milestone state are checked. | Implemented + tested |

## 3. Repudiation

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| R1 | Creator denies submitting evidence | `Campaign` | `EvidenceSubmitted` event carries the CID, digest, and vote deadline. | Implemented |
| R2 | Verifier denies voting | `MilestoneVerifier` | `VoteCast` per vote; `RoundSettled` carries the tallies. | Implemented |
| R3 | Backer cannot prove a contribution | `Campaign` | `Contributed` event per contribution; `contributionOf` is readable per address. | Implemented + tested |
| R4 | Disputes are hard to audit after the fact | `DisputeResolution` / backend | Every dispute transition emits an event; the backend indexes and serves dispute rows. | Implemented + tested locally |
| R5 | Reputation changes are unattributable | `ReputationRegistry` | Every write emits an event containing the subject and the resulting score. | Implemented |

## 4. Information disclosure

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| I1 | PII written on-chain | all contracts | Evidence is CID + digest only; credentials are hashes only. See D-007. | Enforced by design |
| I2 | Backer identity exposure | `Campaign` | `Contributed` links an address to a contribution. This is inherent to a public ledger and is mitigated by using a fresh address or a privacy layer, not by the contract. | Accepted, documented |
| I3 | Private evidence leaked | `Campaign` / IPFS | CIDs are public once submitted. Evidence that must stay confidential should not be put on IPFS or the local content store. | Accepted, documented |
| I4 | Credential claims leak through the registry | `CredentialRegistry` | Only a hash, schema type, holder, issuer, expiry, and revocation flag are stored; claims stay off-chain. | Implemented |
| I5 | Local content store mistaken for IPFS | evidence adapter | The provider is surfaced verbatim as `local-content-store`; the UI and artifacts do not call it IPFS. | Implemented |

## 5. Denial of service

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| D1 | Whale makes milestone settlement impossible by inflating the voter set | `settleRound` | Settlement is O(1); rewards/slashes are claimed lazily. No loop over voters. See D-004. | Mitigated by design |
| D2 | Whale abstains to hold quorum unreachable | `MilestoneVerifier` | Quorum is computed against `activeStakeAtOpen`; new stake cannot inflate the denominator after open. Non-voters can be penalised permissionlessly. | Implemented + tested |
| D3 | Contributor list grows unboundedly, making refunds expensive | `Campaign.sweepDust` | Refunds are O(1) per backer; `sweepDust` is the only loop over backers and cannot block refunds. | Mitigated by design |
| D4 | Unbounded milestone count | `Campaign` | `MAX_MILESTONES = 32`, enforced in the constructor. | Implemented |
| D5 | A reverting recipient blocks payouts | `Campaign`, `MilestoneVerifier`, `DisputeResolution` | Pull-over-push: recipients claim their own funds; a single reverting address cannot stall others. | Implemented |
| D6 | Griefing disputes at negligible cost | `DisputeResolution` | Bond (default 0.05 ETH) plus per-campaign cooldown (default 1 day). | Implemented + simulated |
| D7 | Evidence storage outage blocks verification | evidence adapter | Provider fallback (Pinata → local Kubo → local content store); the digest remains on-chain. | Implemented; availability not measured |
| D8 | API rate exhaustion | `backend` | Helmet, CORS, and `express-rate-limit` middleware. | Implemented; load not measured |

## 6. Elevation of privilege

| # | Threat | Where | Mitigation | Status |
|---|---|---|---|---|
| E1 | Non-admin changes quorum/threshold | `setParameters`, `setRegistrar`, `transferAdmin`, `setTreasury` | All `onlyAdmin`; tested. | Implemented + tested |
| E2 | Compromised admin key | all admin functions | Single EOA admin. **Known weakness.** A production system should use a multisig or timelock; not implemented. | **Open** |
| E3 | Creator releases funds without verification | `Campaign` | Tranches are released only inside `_releaseTranche`, reachable from `resolveMilestone` on Approve or from the bound dispute module. `claimCreatorBalance` can only withdraw an already-accrued balance. | Implemented + tested |
| E4 | Someone else claims the creator's balance | `claimCreatorBalance` | `onlyCreator`. | Implemented + tested |
| E5 | Creator binds a malicious dispute module | `Campaign.setDisputeModule` | `onlyFactory`, one-time binding; the factory's module is admin-controlled. | Implemented + tested |
| E6 | Juror votes then withdraws to escape slashing | `DisputeResolution` | Vote-time stake is locked until `settleJuror`; withdrawal checks `lockedStake`. | Implemented + tested |
| E7 | Verifier votes then withdraws to escape slashing | `MilestoneVerifier` | Withdrawals are locked while rounds are open and through a post-settlement non-voter window. | Implemented + tested |

---

## Explicitly accepted risks

These are **not** solved. They are recorded so that no reader mistakes this system for a
production deployment.

1. **Stake concentration.** A verifier holding most of the stake decides most rounds.
   Weighting by stake raises attack cost; it does not bound influence. Quadratic weighting
   mitigates this in disputes but not in milestone voting.
2. **Vote front-running.** Votes are public during the voting window. A verifier can
   observe peers and follow the crowd. Commit-reveal is future work.
3. **Oracle trust.** Whatever the mock oracle says is weighted. A compromised oracle buys
   bounded influence for free.
4. **Admin key compromise.** Single-key control over voting parameters, the dispute
   module, and treasury routing. A multisig/timelock is required for production.
5. **Off-channel collusion.** A creator can brief a verifier privately before evidence is
   submitted. On-chain stake weighting cannot detect this.
6. **Evidence truthfulness.** The system proves that the bytes did not change after
   submission; it does not prove that the bytes describe a real deliverable.
7. **Local content store is not IPFS.** The fallback provides content addressing on one
   disk, not network availability or pinning.
8. **No formal verification.** The contracts are tested against enumerated attacks, not
   formally proven. Coverage and Slither are proxies for assurance, not guarantees.
9. **No public deployment.** Latency, throughput, L1 data-availability cost, and
   real-world operational behaviour are unmeasured.
