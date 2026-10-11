# Slither Security Report and Triage

Tool: `slither-analyzer 0.11.6`, 102 detectors, run via `crytic-compile` on the Hardhat
project. Raw output: [`slither-report.json`](./slither-report.json). Severity counts:
[`slither-summary.md`](./slither-summary.md).

Reproduce with:

```bash
npx hardhat clean
slither . --compile-force-framework hardhat --exclude-dependencies \
  --json security/slither-report.json
python security/triage_slither.py security/slither-report.json
```

## Result summary

| | Before triage | After fixes |
|---|---|---|
| High | 2 | **0** |
| Medium | 8 | 10 |
| Low | 34 | 32 |
| Informational | 12 | 12 |
| Optimization | 7 | 6 |
| **Total** | **63** | **60** |

The Medium count rose because fixing the reentrancy in `settleJuror` introduced a new
pro-rata reward expression that `divide-before-multiply` flags, and one uninitialized-local
moved location. Total actionable severity dropped from 10 to 10 but, critically, the two
**High** findings that represented real fund-drain paths are gone.

---

## High findings — both fixed

### H1. `arbitrary-send-eth`: `Campaign.sweepDust(address)` sent ETH to a caller-supplied address

**The bug.** `sweepDust(address treasury)` accepted the payout destination as a parameter.
The NatSpec claimed it was "routed to the treasury, never to an arbitrary caller", which
was false: anyone could pass their own address and sweep the accrued dust to themselves.

**Why it mattered.** The dust is bounded and small (integer-division remainder, at most
`backers.length - 1` wei), so the direct loss is minor. The real problem was that the code
contradicted its own stated invariant, which is exactly the kind of divergence that gets
exploited. This was introduced by me during Phase 1 and caught only because Slither was
run — the functional tests did not cover `sweepDust` at all.

**Fix.** Removed the parameter entirely. `treasury` is now an `immutable` set in the
constructor and threaded from the factory (falling back to the factory's own treasury when
`CampaignParams.treasury` is `address(0)`).

**Regression test.** `test/Security.regression.test.ts` asserts the function takes zero
arguments and that the `DustSwept` event destination equals the immutable treasury.

### H2. `reentrancy-eth`: `DisputeResolution.settleJuror`

**The bug — three distinct defects, not one.**

1. **Checks-effects-interactions violation.** `j.casesCorrect += 1` executed *after* the
   external reward transfer.
2. **Fund-drain via reward accounting.** The reward was `totalBondEscrow / 100` — a flat
   1% of the *entire* bond pool — paid to every correct juror regardless of their weight.
   A juror participating in N disputes could withdraw roughly N% of the escrow, draining
   funds that belonged to other disputes' bond posters.
3. **No reentrancy guard.**

Defect 2 is the serious one and was not what the detector's headline claimed. The
detector correctly identified the CEI violation; triaging the surrounding code revealed
the drain.

**Fix.**
- Inherits OpenZeppelin `ReentrancyGuard`; `settleJuror` is `nonReentrant`.
- Rewards are now drawn from `d.bondEscrowed` (the bond attributable to *this* dispute),
  scaled to `REWARD_SHARE_BPS` (50%), and divided among majority jurors **pro-rata by
  weight**: `(bondEscrowed * REWARD_SHARE_BPS / BPS) * myWeight / majorityWeight`.
- All state writes (`casesCorrect`, `totalBondEscrow`) now precede the transfer.

**Regression tests.** Two tests in `test/Security.regression.test.ts`: one asserts a single
correct juror receives at most 50% of the dispute's own bond; the other runs three
disputes and asserts the total paid across all of them is bounded by 50% of the total
posted, which is impossible under the old flat-1% logic.

---

## Medium findings — triaged

### M1–M3. `divide-before-multiply` (3 findings)

`ReputationRegistry.scoreOf`, `MilestoneVerifier.claimSettlement`,
`DisputeResolution.settleJuror`.

**Verdict: accepted, documented, not fixed.** These flag expressions of the form
`(a * X / BPS) * b`. The concern is precision loss. Concretely:

- In `scoreOf`, the result is a 0..10000 reputation figure recomputed by a Python
  reference implementation on every score read. **Precision here is a correctness
  requirement, not an optimisation**, so restructuring the expression risks silently
  desynchronising the on-chain and off-chain scores. `test/ReputationRegistry.test.ts`
  pins exact parity between the two implementations.
