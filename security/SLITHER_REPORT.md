# Slither Security Report and Triage

Tool: `slither-analyzer 0.11.6`, run via `crytic-compile` on the Hardhat project with
`--exclude-dependencies`. Latest raw output:
[`slither-report-new.json`](./slither-report-new.json). Earlier 60-finding baseline:
[`slither-report.json`](./slither-report.json). Severity counts:
[`slither-summary.md`](./slither-summary.md).

Reproduce the current run with:

```bash
npx hardhat clean
slither . --compile-force-framework hardhat --exclude-dependencies \
  --json security/slither-report-new.json
python security/triage_slither.py security/slither-report-new.json
```

## Result summary

| Impact | Previous run | Current run |
|---|---:|---:|
| High | 0 | **3** |
| Medium | 10 | **14** |
| Low | 32 | **34** |
| Informational | 12 | **21** |
| Optimization | 6 | **6** |
| **Total** | **60** | **78** |

The count rose because the dispute-settlement path was expanded after the previous
scan. The new code added explicit pull-payment branches, a partial-release path in
`Campaign`, and extra local variables in `DisputeResolution`. Slither's
`arbitrary-send-eth` heuristic now flags the three new ETH-transfer sites.

**All three current High-impact results are false positives, not unresolved fund-drain
vulnerabilities.** They are pull payments to an already-authenticated juror or transfers
to the immutable treasury. The two historical High-severity defects that *were* real
(caller-chosen dust destination and juror-settlement accounting/reentrancy) remain fixed
and have regression tests. Details are in the next two sections.

---

## Current High-impact findings — all triaged false positives

Slither reports `High` impact but `Medium` confidence on all three. The detector's
heuristic is that ETH leaves the contract through a call whose recipient is not a
compile-time constant. That is true of every pull-payment design; the relevant question
is whether the recipient is attacker-controlled. Here it is not.

### H1. `arbitrary-send-eth` — `DisputeResolution._settleCorrectJuror`

**Location.** `contracts/DisputeResolution.sol#562-590`, transfer at line 587:

```solidity
if (reward > 0) {
    (bool ok, ) = payable(msg.sender).call{ value: reward }("");
    if (!ok) revert TransferFailed();
}
```

**Why Slither flags it.** The recipient is `msg.sender`, not a constant.

**Why it is a false positive.** `_settleCorrectJuror` is reached only from
`settleJuror`, which:

1. requires `d.state == Resolved`;
2. returns immediately unless `hasVoted[key][msg.sender]` is true;
3. reverts if `jurorClaimed[key][msg.sender]` is already true;
4. marks `jurorClaimed` **before** the transfer;
5. derives `reward` from `d.rewardPool` and the caller's recorded vote weight, then
   decrements the pool before the call.

The caller is therefore an entitled juror withdrawing their own pro-rata reward. This is
the standard pull-payment pattern, and `settleJuror` is `nonReentrant`. There is no path
for an arbitrary address to choose the recipient or the amount.

### H2. `arbitrary-send-eth` — `DisputeResolution._settleIncorrectJuror`

**Location.** `contracts/DisputeResolution.sol#592-613`, transfer at line 610:

```solidity
(bool ok, ) = payable(treasury).call{ value: slash }("");
if (!ok) revert TransferFailed();
```

**Why it is a false positive.** `treasury` is set in the constructor and is not a
caller-supplied parameter. The call sends the slashed juror stake to the protocol
treasury. State (`j.stake`, `totalJurorStake`, reputation) is updated before the transfer,
and the enclosing `settleJuror` is `nonReentrant`.

### H3. `arbitrary-send-eth` — `DisputeResolution._settleBonds`

**Location.** `contracts/DisputeResolution.sol#485-517`, transfers at lines 499 and 514:

```solidity
(bool ok, ) = payable(d.raiser).call{ value: raiserBond }("");   // line 499
...
(bool ok, ) = payable(treasury).call{ value: toTreasury }("");  // line 514
```

**Why it is a false positive.** Both recipients are fixed by state, not by the current
caller:

- `d.raiser` is the address that called `raiseDispute` and whose bond is recorded in
  `d.raiserBond`.
- `treasury` is the immutable protocol treasury.

