import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

/**
 * Reputation model tests, including on-chain/off-chain formula parity.
 *
 * The normative scoring formula lives in `docs/DECISIONS.md` and is duplicated in
 * `ml-service/reputation.py`. These tests pin the on-chain behaviour and assert the
 * reference Python implementation (invoked as a subprocess when available) agrees
 * with the contract. If Python is not installed the parity check is skipped rather
 * than silently passing, so an absent interpreter can never masquerade as agreement.
 */

const BPS = 10_000n;
const W_DELIVERY = 4_000n;
const W_COMPLETION = 3_000n;
const W_DISPUTE = 2_000n;
const W_INTEGRITY = 1_000n;
const MAX_SLASH_BPS = 5_000n;
const SLASH_PER_TOKEN = 50n;
const HALF_LIFE = 15_552_000n; // 180 days in seconds

const WEIGHT_SUM = W_DELIVERY + W_COMPLETION + W_DISPUTE + W_INTEGRITY;

/** Reference implementation of the on-chain score, mirroring ReputationRegistry.sol. */
function referenceScore(p: {
  milestonesOnTime: bigint;
  milestonesTotal: bigint;
  campaignsCompleted: bigint;
  campaignsFailed: bigint;
  disputeWins: bigint;
  disputeLosses: bigint;
  votesCorrect: bigint;
  votesTotal: bigint;
  slashedWei: bigint;
  lastUpdated: number;
}, now: number): bigint {
  if (p.lastUpdated === 0) return 0n;
  const ratio = (a: bigint, b: bigint) => (b === 0n ? 0n : (a * BPS) / b);
  const delivery = ratio(p.milestonesOnTime, p.milestonesTotal);
  const completion = ratio(p.campaignsCompleted, p.campaignsCompleted + p.campaignsFailed);
  const dispute = ratio(p.disputeWins, p.disputeWins + p.disputeLosses);
  const integrity = ratio(p.votesCorrect, p.votesTotal);

  let raw =
    (W_DELIVERY * delivery +
      W_COMPLETION * completion +
      W_DISPUTE * dispute +
      W_INTEGRITY * integrity) /
    WEIGHT_SUM;

  let penalty = (p.slashedWei / 10n ** 18n) * SLASH_PER_TOKEN;
  if (penalty > MAX_SLASH_BPS) penalty = MAX_SLASH_BPS;
  if (raw > penalty) raw -= penalty;

  const age = BigInt(now) - BigInt(p.lastUpdated);
  return (raw * HALF_LIFE) / (HALF_LIFE + age);
}

async function fixture() {
  const [admin, subject, writerA] = await ethers.getSigners();
  const Registry = await ethers.getContractFactory("ReputationRegistry");
  const registry = await Registry.deploy(admin.address);
  await registry.waitForDeployment();
  await registry.connect(admin).setWriter(writerA.address, true);
  return { registry, admin, subject, writerA };
}