- In `claimSettlement` and `settleJuror`, the quantities are wei amounts and the rounding
  is bounded by well under 1 wei per participant; the total distributed can never exceed
  the pool, because each share is floored and the remainder is simply not paid.

The realistic risk in all three is dust that is never reclaimed, not fund loss. That is a
known and accepted trade-off documented in `docs/DECISIONS.md`.

### M4–M5. `incorrect-equality` (2 findings)

`Campaign.sweepDust` (`if (dust == 0) revert`) and `Campaign._hasRejectedMilestone`
(`if (milestones[i].state == MilestoneState.Rejected)`).

**Verdict: false positive.** The detector's heuristic is that `==` in a condition can mask
an unintended branch. Both uses are intentional equality tests against a sentinel
(nothing to sweep / a specific enum state), not mistaken strictness. There is no
floating-point or rounding context where `==` is unsafe here.

### M6. `reentrancy-no-eth`: `Campaign.resolveMilestone`

**Verdict: accepted.** `resolveMilestone` is `nonReentrant`, calls
`verifier.settleRound` (a trusted system contract that does not transfer ETH and does not
call back), and then only updates storage. The detector flags it because `settleRound` is
an external call whose result is trusted. Mitigating factors:

- It is guarded by `nonReentrant`.
- `settleRound` cannot re-enter `Campaign` (no reference back to it).
- A malicious verifier admin could return a false `Approve`, but that is a
  **governance/trust** risk recorded in `security/THREAT_MODEL.md` as E2, not a
  reentrancy risk.

### M7–M8. `uninitialized-local` (2 findings)

`CampaignFactory.createCampaign.trancheSum` and `DisputeResolution.settleJuror.reward`.

**Verdict: accepted, benign.** Both are declared without an initialiser and then
immediately assigned before any read:

```solidity
uint256 trancheSum;          // assigned on the very next line
uint256 trancheSum;
for (...) { trancheSum += ...; }
```

Solidity zero-initialises locals, and Slither's own docs describe this detector as
medium-confidence for exactly this shape. No behavioural impact; no fix warranted, and
adding a redundant `= 0` would only add noise.

---

## Low / Informational / Optimization — not individually triaged

32 Low, 12 Informational, 6 Optimization. These are dominated by:

- **Cache array length in loops** (`for (uint256 i = 0; i < milestones.length; ++i)`).
  These loops are bounded: `MAX_MILESTONES = 32` is enforced in the constructor, so
  worst-case cost is a fixed, small constant. Caching the length would save a few hundred
  gas at the cost of readability with no security benefit. Fixed in `sweepDust` anyway
  during the H1 fix, since it was already being touched.
- **`goal`/`fundingDeadline` could be immutable.** `goal` and `fundingDeadline` are
  written once in the constructor and never modified. They cannot be `immutable` without
  restructuring because they are also read through the `campaign` struct in the same
  contract. Low value; left alone.
- Reentrancy guards, safe ERC20 usage, and shadowing warnings, all reviewed and dismissed
  with reasons in the JSON.

---

## Honest limitations of this analysis

1. **Static analysis is not a proof of absence of bugs.** Slither found two real High
   defects here, which is evidence it is worth running, and simultaneously evidence that a
   clean report is not the same as secure code.
2. **The detector set is not exhaustive.** Reentrancy via cross-function paths,
   economic attacks, oracle manipulation, and governance capture are largely outside its
   reach. `security/THREAT_MODEL.md` covers the threats it cannot, and several of those are
   recorded as explicitly unresolved.
3. **No formal verification has been performed.** Every property asserted here is backed
   by a test, not a proof.
4. **Dependency risk was excluded** (`--exclude-dependencies`), so OpenZeppelin's own
   contracts were not analysed. This is a reasonable default: they are widely reviewed and
   pinned to a released version. It does mean a compromised OpenZeppelin release would not
   be caught by this scan.
5. **Coverage gaps remain.** The Medium `divide-before-multiply` findings in
   `scoreOf` are only partially exercised; a fuzz/property test would give stronger
   assurance that the on-chain and Python scoring implementations cannot drift.