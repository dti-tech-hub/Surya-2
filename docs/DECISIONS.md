# Architecture and Design Decisions

This document records the engineering decisions taken so far, the reasoning behind them,
and the things that were deliberately changed from the original plan. It is the honest
log of what was built and why.

---

## D-001. Hardhat 2.x instead of Hardhat 3.x

**Decision.** The project is pinned to `hardhat@^2.26.0` (resolving to 2.29.1) with
`@nomicfoundation/hardhat-ethers@^3` and `@nomicfoundation/hardhat-chai-matchers@^2`.

**Reasoning.** Hardhat 3 is ESM-only and uses top-level `await` in its entry points.
The development machine runs Node.js v24, where Node's `require()`/ESM interop rejects
loading a CJS module graph containing top-level await
(`ERR_REQUIRE_ASYNC_MODULE`). A local Node 18 build was also tested and failed at a
later stage with `node:util` not exporting `styleText`, which Hardhat 3 requires.

Installing Hardhat 3 plugins against Hardhat 2 (or vice versa) produces confusing
`does not provide an export named 'ethers'` and `Cannot find module 'hardhat/plugins'`
errors, because the v3 plugins are ESM-only and import a `hardhat/plugins` entry point
that only exists in Hardhat 3.

**Consequence.** Tests are written in TypeScript against the standard Hardhat 2 API.
`chai@4` (CommonJS) is used rather than `chai@5` (ESM-only) for the same interop reason.

**If Hardhat 3 becomes viable.** The toolchain is isolated in `hardhat.config.ts` plus
one dependency block in `package.json`; migrating later is a contained change.

---

## D-002. One contract per campaign (not EIP-1163 clones)

**Decision.** `CampaignFactory` deploys a fresh `Campaign` contract per campaign rather
than using OpenZeppelin `Clones`.

**Reasoning.**
- Each campaign needs distinct **immutable** references (`creator`, `verifier`,
  `factory`). Immutable variables cannot live in clone storage, so every clone would
  still need an initialisation call that writes several storage slots, eroding much of
  the gas saving.
- Campaign escrow is the highest-value state in the system. A separate deployed
  address per campaign gives a smaller blast radius and much simpler incident analysis.
- Measured `createCampaign` cost is ~2.58M gas (median 2,576,665; dominated by the
  `Campaign` deployment), of which the factory's own bookkeeping is a small fraction.

**Consequence / future work.** If campaign creation cost proves material, the natural
change is to drop `immutable` for `factory` and `verifier` (read them from the clone's
immutable implementation slot or pass them in `initialize`) and move to clones. This is
noted in the code and is the expected optimisation for a production deployment.

---

## D-003. Fail-closed quorum

**Decision.** If a verification round does not reach the quorum threshold, the milestone
is resolved as **Rejected**, not as "approved by whoever showed up" and not as "abstain".

**Reasoning.** This is an escrow. The failure mode of an escrow is paying out on
insufficient evidence. Treating non-participation as approval would mean an attacker who
could suppress verifiers (or simply one who waited for a quiet period) gets the funds
released. Failing closed converts an availability problem into a safety problem, which
is the correct trade for a contract holding user funds.