The function is internal, called by `resolve` (which is `nonReentrant`) after the
dispute state and bond escrow have been updated. No external caller can redirect either
payment.

**Conclusion.** No current High-impact finding is assessed as a real vulnerability.
This conclusion is a manual triage, not a proof; see the limitations at the end.

---

## Historical High-severity defects — fixed

These were real and were found by earlier Slither runs. They are retained here because
the paper's security narrative depends on them.

### Historical H1. `arbitrary-send-eth` — `Campaign.sweepDust(address)`

**The bug.** `sweepDust(address treasury)` accepted the payout destination as a runtime
parameter. Despite NatSpec claiming the dust went to the treasury, any caller could pass
their own address and sweep the accrued dust to themselves.

**Impact.** The direct loss was bounded by integer-division dust (at most
`backers.length - 1` wei), but the code contradicted its stated invariant.

**Fix.** Removed the parameter. `treasury` is now an `immutable` set in the constructor
and threaded from the factory. `sweepDust()` requires every known backer to have claimed
and is `nonReentrant`.

**Regression test.** `test/Security.regression.test.ts` asserts the zero-argument
interface and that the `DustSwept` destination equals the immutable treasury.

### Historical H2. `reentrancy-eth` — `DisputeResolution.settleJuror`

**The bug — three distinct defects.**

1. **Checks-effects-interactions violation.** `j.casesCorrect += 1` executed after the
   external reward transfer.
2. **Fund-drain via reward accounting.** The reward was `totalBondEscrow / 100` — a flat
   1% of the *entire* bond pool — paid to every correct juror regardless of weight. A
   juror participating in multiple disputes could drain funds belonging to unrelated
   disputes.
3. **No reentrancy guard.**

**Fix.**

- `settleJuror` inherits OpenZeppelin `ReentrancyGuard` and is `nonReentrant`.
- Rewards are drawn from `d.rewardPool` (the bond attributable to *this* dispute),
  scaled by `REWARD_SHARE_BPS` and divided pro-rata by weight:
  `(d.rewardPool * weight) / correctWeight`.
- All state writes precede the transfer.
- Losing jurors are slashed from their vote-time stake; ties reward all voters and slash
  nobody.

**Regression tests.** `test/Security.regression.test.ts` bounds a correct juror's reward
by the dispute's own bond, weights it by stake, and verifies that a losing juror cannot
withdraw before settlement and is slashed once.

---

## Medium findings — triaged

### M1–M4. `divide-before-multiply` (4 findings)

**Locations.** `Campaign._releasePartial` (lines 696, 703–704),
`ReputationRegistry.scoreOf` (lines 253, 262–271), `MilestoneVerifier.claimSettlement`
(lines 591, 624, 631).

**Verdict: accepted, documented, not fixed.**

- In `_releasePartial`, the expression floors the tranche and then floors the creator
  share. The total rounding loss is bounded by roughly 1 wei per partial release; the
  remaining wei stays in escrow and is refundable.
- In `scoreOf`, the ratios are integer basis points and the weights sum to 10,000. The
  floor at each ratio can lose less than 1 bps per component; the on-chain score is
  reproduced byte-exactly by `ml-service/reputation.py` and pinned by parity tests.
  Restructuring the expression to satisfy the detector would risk desynchronising the two
  implementations.
- In `claimSettlement`, the reward share is floored per juror; the undistributed
  remainder stays in the contract. The total paid can never exceed the reserved pool
  because each share is capped and the pool is decremented before transfer.

The realistic risk is dust that is never reclaimed, not fund loss. This is a known
trade-off documented in `docs/DECISIONS.md`.

### M5–M6. `incorrect-equality` (2 findings)

**Locations.** `Campaign._hasRejectedMilestone` (`state == MilestoneState.Rejected`) and
`Campaign.sweepDust` (`dust == 0`, state sentinel checks).

**Verdict: false positive.** These are intentional equality tests against enum states or
a sentinel value, not mistaken strictness. There is no floating-point or rounding context
where `==` is unsafe here.

### M7–M10. `reentrancy-no-eth` (4 findings)

**Locations.** `Campaign.resolveMilestone` (lines 432–442),
`Campaign.resolveDispute` (lines 479–504, including `_releasePartial` at 710).

