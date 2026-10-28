import { time } from "@nomicfoundation/hardhat-network-helpers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

import {
  buildParams,
  createCampaign,
  DAY,
  deploySystem,
  GOAL,
  resolveMilestone,
  stakeVerifier,
} from "./helpers";

/**
 * Lifecycle tests for the milestone escrow.
 *
 * Covers objective O1: milestone-based escrow with automated tranche release and
 * automatic refunds.
 */
describe("Campaign escrow lifecycle", () => {
  async function fixture() {
    const system = await deploySystem();
    await stakeVerifier(system.verifier, system.verifier1);
    await stakeVerifier(system.verifier, system.verifier2);
    await stakeVerifier(system.verifier, system.verifier3);
    return system;
  }

  describe("deployment and funding", () => {
    it("registers each new campaign with the verifier", async () => {
      const { factory, verifier, creator } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);

      expect(await factory.isCampaign(campaignAddress)).to.equal(true);
      expect(await verifier.registeredCampaign(campaignAddress)).to.equal(true);
      expect(await factory.campaignCount()).to.equal(1n);
    });

    it("rejects a tranche schedule that does not sum to 100%", async () => {
      const { factory, creator } = await loadFixture(fixture);
      const params = await buildParams();
      const bad = { ...params, trancheBps: [4_000, 3_500, 2_000] }; // 9500

      await expect(factory.connect(creator).createCampaign(bad)).to.be.revertedWithCustomError(
        factory,
        "InvalidTrancheSum"
      );
    });

    it("accumulates contributions and reports the goal as met", async () => {
      const { factory, creator, backer, backer2 } = await loadFixture(fixture);
      const campaignAddress = await createCampaign(factory, creator, await buildParams());
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL / 2n });
      await campaign.connect(backer2).contribute({ value: GOAL / 2n });

      expect(await campaign.totalContributed()).to.equal(GOAL);
      expect(await campaign.goalMet()).to.equal(true);
      expect(await campaign.escrowBalance()).to.equal(GOAL);
    });

    it("rejects contributions after the funding deadline", async () => {
      const { factory, creator, backer } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await time.increaseTo(params.fundingDeadline + 1);

      await expect(
        campaign.connect(backer).contribute({ value: GOAL })
      ).to.be.revertedWithCustomError(campaign, "FundingPeriodOver");
    });

    it("cannot be closed before the funding deadline", async () => {
      const { factory, creator } = await loadFixture(fixture);
      const campaignAddress = await createCampaign(factory, creator, await buildParams());
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await expect(campaign.closeFunding()).to.be.revertedWithCustomError(
        campaign,
        "FundingPeriodOver"
      );
    });
  });

  describe("failed funding -> automatic refunds", () => {
    it("fails the campaign and refunds every backer pro-rata", async () => {
      const { factory, creator, backer, backer2, treasury } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      const backerAmount = ethers.parseEther("30");
      const backer2Amount = ethers.parseEther("20");

      await campaign.connect(backer).contribute({ value: backerAmount });
      await campaign.connect(backer2).contribute({ value: backer2Amount });

      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();

      expect(await campaign.state()).to.equal(2n); // Failed

      // Nothing was released, so the whole pool is refundable.
      expect(await campaign.refundableBalance()).to.equal(backerAmount + backer2Amount);

      // Use the RefundClaimed event amount (gas is paid by the caller, so a raw
      // balance diff would be net of gas and not exactly equal the refund).
      const tx1 = await campaign.connect(backer).claimRefund();
      const rcpt1 = await tx1.wait();
      const refund1 = rcpt1!.logs
        .map((log: any) => {
          try {
            return campaign.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: any) => parsed?.name === "RefundClaimed")!.args.amount;

      const tx2 = await campaign.connect(backer2).claimRefund();
      await tx2.wait();

      expect(refund1).to.equal(backerAmount);
      expect(await campaign.escrowBalance()).to.equal(0n);
      expect(await campaign.totalRefunded()).to.equal(backerAmount + backer2Amount);
      void treasury;
    });

    it("does not allow a double refund", async () => {
      const { factory, creator, backer } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL / 4n });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();
      await campaign.connect(backer).claimRefund();

      await expect(campaign.connect(backer).claimRefund()).to.be.revertedWithCustomError(
        campaign,
        "NothingToClaim"
      );
    });

    it("blocks refunds while the campaign is still funding", async () => {
      const { factory, creator, backer } = await loadFixture(fixture);
      const campaignAddress = await createCampaign(factory, creator, await buildParams());
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL / 2n });

      await expect(campaign.connect(backer).claimRefund()).to.be.revertedWithCustomError(
        campaign,
        "WrongState"
      );
    });
  });

  describe("successful campaign -> tranche release", () => {
    it("releases each tranche on verification and completes at 100%", async () => {
      const { factory, verifier, creator, backer, verifier1, verifier2, verifier3 } =
        await loadFixture(fixture);

      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();
      expect(await campaign.state()).to.equal(1n); // Active

      const verifiers = [verifier1, verifier2, verifier3];

      // Milestone 0 -> 4000 bps, all three approve.
      await campaign.submitEvidence(0, "local-evidence-0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));
      await resolveMilestone(campaign, verifier, 0, verifiers, 3);

      expect(await campaign.releasedBps()).to.equal(4_000n);
      // 40% of the 100 ETH goal.
      expect(await campaign.totalReleased()).to.equal(ethers.parseEther("40"));
      expect(await campaign.state()).to.equal(1n); // still Active

      // Milestone 1 -> 3500 bps, two approve.
      await campaign.submitEvidence(1, "local-evidence-1", ethers.keccak256(ethers.toUtf8Bytes("ev1")));
      await resolveMilestone(campaign, verifier, 1, verifiers, 2);
      expect(await campaign.releasedBps()).to.equal(7_500n);
      expect(await campaign.totalReleased()).to.equal(ethers.parseEther("75"));

      // Milestone 2 -> 2500 bps, completes the campaign.
      await campaign.submitEvidence(2, "local-evidence-2", ethers.keccak256(ethers.toUtf8Bytes("ev2")));
      await resolveMilestone(campaign, verifier, 2, verifiers, 3);
      expect(await campaign.releasedBps()).to.equal(10_000n);
      expect(await campaign.totalReleased()).to.equal(GOAL);
      expect(await campaign.state()).to.equal(3n); // Completed

      // Creator pulls the full released balance.
      const claimTx = await campaign.claimCreatorBalance();
      const claimRcpt = await claimTx.wait();
      const payout = claimRcpt!.logs
        .map((log: any) => {
          try {
            return campaign.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: any) => parsed?.name === "CreatorBalanceClaimed")!.args.amount;

      expect(payout).to.equal(GOAL);
      expect(await campaign.escrowBalance()).to.equal(0n);
      void before;
      void after;
    });

    it("cannot submit evidence twice for the same milestone", async () => {
      const { factory, creator, backer } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();

      const hash = ethers.keccak256(ethers.toUtf8Bytes("ev"));
      await campaign.submitEvidence(0, "cid", hash);

      await expect(campaign.submitEvidence(0, "cid2", hash)).to.be.revertedWithCustomError(
        campaign,
        "MilestoneAlreadyResolved"
      );
    });

    it("rejects evidence submission from a non-creator", async () => {
      const { factory, creator, backer } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();

      await expect(
        campaign
          .connect(backer)
          .submitEvidence(0, "cid", ethers.keccak256(ethers.toUtf8Bytes("ev")))
      ).to.be.revertedWithCustomError(campaign, "NotCreator");
    });

    it("rejects evidence submitted after the milestone deadline", async () => {
      const { factory, creator, backer } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();

      await time.increaseTo(params.milestoneDeadlines[0] + 1);

      await expect(
        campaign.submitEvidence(0, "cid", ethers.keccak256(ethers.toUtf8Bytes("ev")))
      ).to.be.revertedWithCustomError(campaign, "MilestoneDeadlinePassed");
    });
  });

  describe("rejected milestone -> remaining funds refundable", () => {
    it("locks the tranche and lets the creator abandon, then refunds backers", async () => {
      const { factory, verifier, creator, backer, backer2, verifier1, verifier2, verifier3 } =
        await loadFixture(fixture);

      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: ethers.parseEther("60") });
      await campaign.connect(backer2).contribute({ value: ethers.parseEther("60") });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();

      const verifiers = [verifier1, verifier2, verifier3];

      // Milestone 0 verified -> 40% of the *actual raise* (120 ETH) = 48 ETH.
      await campaign.submitEvidence(0, "ev0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));
      await resolveMilestone(campaign, verifier, 0, verifiers, 3);
      expect(await campaign.totalReleased()).to.equal(ethers.parseEther("48"));

      // Milestone 1 rejected (majority Reject).
      await campaign.submitEvidence(1, "ev1", ethers.keccak256(ethers.toUtf8Bytes("ev1")));
      await resolveMilestone(campaign, verifier, 1, verifiers, 0);

      const milestone = await campaign.getMilestone(1);
      expect(milestone.state).to.equal(3n); // Rejected

      // Creator collects what was legitimately earned.
      const creatorClaimTx = await campaign.claimCreatorBalance();
      const creatorClaimRcpt = await creatorClaimTx.wait();
      const creatorPayout = creatorClaimRcpt!.logs
        .map((log: any) => {
          try {
            return campaign.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: any) => parsed?.name === "CreatorBalanceClaimed")!.args.amount;
      expect(creatorPayout).to.equal(ethers.parseEther("48"));

      // Creator abandons the campaign; the unreleased 72 ETH becomes refundable.
      await campaign.failCampaign();
      expect(await campaign.state()).to.equal(2n); // Failed
      expect(await campaign.refundableBalance()).to.equal(ethers.parseEther("72"));

      // Each backer contributed half the pool, so each is owed half the pot.
      const r1 = await campaign.connect(backer).claimRefund();
      const rc1 = await r1.wait();
      const refund1 = rc1!.logs
        .map((log: any) => {
          try {
            return campaign.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: any) => parsed?.name === "RefundClaimed")!.args.amount;

      const r2 = await campaign.connect(backer2).claimRefund();
      const rc2 = await r2.wait();
      const refund2 = rc2!.logs
        .map((log: any) => {
          try {
            return campaign.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: any) => parsed?.name === "RefundClaimed")!.args.amount;

      expect(refund1).to.equal(ethers.parseEther("36"));
      expect(refund2).to.equal(ethers.parseEther("36"));
      expect(await campaign.escrowBalance()).to.equal(0n);
    });

    it("rejects resolving a milestone that was never submitted", async () => {
      const { factory, creator, backer } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();

      await expect(campaign.resolveMilestone(0)).to.be.revertedWithCustomError(
        campaign,
        "MilestoneNotSubmitted"
      );
    });
  });
});