**Consequence.** Under-participation delays a campaign rather than releasing it. The
creator can then `failCampaign()` once milestone deadlines lapse, which unlocks refunds.
This is tested in `Campaign.security.test.ts` ("rejects a milestone when quorum is not
met, even with all votes Approve").

---

## D-004. Lazy settlement in `MilestoneVerifier`

**Decision.** `settleRound()` records the outcome in O(1). Individual verifiers later call
`claimSettlement()` to receive a reward or be slashed.

**Reasoning.** Settling rewards and penalties inside `settleRound` would require
iterating over every voter in that round. That makes the call cost grow with the number
of participants, which is a denial-of-service vector: a single party who can cheaply
inflate the voter set could make milestone finalisation permanently unexecutable.

**Consequence.** Rewards are pull-based and may sit unclaimed. Settlement is idempotent
per verifier per round via `settlementClaimed`, so a verifier cannot be slashed twice.

---

## D-005. Stake-weighted voting, and what it does *not* prevent

**Decision.** Voting weight is a verifier's full locked stake.

**Reasoning.** Weighting by stake makes Sybil identity-farming economically unprofitable:
buying influence costs one unit of capital per unit of weight, and that capital is
slashable if the verifier votes against the settled outcome.

**Known limitation, stated plainly.** Stake-weighting does **not** prevent a single
well-capitalised entity from holding a decisive stake share. It raises the cost of
attack; it does not make it impossible. The Sybil evaluation in `evaluation/` measures
this explicitly and reports attacker cost against success rate rather than claiming the
problem is solved.

---

## D-006. Oracle is a mock

**Decision.** `MockOracleAdapter` is shipped and is the only oracle implementation in the
repository.

**Reasoning.** There is no real-world data source wired up. The mock exists so that the
oracle code path, its access control, and its gas cost can be exercised and benchmarked.

**This is explicitly not production-ready.** A production adapter must authenticate its
upstream source, since the ability to make the oracle emit an arbitrary verdict buys
`oracleWeight` of influence in every round at zero stake cost. `oracleWeight` is therefore
bounded and configurable rather than open-ended.

---

## D-007. No PII on-chain

**Decision.** Evidence is referenced by a content-addressed identifier (an IPFS CID when
pinned to Pinata or a local Kubo node, otherwise a local CIDv1 raw hash) plus a keccak256
digest. Verifiable Credentials are recorded as credential hashes plus revocation status.
Names, documents, nationality, and any other personal data are never written to chain
state.

**Reasoning.** On-chain data is permanent and publicly readable. Storing a KYC document
hash is already a meaningful privacy commitment; storing the document or biometric data
would be indefensible.

**Consequence.** The digest makes evidence immutable: verifiers fetch the CID and confirm
it hashes to the committed `evidenceHash`, so the creator cannot swap the document after
submission.

---

## D-008. Factory must hold registrar rights

**Decision.** `MilestoneVerifier.registerCampaign` is restricted to the admin *and* to
addresses with `isRegistrar[addr] == true`. The admin grants this to the factory.

**Reasoning.** This was originally written as `onlyAdmin` and it **failed the test
suite**, because the factory is the contract calling `registerCampaign` during
deployment, not the admin. Rather than granting the factory special-cased power inside
the verifier, the verifier is given an explicit, auditable registrar role. This keeps
campaign registration from being front-run by arbitrary third parties while letting the
factory do its job.

This is recorded because it was a real bug caught by testing, not a design preference.

---

## D-009. SQLite replaces MongoDB

**Decision.** The backend uses SQLite via `better-sqlite3` with WAL mode and foreign keys
enabled, accessed through a repository layer. (Substitution made relative to the 0th
review proposal; see below.)

**Reasoning.**
- **Zero-ops.** The database is a single file. A student project or a demo can be cloned
  and run with no database server to provision.
- **Reproducible demo.** The full indexer state is one file that can be committed,
  copied, or deleted and rebuilt from chain events.
- **On-chain data is the source of truth.** The database is only an index and a cache.
  Every row is reconstructible from contract events, which is exactly the property that
  makes an ephemeral store acceptable.
- **Swappability.** All access goes through a repository interface. Migrating to
  PostgreSQL means writing a new implementation of that interface, not rewriting routes.

**Limits, stated honestly.**
- **Single writer.** SQLite serialises writes. The indexer is therefore a single-writer
  process by design, and multiple indexer instances writing to one database file would
  contend rather than scale.
- **No horizontal scaling.** There is no read-replica or sharding story.
- **Not a high-availability store.** This is an index, so losing it means reindexing from
  chain, not losing user funds.

**Production.** A production deployment should use PostgreSQL. The repository layer is
the seam that makes that a contained change.

---

## D-010. Polygon Amoy, not Mumbai

**Decision.** The L2 target is Polygon **Amoy** (chainId 80002). Arbitrum Sepolia
(421614) is configured as an alternative. Ethereum Sepolia (11155111) is L1.

**Reasoning.** Polygon Mumbai is deprecated and sunset. Amoy is its designated
replacement testnet. Both L2s are wired into `hardhat.config.ts` so the L1-vs-L2
comparison can be run against either.

---

## D-011. `viaIR: true` for the build and coverage

**Decision.** The Solidity compiler runs with `viaIR: true` (optimizer on, 200 runs) for
normal builds and for `solidity-coverage`.

**Reasoning.** `solidity-coverage` instruments every statement and branch, which adds
stack pressure. On `DisputeResolution.settleJuror` the instrumented build hit the EVM
stack-depth limit with the legacy pipeline. Enabling the IR pipeline removes that limit
and lets coverage run against the same source that the tests exercise.

**Consequence.** Compile time is higher. The measured gas figures in
`benchmarks/results/bench-hardhat.json` were produced from this build, so they describe
the bytecode that is actually tested and deployed locally.

---

## D-012. TypeChain bindings generated at compile time

**Decision.** `@typechain/hardhat` generates `typechain-types/` during `hardhat compile`,
and `npm run typecheck` runs `hardhat compile && tsc --noEmit`.

**Reasoning.** Before this, `tsc --noEmit` had no knowledge of the contract ABIs: every
`ethers.getContractAt` returned `BaseContract`, so the `typecheck` script failed on
hundreds of valid contract calls. The choice was either to add generated typings or to
degrade the script with `any` casts. Generated typings make the check meaningful.

**Consequence.** `typechain-types/` is generated output and is git-ignored (`.gitignore`
line 9); a fresh clone must run `npx hardhat compile` (or `npm run typecheck`, which does
it first) before invoking `tsc` directly. The test-only `ReentrantBacker` getter was
renamed from `target` to `targetContract` because a public getter named `target` collides
with ethers' `BaseContract.target` property in the generated interface.

---

## D-013. Node's built-in `node:sqlite` instead of `better-sqlite3`

**Decision.** The backend uses `DatabaseSync` from Node's built-in `node:sqlite` module.
The package declares `engines.node >= 22.5`, the version in which the module became
available.

**Reasoning.** `better-sqlite3` is a native addon that requires a node-gyp build. That
build failed on the Node 24 toolchain used for development. `node:sqlite` ships with the
runtime, needs no compiler toolchain, and provides the synchronous API the repository
layer is written against. The trade-off is a higher minimum Node version and a younger
API surface than the long-established package.

**Consequence.** The SQLite file remains the indexer's rebuildable cache, not the system
of record (D-009). WAL mode, foreign keys, and `busy_timeout` are set explicitly in
`backend/src/db/client.ts`; those pragmas are part of the durability and concurrency
argument, not optional tuning.

---

## D-014. CI reports coverage and Slither findings without gating on them

**Decision.** The contract compile and test suite gate every push and pull request.
Coverage generation and Slither run in parallel reporting jobs with
`continue-on-error: true`. Their artifacts are uploaded, but a coverage threshold or a
Slither finding count does not fail the build.

**Reasoning.** A coverage threshold that has not been calibrated against this codebase
would create pressure to add low-value tests rather than to exercise meaningful branches.
The current Slither baseline includes three High-impact `arbitrary-send-eth` results that
are triaged false positives; failing on the raw count would train contributors to ignore
the security job. The two historical High-severity bugs that were real have regression
tests in `test/Security.regression.test.ts`.

**Consequence.** Regressions remain visible in CI logs and artifacts but are not
automatically blocking. Turning coverage or finding counts into gates is future work and
requires a triaged baseline first. This is a reporting policy, not a claim that the
current findings are harmless.

---

## Measured gas figures — `MEASURED` (local EVM)

These are **measured** EVM gas values, produced by
`npx hardhat run benchmarks/run-benchmarks.ts` and written to
`benchmarks/results/bench-hardhat.json` (five samples per operation; median shown).
`claimRefund` is not sampled by that harness; the two values below come from the
lifecycle run in `evaluation/results/demo-lifecycle.json`. They are not estimates.

| Operation | Median gas | Observed range / notes |
|---|---:|---|
| `CampaignFactory.createCampaign` | 2,576,665 | 2,576,665–2,593,765; includes deploying `Campaign` |
| `Campaign.contribute` | 38,627 | First contribution for a new address: 139,523 (writes the backer list) |
| `Campaign.submitEvidence` | 189,140 | First submission: 206,240; includes opening a round |
| `MilestoneVerifier.castVote` | 119,427 | 119,427–119,427 |
| `Campaign.resolveMilestone` | 184,614 | First resolution: 221,752; includes `settleRound` tally |
| `Campaign.claimCreatorBalance` | 55,064 | 55,064–55,064 |
| `Campaign.claimRefund` | 83,970 / 66,870 | Two lifecycle backers; not a benchmark median |

**Caveats that matter.** Gas on the local EVM is not the same as gas on a real network:
L2 execution gas is cheap but carries an L1 data-availability cost that dominates the
true price of a transaction, so a local measurement alone cannot answer the "is L2
cheaper" question. The cost model in `benchmarks/results/l1-vs-l2-comparison.json` is
`SIMULATED` and excludes L1 data-availability fees. No public testnet deployment has been
run, so no measured cross-network latency, throughput, or cost claims are made.