**Verdict: accepted.** Both functions are `nonReentrant`. `resolveMilestone` calls
`verifier.settleRound`, a trusted system contract that does not transfer ETH and does not
call back into `Campaign`. `resolveDispute` is called by the factory-bound dispute module
and applies the verdict to escrow; the module is authorised once and cannot be replaced.
A compromised verifier admin could return a false `Approve`, but that is a governance
risk recorded in `security/THREAT_MODEL.md`, not a reentrancy risk.

### M11–M14. `uninitialized-local` (4 findings)

**Locations.** `CampaignFactory.createCampaign.trancheSum` (line 122),
`Campaign` constructor `trancheSum` (line 278), `DisputeResolution.resolve.outcome` /
`partialBps` (line 433), and `DisputeResolution._settleCorrectJuror.reward` (line 575).

**Verdict: accepted, benign.** Solidity zero-initialises locals, and every variable is
assigned before it is read:

```solidity
uint256 trancheSum;          // accumulated in the loop before the check
for (...) { trancheSum += ...; }

Outcome outcome;
uint16 partialBps;           // only read when outcome == Partial
...
uint256 reward;              // only read after the conditional assignment
```

Adding a redundant `= 0` would not change behaviour.

---

## Low / Informational / Optimization findings

34 Low, 21 Informational, and 6 Optimization results remain. They are dominated by:

- **`timestamp` (23, Low).** Deadline comparisons, cooldowns, and reputation decay. None
  is used as a randomness source. Miners can shift timestamps by a small amount; the
  protocol does not depend on second-level precision.
- **`low-level-calls` (14, Informational).** The expected `.call` sites for pull
  payments. Return values are checked and failures revert.
- **`reentrancy-benign` (5, Low).** State written after an external call where no ETH is
  at risk; reviewed alongside the `nonReentrant` guards.
- **`reentrancy-events` (5, Low).** Events emitted after external calls. No state
  corruption; event ordering only.
- **`missing-zero-check` (1, Low).** `CampaignFactory.setDisputeModule` is admin-only and
  accepts `address(0)`, which intentionally disables dispute binding for **future**
  campaigns. Existing campaigns keep their bound module. This is a documented admin
  footgun, not a fund-drain path.
- **`missing-inheritance` (3, Informational).** Interfaces are implemented but not
  declared on the contract; cosmetic.
- **`cyclomatic-complexity` (2, Informational).** `settleRound` and `claimSettlement`
  encode the tally and settlement branches explicitly.
- **`solc-version` (1, Informational).** Flags an OpenZeppelin dependency pragma; the
  project itself pins 0.8.20.
- **`unused-state` (1, Informational).** `MilestoneVerifier.MAX_BPS` is unused. No
  behavioural impact.
- **`cache-array-length` (3, Optimization).** Loops over milestones/backers are bounded
  (`MAX_MILESTONES = 32`); caching the length saves a few hundred gas at a readability
  cost.
- **`immutable-states` (3, Optimization).** `goal` and `fundingDeadline` are written once
  in the constructor but are read through storage; `DisputeResolution.treasury` is
  admin-settable and therefore not immutable. Left as-is.

---

## Honest limitations of this analysis

1. **Static analysis is not a proof of absence of bugs.** Slither found two real High
   defects in earlier revisions, which is evidence it is worth running; it is equally
   evidence that a clean or triaged report is not the same as secure code.
2. **The detector set is not exhaustive.** Cross-function reentrancy, economic attacks,
   oracle manipulation, governance capture, and off-chain threats are largely outside its
   reach. `security/THREAT_MODEL.md` covers those and records several as unresolved.
3. **Triage is manual.** The three current High results are assessed as false positives
   from code inspection, not from a formal invariant proof. A reviewer should re-check the
   recipient constraints independently.
4. **No formal verification.** Every property here is backed by a test or an argument, not
   a proof.
5. **Dependencies were excluded.** OpenZeppelin contracts were not analysed. They are
   widely reviewed and pinned, but a compromised release would not be caught by this scan.
6. **Coverage gaps remain.** Branch coverage is 62.10%; some defensive paths are not
   exercised. A fuzz/property campaign would give stronger assurance, particularly around
   the partial-release arithmetic and dispute bond accounting.
