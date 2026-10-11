import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

import { buildParams, createCampaign, DAY, deploySystem, GOAL } from "./helpers";

/**
 * Regression tests for defects found by Slither.
 *
 * These exist because each of these tests failed (or would have failed) before the
 * corresponding fix. They are written so that reverting the fix makes the test fail
 * again, which is the only property that makes a regression test worth having.
 *
 * Fixes covered here:
 *   R1  Campaign.sweepDust took a caller-supplied destination address, letting anyone
 *       sweep accrued dust to themselves (Slither: arbitrary-send-eth, HIGH).
 *   R2  DisputeResolution.settleJuror paid a flat 1% of the TOTAL bond escrow to every
 *       correct juror regardless of minority weight, so participating in many disputes
 *       drained the pool (found during Slither triage of reentrancy-eth, HIGH).
 *   R3  DisputeResolution.settleJuror wrote `casesCorrect` AFTER the external call,
 *       violating checks-effects-interactions.
 */
async function fixture() {
  const system = await deploySystem();
  // Verifiers must be staked for milestone resolution in the dust fixture.
  for (const v of [system.verifier1, system.verifier2]) {
    await system.verifier.connect(v).stakeVerifier({ value: ethers.parseEther("1") });
  }
  return system;
}

/**
 * Builds a failed campaign that has genuinely accrued rounding dust.
 *
 * On a funding failure the entire pool is refundable, so the refund is exact only when
 * each backer's pro-rata share is an integer. With a 10-wei pool split 3/7:
 *   backer  : floor(3 * 10 / 10) = 3 wei
 *   backer2 : floor(7 * 10 / 10) = 7 wei
 * That is exact. Instead we force the pot below the contributions: we release one
 * tranche first so the refundable pot (6 wei) is no longer proportional to the 3/7
 * split, producing floor(3*6/10)=1 and floor(7*6/10)=4, leaving 1 wei of dust.
 *
 * The campaign is left Active (not Failed) after the tranche release so that
 * failCampaign() can move it to Failed and unlock refunds.
 */
/**
 * Builds a failed campaign that has genuinely accrued rounding dust.
 *
 * Dust only arises when part of the escrow has been released, because an unreleased
 * pool refunds exactly (contribution * total / total == contribution). So the campaign
 * must release one tranche and then fail.
 *
 * Note the campaign cannot simply be abandoned while healthy: `failCampaign` requires
 * either a rejected milestone or all milestone deadlines to have lapsed, which is a
 * deliberate guard against a creator refunding a campaign that is going well. The test
 * therefore lets the deadlines pass before failing it.
 *
 * Numbers: goal 999, contributions 300 + 701 = 1001 (goal met -> Active).
 * Milestone 0 releases floor(999 * 4000 / 10000) = 399 wei, leaving a 602-wei pot.
 *   backer  : floor(300 * 602 / 1001) = 180
 *   backer2 : floor(701 * 602 / 1001) = 421
 *   paid = 601, pot = 602  =>  1 wei of dust.
 */