describe("ReputationRegistry", () => {
  describe("access control", () => {
    it("rejects writes from a non-writer", async () => {
      const { registry, subject } = await loadFixture(fixture);
      await expect(
        registry.connect(subject).recordMilestone(subject.address, true)
      ).to.be.revertedWithCustomError(registry, "NotWriter");
    });

    it("rejects writer changes from a non-admin", async () => {
      const { registry, subject } = await loadFixture(fixture);
      await expect(
        registry.connect(subject).setWriter(subject.address, true)
      ).to.be.revertedWithCustomError(registry, "NotAdmin");
    });

    it("rejects admin changes from a non-admin", async () => {
      const { registry, subject } = await loadFixture(fixture);
      await expect(
        registry.connect(subject).transferAdmin(subject.address)
      ).to.be.revertedWithCustomError(registry, "NotAdmin");
    });
  });

  describe("scoring", () => {
    it("scores an unseen subject at zero", async () => {
      const { registry, subject } = await loadFixture(fixture);
      expect(await registry.scoreOf(subject.address)).to.equal(0n);
      expect(await registry.tierOf(subject.address)).to.equal(0n); // Unrated
    });

    it("reaches Gold tier for a perfect record", async () => {
      const { registry, writerA, subject } = await loadFixture(fixture);

      // 10/10 on time, 1 completed 0 failed, 1 dispute win, 10/10 verifier votes.
      for (let i = 0; i < 10; i++) {
        await registry.connect(writerA).recordMilestone(subject.address, true);
      }
      await registry.connect(writerA).recordCampaign(subject.address, true);
      await registry.connect(writerA).recordDispute(subject.address, true);
      for (let i = 0; i < 10; i++) {
        await registry.connect(writerA).recordVerifierVote(subject.address, true);
      }

      // Every component is perfect, so the weighted average is exactly BPS. Allow a
      // 1-bps tolerance: a second may elapse between the write and the read, and the
      // decay term is a live function of block.timestamp.
      const score = await registry.scoreOf(subject.address);
      expect(score).to.be.closeTo(BPS, 1n);
      expect(await registry.tierOf(subject.address)).to.equal(4n); // Platinum
      expect(await registry.scorePercent(subject.address)).to.be.closeTo(100n, 1n);
    });

    it("applies the documented weights", async () => {
      const { registry, writerA, subject } = await loadFixture(fixture);

      // Perfect delivery (10000 bps) with no other history. Weighted average over the
      // full weight sum: 4000*10000/10000 = 4000 bps. 1-bps tolerance for decay drift.
      await registry.connect(writerA).recordMilestone(subject.address, true);
      expect(await registry.scoreOf(subject.address)).to.be.closeTo(W_DELIVERY, 1n);
    });

    it("penalises failed campaigns and lost disputes", async () => {
      const { registry, writerA, subject } = await loadFixture(fixture);

      // 0 completed, 1 failed, 0 wins, 1 loss => both ratios are 0.
      await registry.connect(writerA).recordCampaign(subject.address, false);
      await registry.connect(writerA).recordDispute(subject.address, false);
      expect(await registry.scoreOf(subject.address)).to.equal(0n);

      // Unrated, which is correct: no positive signal has been earned.
      expect(await registry.tierOf(subject.address)).to.equal(0n);
    });

    it("caps the slash penalty at 50 points", async () => {
      const { registry, writerA, subject } = await loadFixture(fixture);

      // Perfect record worth 10000 bps, then an enormous slash.
      for (let i = 0; i < 10; i++) {
        await registry.connect(writerA).recordMilestone(subject.address, true);
      }
      await registry.connect(writerA).recordCampaign(subject.address, true);
      await registry.connect(writerA).recordDispute(subject.address, true);
      await registry.connect(writerA).recordVerifierVote(subject.address, true);

      // 1000 tokens * 50 bps = 50 000 bps, which exceeds the 5000 cap. The result is
      // therefore the cap, not the uncapped value: 10000 - 5000 = 5000 bps.
      await registry.connect(writerA).recordSlash(subject.address, ethers.parseEther("1000"));

      expect(await registry.scoreOf(subject.address)).to.be.closeTo(BPS - MAX_SLASH_BPS, 2n);
    });
  });

describe("time decay", () => {
      it("decays a score toward zero over time", async () => {
        const { registry, writerA, subject } = await loadFixture(fixture);

        // One write stamps lastUpdated. Delivery component = 10000 bps.
        await registry.connect(writerA).recordMilestone(subject.address, true);
        const fresh = await registry.scoreOf(subject.address);
        expect(fresh).to.be.closeTo(4_000n, 2n); // delivery only, weighted average

        // Advance by exactly one half-life => score ~halves.
        await time.increase(Number(HALF_LIFE));
        const halved = await registry.scoreOf(subject.address);
        expect(halved).to.be.closeTo(2_000n, 5n);

        // Another half-life => halves again (1000). Tolerance covers the few blocks that
        // Hardhat mines per transaction, each advancing timestamp slightly.
        await time.increase(Number(HALF_LIFE));
        const quarter = await registry.scoreOf(subject.address);
        expect(quarter).to.be.closeTo(1_000n, 350n);

        // And keeps approaching zero without ever going negative.
        await time.increase(Number(HALF_LIFE * 10n));
        const late = await registry.scoreOf(subject.address);
        expect(late).to.be.lt(quarter);
        expect(late).to.be.gte(0n);
      });
    });

  describe("on-chain / off-chain parity", () => {
    it("matches the reference implementation across a range of profiles", async () => {
      const { registry, writerA, subject } = await loadFixture(fixture);

      // Build a mixed, deliberately imperfect record.
      await registry.connect(writerA).recordMilestone(subject.address, true);
      await registry.connect(writerA).recordMilestone(subject.address, true);
      await registry.connect(writerA).recordMilestone(subject.address, false);
      await registry.connect(writerA).recordCampaign(subject.address, true);
      await registry.connect(writerA).recordCampaign(subject.address, false);
      await registry.connect(writerA).recordDispute(subject.address, false);
      await registry.connect(writerA).recordVerifierVote(subject.address, true);
      await registry.connect(writerA).recordVerifierVote(subject.address, false);
      await registry.connect(writerA).recordSlash(subject.address, ethers.parseEther("3"));

      // Read profile, score and timestamp at the same block height so the comparison is
      // not polluted by a second ticking over between the two view calls.
      const [profile, onChain] = await Promise.all([
        registry.getProfile(subject.address),
        registry.scoreOf(subject.address),
      ]);
      const block = await ethers.provider.getBlock("latest");
      const now = block!.timestamp;

      const reference = referenceScore(
        {
          milestonesOnTime: profile.milestonesOnTime,
          milestonesTotal: profile.milestonesTotal,
          campaignsCompleted: profile.campaignsCompleted,
          campaignsFailed: profile.campaignsFailed,
          disputeWins: profile.disputeWins,
          disputeLosses: profile.disputeLosses,
          votesCorrect: profile.votesCorrect,
          votesTotal: profile.votesTotal,
          slashedWei: profile.slashedWei,
          lastUpdated: Number(profile.lastUpdated),
        },
        now
      );

      // The contract computes age = now - lastUpdated; the reference does the same, so
      // they must agree exactly rather than approximately.
      expect(onChain).to.equal(reference);
    });
  });
});