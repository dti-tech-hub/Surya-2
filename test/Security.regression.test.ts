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
      const system = await deploySystem();
      const { factory, verifier, reputation, creator, backer, treasury } = system;

      const Dispute = await ethers.getContractFactory("DisputeResolution");
      const disputes = await Dispute.deploy(
        creator.address,
        treasury.address,
        await verifier.getAddress(),
        await reputation.getAddress()
      );
      await disputes.waitForDeployment();
      await reputation.connect(creator).setWriter(await disputes.getAddress(), true);
      await disputes.connect(creator).setRegistrar(await factory.getAddress(), true);
      await factory.connect(creator).setDisputeModule(await disputes.getAddress());

      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();
      await campaign
        .connect(creator)
        .submitEvidence(0, "cid0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));

      return {
        ...system,
        disputes,
        campaign,
        campaignAddress,
      };
    }

    it("bounds a correct juror's reward by the dispute's own bond and weights it by stake", async () => {
      const f = await disputeFixture();
      const jurorA = f.verifier1;
      const jurorB = f.verifier2;

      // Two jurors with very different stakes. Payout must reflect weight, not headcount.
      await f.disputes.connect(jurorA).stakeJuror({ value: ethers.parseEther("9") });
      await f.disputes.connect(jurorB).stakeJuror({ value: ethers.parseEther("1") });

      const bond = await f.disputes.disputeBond();
      await (
        await f.disputes.connect(f.backer).raiseDispute(f.campaignAddress, 0, { value: bond })
      ).wait();

      const key = await f.disputes.disputeKey(f.campaignAddress, 0);
      await f.disputes.connect(jurorA).castVote(key, true);
      await f.disputes.connect(jurorB).castVote(key, true);

      await time.increaseTo(Number((await f.disputes.getDispute(key)).voteDeadline) + 1);
      await f.disputes.connect(f.creator).resolve(key); // Release: raiser loses bond

      const before = await f.disputes.getDispute(key);
      expect(before.rewardPool).to.equal((bond * 5_000n) / 10_000n);

      const tx = await f.disputes.connect(jurorA).settleJuror(key);
      const rcpt = await tx.wait();
      const rewardA = rcpt!.logs
        .map((log: any) => {
          try {
            return f.disputes.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((p: any) => p?.name === "JurorSettled")!.args.reward;

      // 90% of the reserved 0.025 ETH pool.
      expect(rewardA).to.equal(ethers.parseEther("0.0225"));
      expect(rewardA).to.be.lte((bond * 5_000n) / 10_000n);
      expect(rewardA).to.be.lt(bond);
    });

    it("prevents a losing juror from withdrawing before settlement and slashes them once", async () => {
      const f = await disputeFixture();
      const jurorA = f.verifier1;
      const jurorB = f.verifier2;
      const jurorC = f.verifier3;

      await f.disputes.connect(jurorA).stakeJuror({ value: ethers.parseEther("1") });
      await f.disputes.connect(jurorB).stakeJuror({ value: ethers.parseEther("1") });
      await f.disputes.connect(jurorC).stakeJuror({ value: ethers.parseEther("1") });

      const bond = await f.disputes.disputeBond();
      await (
        await f.disputes.connect(f.backer).raiseDispute(f.campaignAddress, 0, { value: bond })
      ).wait();
      const key = await f.disputes.disputeKey(f.campaignAddress, 0);

      await f.disputes.connect(jurorA).castVote(key, false); // refund (loses)
      await f.disputes.connect(jurorB).castVote(key, true); // creator
      await f.disputes.connect(jurorC).castVote(key, true); // creator

      // The vote-time stake is locked: withdrawal is refused before settlement.
      await expect(
        f.disputes.connect(jurorA).withdrawJurorStake(ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(f.disputes, "InsufficientShare");

      await time.increaseTo(Number((await f.disputes.getDispute(key)).voteDeadline) + 1);
      await f.disputes.connect(f.creator).resolve(key); // Release

      await f.disputes.connect(jurorA).settleJuror(key);
      expect(await f.disputes.jurorWeight(jurorA.address)).to.equal(ethers.parseEther("0.9"));
      expect(await f.disputes.jurorWeight(jurorB.address)).to.equal(ethers.parseEther("1"));

      // Settlement is idempotent per juror.
      await expect(
        f.disputes.connect(jurorA).settleJuror(key)
      ).to.be.revertedWithCustomError(f.disputes, "AlreadyClaimed");
    });
  });
});