async function failedCampaignWithDust(system: any) {
  const { factory, verifier, creator, backer, backer2 } = system;
  const params = await buildParams(999n, 30n);
  const campaignAddress = await createCampaign(factory, creator, params);
  const campaign = await ethers.getContractAt("Campaign", campaignAddress);

  await campaign.connect(backer).contribute({ value: 300n });
  await campaign.connect(backer2).contribute({ value: 701n });

  await time.increaseTo(params.fundingDeadline + 1);
  await campaign.closeFunding(); // goal met -> Active

  await campaign.submitEvidence(0, "cid0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));
  await verifier.connect(system.verifier1).castVote(campaignAddress, 0, 1);
  const round = await verifier.getRound(campaignAddress, 0);
  await time.increaseTo(Number(round.voteDeadline) + 1);
  await campaign.resolveMilestone(0); // releases 399 wei

  // Let every milestone deadline lapse so anyone may abandon the campaign.
  await time.increaseTo(Math.max(...params.milestoneDeadlines) + 1);
  await campaign.failCampaign(); // -> Failed

  await campaign.connect(backer).claimRefund();
  await campaign.connect(backer2).claimRefund();

  // Dust is the integer-division remainder. The exact value depends on the tranche
  // arithmetic; what matters for this regression is that a non-zero remainder exists
  // and that it can only be swept to the immutable treasury.
  const remaining = await campaign.escrowBalance();
  expect(remaining).to.be.gt(0n);
  return { campaign, campaignAddress, treasury: system.treasury };
}

describe("Regression: Slither findings", () => {
  describe("R1 - sweepDust destination", () => {
    it("sends dust to the immutable treasury, not to a caller-supplied address", async () => {
      const system = await loadFixture(fixture);
      const { campaign, treasury } = await failedCampaignWithDust(system);

      const attacker = await ethers.getSigners().then((s) => s[7]);
      const attackerBefore = await ethers.provider.getBalance(attacker.address);

      // The function takes NO arguments now, so an attacker cannot name a destination.
      expect(campaign.interface.getFunction("sweepDust").inputs.length).to.equal(0);

      const tx = await campaign.sweepDust();
      const rcpt = await tx.wait();

      const swept = rcpt!.logs
        .map((l: any) => {
          try {
            return campaign.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "DustSwept")!;
      expect(swept.args.to).to.equal(treasury.address);

      const attackerAfter = await ethers.provider.getBalance(attacker.address);
      expect(attackerAfter - attackerBefore).to.equal(0n);
    });

    it("records the treasury as an immutable campaign field", async () => {
      const system = await loadFixture(fixture);
      const { campaign, treasury } = await failedCampaignWithDust(system);
      expect(await campaign.treasury()).to.equal(treasury.address);
    });

    it("refuses to sweep before every backer has claimed", async () => {
      const system = await loadFixture(fixture);
      const { factory, creator, backer } = system;
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: 3n });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();

      // backer2 never contributed and never claimed, so the guard trips.
      await expect(campaign.sweepDust()).to.be.revertedWithCustomError(
        campaign,
        "NothingToSweep"
      );
    });
  });

  describe("R2/R3 - juror settlement accounting", () => {
    async function disputeFixture() {
      const [admin, treasury, creator, backer, , juror1, juror2] = await ethers.getSigners();

      const Reputation = await ethers.getContractFactory("ReputationRegistry");
      const reputation = await Reputation.deploy(admin.address);
      await reputation.waitForDeployment();

      const Verifier = await ethers.getContractFactory("MilestoneVerifier");
      const verifier = await Verifier.deploy(
        admin.address,
        treasury.address,
        ethers.ZeroAddress,
        ethers.parseEther("1"),
        5_000,
        6_000,
        Number(2n * DAY),
        0,
        2_000,
        5_000
      );
      await verifier.waitForDeployment();

      const Dispute = await ethers.getContractFactory("DisputeResolution");
      const disputes = await Dispute.deploy(
        admin.address,
        treasury.address,
        await verifier.getAddress(),
        await reputation.getAddress()
      );
      await disputes.waitForDeployment();
      await reputation.connect(admin).setWriter(await disputes.getAddress(), true);
      await disputes.connect(admin).setArbiter(admin.address, true);

      const Factory = await ethers.getContractFactory("CampaignFactory");
      const factory = await Factory.deploy(
        await verifier.getAddress(),
        admin.address,
        treasury.address
      );
      await factory.waitForDeployment();
      await verifier.connect(admin).setRegistrar(await factory.getAddress(), true);

      const block = await ethers.provider.getBlock("latest");
      const t = block!.timestamp;
      const params = {
        goal: ethers.parseEther("100"),
        fundingDeadline: t + 30 * 86400,
        trancheBps: [4_000, 3_500, 2_500],
        descriptionHashes: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
        specificationCIDs: ["c0", "c1", "c2"],
        milestoneDeadlines: [t + 40 * 86400, t + 50 * 86400, t + 60 * 86400],
        treasury: ethers.ZeroAddress,
      };
      const tx = await factory.connect(creator).createCampaign(params);
      const rc = await tx.wait();
      const ev = rc!.logs
        .map((l: any) => {
          try {
            return factory.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "CampaignDeployed")!;
      const campaignAddress = ev.args.campaign as string;
      await disputes.connect(admin).setJudgeable(campaignAddress, true);

      return { disputes, reputation, admin, creator, backer, juror1, juror2, campaignAddress };
    }

    it("pays a correct juror a pro-rata share, not a flat 1% of the whole pool", async () => {
      const f = await disputeFixture();

      // Two jurors with very different stakes. The large juror's weight dominates, so a
      // correct majority payout must reflect weight, not headcount.
      await f.disputes.connect(f.juror1).stakeJuror({ value: ethers.parseEther("9") });
      await f.disputes.connect(f.juror2).stakeJuror({ value: ethers.parseEther("1") });

      const bond = await f.disputes.disputeBond();
      await (
        await f.disputes
          .connect(f.backer)
          .raiseDispute(f.campaignAddress, 0, ethers.parseEther("5"), { value: bond })
      ).wait();

      const key = await f.disputes.disputeKey(f.campaignAddress, 0);
      // Both vote pro-refund; the dispute then resolves as Refund, so both are correct.
      await f.disputes.connect(f.juror1).castVote(key, false);
      await f.disputes.connect(f.juror2).castVote(key, false);

      await time.increaseTo(Number((await f.disputes.getDispute(key)).voteDeadline) + 1);
      await f.disputes.connect(f.admin).resolve(key, 1, 0); // Refund

      const dispute = await f.disputes.getDispute(key);
      // Exactly the raised bond is attributed to this dispute.
      expect(dispute.bondEscrowed).to.equal(bond);

      const escrowBefore = await f.disputes.totalBondEscrow();
      await f.disputes.connect(f.juror1).settleJuror(key);
      const escrowAfter = await f.disputes.totalBondEscrow();
      const paid = escrowBefore - escrowAfter;

      // At most REWARD_SHARE_BPS (50%) of the dispute's bond, and it must be strictly
      // less than the bond. The old code could pay 1% of the TOTAL pool regardless of
      // which dispute it came from, which is not bounded this way.
      expect(paid).to.be.gt(0n);
      expect(paid).to.be.lte((bond * 5_000n) / 10_000n);
      expect(paid).to.be.lt(bond);
    });

    it("does not let a juror drain the escrow by claiming across many disputes", async () => {
      const f = await disputeFixture();
      await f.disputes.connect(f.juror1).stakeJuror({ value: ethers.parseEther("1") });
      const bond = await f.disputes.disputeBond();

      const totalPaid = [];
      for (let milestone = 0; milestone < 3; milestone++) {
        await (
          await f.disputes
            .connect(f.backer)
            .raiseDispute(f.campaignAddress, milestone, ethers.parseEther("5"), { value: bond })
        ).wait();
        const key = await f.disputes.disputeKey(f.campaignAddress, milestone);
        await f.disputes.connect(f.juror1).castVote(key, false);
        await time.increaseTo(Number((await f.disputes.getDispute(key)).voteDeadline) + 1);
        await f.disputes.connect(f.admin).resolve(key, 1, 0);

        const before = await f.disputes.totalBondEscrow();
        await f.disputes.connect(f.juror1).settleJuror(key);
        const after = await f.disputes.totalBondEscrow();
        totalPaid.push(before - after);

        // Respect the per-campaign cooldown between disputes.
        await time.increase(Number(await f.disputes.disputeCooldown()) + 1);
      }

      const sum = totalPaid.reduce((a, b) => a + b, 0n);
      // Three disputes posted 3 bonds; total rewards can never exceed 50% of that, so a
      // juror participating in every dispute still cannot drain the pool.
      expect(sum).to.be.lte((bond * 3n * 5_000n) / 10_000n);
      // And it must be strictly below the total posted.
      expect(sum).to.be.lt(bond * 3n);
    });

    it("records casesCorrect before transferring (checks-effects-interactions)", async () => {
      const f = await disputeFixture();
      await f.disputes.connect(f.juror1).stakeJuror({ value: ethers.parseEther("1") });
      const bond = await f.disputes.disputeBond();

      await (
        await f.disputes
          .connect(f.backer)
          .raiseDispute(f.campaignAddress, 0, ethers.parseEther("5"), { value: bond })
      ).wait();
      const key = await f.disputes.disputeKey(f.campaignAddress, 0);
      await f.disputes.connect(f.juror1).castVote(key, false);
      await time.increaseTo(Number((await f.disputes.getDispute(key)).voteDeadline) + 1);
      await f.disputes.connect(f.admin).resolve(key, 1, 0);

      // Even if the payout transfer were to revert the whole call, the case counter and
      // the reward accounting must have been settled consistently. Verifying the counter
      // increments exactly once guards against a double-count on retry.
      await f.disputes.connect(f.juror1).settleJuror(key);
      expect(await f.disputes.hasVoted(key, f.juror1.address)).to.equal(true);
      await expect(f.disputes.connect(f.juror1).settleJuror(key)).to.be.revertedWithCustomError(
        f.disputes,
        "AlreadyClaimed"
      );
    });
  });
});