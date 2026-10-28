import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

import {
  buildParams,
  createCampaign,
  deploySystem,
  GOAL,
  resolveMilestone,
  stakeVerifier,
} from "./helpers";

/**
 * Dispute-resolution tests.
 *
 * The fixture deliberately drives a real campaign to the point where milestone 0 has
 * been rejected by the verifier panel. That is the state in which a backer would appeal,
 * and it lets every assertion check both the juror tally and the resulting escrow move.
 */
async function fixture() {
  const system = await deploySystem();
  const { factory, verifier, reputation, creator, backer, backer2, treasury } = system;

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

  // Stake the verifier panel and drive milestone 0 to Rejected.
  await stakeVerifier(verifier, system.verifier1);
  await stakeVerifier(verifier, system.verifier2);
  await stakeVerifier(verifier, system.verifier3);

  await campaign.connect(backer).contribute({ value: GOAL });
  await time.increaseTo(params.fundingDeadline + 1);
  await campaign.closeFunding();
  await campaign.submitEvidence(0, "cid0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));
  await resolveMilestone(campaign, verifier, 0, [system.verifier1, system.verifier2, system.verifier3], 0);

  const milestone = await campaign.getMilestone(0);
  expect(milestone.state).to.equal(3n); // Rejected

  return {
    ...system,
    disputes,
    campaign,
    campaignAddress,
    params,
    backer2,
  };
}

async function raise(f: any, milestone = 0, overrides: any = {}) {
  const bond = overrides.value ?? (await f.disputes.disputeBond());
  const tx = await f.disputes.connect(f.backer).raiseDispute(f.campaignAddress, milestone, {
    value: bond,
  });
  await tx.wait();
  return f.disputes.disputeKey(f.campaignAddress, milestone);
}

async function expireDispute(f: any, key: string) {
  await time.increaseTo(Number((await f.disputes.getDispute(key)).voteDeadline) + 1);
}

describe("DisputeResolution", () => {
  describe("juror staking", () => {
    it("requires a minimum stake to serve", async () => {
      const { disputes, backer } = await loadFixture(fixture);
      await expect(
        disputes.connect(backer).stakeJuror({ value: ethers.parseEther("0.01") })
      ).to.be.revertedWithCustomError(disputes, "InsufficientShare");
    });

    it("tracks juror weight under linear weighting", async () => {
      const { disputes, backer } = await loadFixture(fixture);
      await disputes.connect(backer).stakeJuror({ value: ethers.parseEther("4") });
      expect(await disputes.jurorWeight(backer.address)).to.equal(ethers.parseEther("4"));
    });

    it("applies sublinear weighting when the exponent is 0.5", async () => {
      const { disputes, creator, backer } = await loadFixture(fixture);
      await disputes
        .connect(creator)
        .setParameters(ethers.parseEther("0.05"), 3 * 86400, 86400, 5n * 10n ** 17n, 1_000);
      await disputes.connect(backer).stakeJuror({ value: ethers.parseEther("4") });

      // sqrt(4e18) = 2e9
      expect(await disputes.jurorWeight(backer.address)).to.equal(2_000_000_000n);
    });

    it("locks stake used in a vote until the juror settles", async () => {
      const { disputes, campaignAddress, backer, backer2, creator } = await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });

      await disputes.connect(backer2).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(backer2).castVote(key, false);

      await expect(
        disputes.connect(backer2).withdrawJurorStake(ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(disputes, "InsufficientShare");

      await expireDispute({ disputes }, key);
      await disputes.connect(creator).resolve(key);
      await disputes.connect(backer2).settleJuror(key);

      // The refund vote was correct, so the stake is intact and fully withdrawable.
      await disputes.connect(backer2).withdrawJurorStake(ethers.parseEther("1"));
      expect(await disputes.jurorWeight(backer2.address)).to.equal(0n);
    });
  });

  describe("raising disputes", () => {
    it("rejects disputes against non-judgeable campaigns", async () => {
      const { disputes, backer } = await loadFixture(fixture);
      await expect(
        disputes
          .connect(backer)
          .raiseDispute(ethers.getAddress("0x000000000000000000000000000000000000dEaD"), 0, {
            value: ethers.parseEther("0.05"),
          })
      ).to.be.revertedWithCustomError(disputes, "NotJudgeable");
    });

    it("requires the caller to be an on-chain backer", async () => {
      const { disputes, campaignAddress, backer2 } = await loadFixture(fixture);
      await expect(
        disputes.connect(backer2).raiseDispute(campaignAddress, 0, {
          value: ethers.parseEther("0.05"),
        })
      ).to.be.revertedWithCustomError(disputes, "NotBacker");
    });

    it("requires the bond", async () => {
      const { disputes, campaignAddress, backer } = await loadFixture(fixture);
      await expect(
        disputes.connect(backer).raiseDispute(campaignAddress, 0, {
          value: ethers.parseEther("0.001"),
        })
      ).to.be.revertedWithCustomError(disputes, "InsufficientShare");
    });

    it("rejects an out-of-range milestone", async () => {
      const { disputes, campaignAddress, backer } = await loadFixture(fixture);
      await expect(
        disputes.connect(backer).raiseDispute(campaignAddress, 99, {
          value: ethers.parseEther("0.05"),
        })
      ).to.be.revertedWithCustomError(disputes, "InvalidMilestone");
    });

    it("opens a dispute and escrows the bond", async () => {
      const { disputes, campaignAddress, backer } = await loadFixture(fixture);
      await disputes.connect(backer).raiseDispute(campaignAddress, 0, {
        value: ethers.parseEther("0.05"),
      });

      const key = await disputes.disputeKey(campaignAddress, 0);
      const d = await disputes.getDispute(key);
      expect(d.state).to.equal(2n); // Voting
      expect(d.raiser).to.equal(backer.address);
      expect(d.raiserBond).to.equal(ethers.parseEther("0.05"));
      expect(await disputes.totalBondEscrow()).to.equal(ethers.parseEther("0.05"));
    });

    it("enforces a cooldown so one backer cannot re-stall a campaign", async () => {
      const { disputes, campaign, campaignAddress, backer, creator } = await loadFixture(fixture);
      const params = { value: ethers.parseEther("0.05") };

      await disputes.connect(backer).raiseDispute(campaignAddress, 0, params);
      const key = await disputes.disputeKey(campaignAddress, 0);

      await expect(
        disputes.connect(backer).raiseDispute(campaignAddress, 1, params)
      ).to.be.revertedWithCustomError(disputes, "CooldownActive");

      await expireDispute({ disputes }, key);
      await disputes.connect(creator).resolve(key); // Refund -> campaign fails
      expect(await campaign.state()).to.equal(2n); // Failed
      await time.increase(86401);

      // A new dispute on another milestone is accepted after the cooldown. The campaign
      // is already Failed, so the protocol refuses it as no longer disputable.
      await expect(
        disputes.connect(backer).raiseDispute(campaignAddress, 1, params)
      ).to.be.revertedWithCustomError(disputes, "CampaignNotDisputable");
    });
  });

  describe("voting", () => {
    it("rejects votes from unstaked addresses", async () => {
      const { disputes, campaignAddress, backer, backer2 } = await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });
      await expect(
        disputes.connect(backer2).castVote(key, true)
      ).to.be.revertedWithCustomError(disputes, "NotAStakedJuror");
    });

    it("prevents a juror from voting twice", async () => {
      const { disputes, campaignAddress, backer, backer2 } = await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });

      await disputes.connect(backer2).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(backer2).castVote(key, true);
      await expect(disputes.connect(backer2).castVote(key, false)).to.be.revertedWithCustomError(
        disputes,
        "AlreadyVoted"
      );
    });

    it("rejects votes after the window closes", async () => {
      const { disputes, campaignAddress, backer, backer2 } = await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });
      await disputes.connect(backer2).stakeJuror({ value: ethers.parseEther("1") });
      await expireDispute({ disputes }, key);
      await expect(
        disputes.connect(backer2).castVote(key, true)
      ).to.be.revertedWithCustomError(disputes, "VotingStillOpen");
    });
  });

  describe("tally-derived resolution and escrow effect", () => {
    it("refunds the campaign when the panel leans for the backer, without an arbiter", async () => {
      const { disputes, campaign, campaignAddress, backer, backer2, creator, treasury } =
        await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });

      await disputes.connect(backer2).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(backer2).castVote(key, false); // refund

      await expireDispute({ disputes }, key);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await disputes.connect(backer).resolve(key); // permissionless

      const d = await disputes.getDispute(key);
      expect(d.outcome).to.equal(1n); // Refund
      expect(await campaign.state()).to.equal(2n); // Failed -> refunds unlocked
      expect(await campaign.totalReleased()).to.equal(0n);

      // The raiser prevailed, so the bond went back to them, not the treasury.
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      expect(treasuryAfter).to.equal(treasuryBefore);
      void creator;
    });

    it("releases the tranche when the panel leans for the creator", async () => {
      const { disputes, campaign, campaignAddress, backer, backer2, creator, treasury } =
        await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });

      await disputes.connect(backer2).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(backer2).castVote(key, true); // creator

      await expireDispute({ disputes }, key);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await disputes.connect(creator).resolve(key);

      const d = await disputes.getDispute(key);
      expect(d.outcome).to.equal(2n); // Release
      expect(await campaign.totalReleased()).to.equal(ethers.parseEther("40"));
      expect((await campaign.getMilestone(0)).state).to.equal(2n); // Verified

      // Losing raiser bond: half reserved for the correct juror, half to treasury.
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.025"));
    });

    it("splits a tied panel 50/50 and fails the campaign for the remainder", async () => {
      const { disputes, campaign, campaignAddress, backer, backer2, creator } =
        await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });

      await disputes.connect(backer2).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(creator).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(backer2).castVote(key, false); // refund
      await disputes.connect(creator).castVote(key, true); // creator

      await expireDispute({ disputes }, key);
      await disputes.connect(backer).resolve(key);

      const d = await disputes.getDispute(key);
      expect(d.outcome).to.equal(3n); // Partial
      expect(d.partialBps).to.equal(5_000);
      expect(await campaign.totalReleased()).to.equal(ethers.parseEther("20")); // 50% of 40
      expect(await campaign.state()).to.equal(2n); // Failed
      expect(await campaign.refundableBalance()).to.equal(ethers.parseEther("80"));
    });

    it("fails closed for backers and slashes the raiser when nobody votes", async () => {
      const { disputes, campaign, campaignAddress, backer, creator, treasury } =
        await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });

      await expireDispute({ disputes }, key);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await disputes.connect(creator).resolve(key);

      const d = await disputes.getDispute(key);
      expect(d.outcome).to.equal(1n); // Refund
      expect(await campaign.state()).to.equal(2n); // Failed
      expect(await disputes.totalBondEscrow()).to.equal(0n);

      // Empty disputes are not free: the whole bond goes to the treasury.
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.05"));
    });

    it("refuses to resolve before the voting window closes", async () => {
      const { disputes, campaignAddress, backer, creator } = await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });
      await expect(
        disputes.connect(creator).resolve(key)
      ).to.be.revertedWithCustomError(disputes, "VotingStillOpen");
    });

    it("cannot resolve the same dispute twice", async () => {
      const { disputes, campaignAddress, backer, creator } = await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });
      await expireDispute({ disputes }, key);
      await disputes.connect(creator).resolve(key);
      await expect(
        disputes.connect(creator).resolve(key)
      ).to.be.revertedWithCustomError(disputes, "NotOpen");
    });
  });

  describe("juror settlement", () => {
    it("rewards the correct juror from the losing bond", async () => {
      const { disputes, campaignAddress, backer, backer2, creator } = await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });

      await disputes.connect(backer2).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(backer2).castVote(key, true); // creator wins

      await expireDispute({ disputes }, key);
      await disputes.connect(creator).resolve(key);

      const tx = await disputes.connect(backer2).settleJuror(key);
      const rcpt = await tx.wait();
      const reward = rcpt!.logs
        .map((log: any) => {
          try {
            return disputes.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: any) => parsed?.name === "JurorSettled")!.args.reward;

      // 50% of the 0.05 ETH losing bond is reserved; one correct juror gets it all.
      expect(reward).to.equal(ethers.parseEther("0.025"));
      const profile = await disputes.getDispute(key);
      expect(profile.rewardPool).to.equal(0n);
    });

    it("slashes a juror who voted against the resolved outcome", async () => {
      const { disputes, campaignAddress, backer, backer2, creator } = await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });

      await disputes.connect(backer2).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(creator).stakeJuror({ value: ethers.parseEther("2") });
      await disputes.connect(backer2).castVote(key, false); // refund
      await disputes.connect(creator).castVote(key, true); // creator wins 2:1

      await expireDispute({ disputes }, key);
      await disputes.connect(creator).resolve(key);

      await disputes.connect(backer2).settleJuror(key);
      // 10% of the vote-time stake is slashed: 1 ETH -> 0.9 ETH.
      expect(await disputes.jurorWeight(backer2.address)).to.equal(ethers.parseEther("0.9"));

      await expect(
        disputes.connect(backer2).settleJuror(key)
      ).to.be.revertedWithCustomError(disputes, "AlreadyClaimed");
    });

    it("settleJuror is a no-op for a non-voter", async () => {
      const { disputes, campaignAddress, backer, backer2, creator } = await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });
      await expireDispute({ disputes }, key);
      await disputes.connect(creator).resolve(key);
      await disputes.connect(backer2).settleJuror(key);
      expect(await disputes.jurorWeight(backer2.address)).to.equal(0n);
    });
  });

  describe("challenge bonds and admin controls", () => {
    it("accepts a challenge bond and routes it to the treasury on resolution", async () => {
      const { disputes, campaignAddress, backer, backer2, creator, treasury } =
        await loadFixture(fixture);
      const key = await raise({ disputes, campaignAddress, backer });
      const bond = await disputes.disputeBond();

      await disputes.connect(backer2).challengeDispute(campaignAddress, 0, { value: bond });
      expect((await disputes.getDispute(key)).bondEscrowed).to.equal(bond * 2n);

      await disputes.connect(backer2).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(backer2).castVote(key, true);
      await expireDispute({ disputes }, key);

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      await disputes.connect(creator).resolve(key);
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);

      // Raiser bond: 0.025 to the juror pool, 0.025 to treasury. Challenge bond: 0.05
      // to treasury. Total treasury inflow = 0.075 ETH.
      expect(treasuryAfter - treasuryBefore).to.equal(ethers.parseEther("0.075"));
    });

    it("rejects an under-funded challenge", async () => {
      const { disputes, campaignAddress, backer, backer2 } = await loadFixture(fixture);
      await raise({ disputes, campaignAddress, backer });
      await expect(
        disputes.connect(backer2).challengeDispute(campaignAddress, 0, { value: 1n })
      ).to.be.revertedWithCustomError(disputes, "InsufficientShare");
    });

    it("rejects admin changes from a non-admin", async () => {
      const { disputes, backer } = await loadFixture(fixture);
      await expect(
        disputes.connect(backer).setJudgeable(ethers.getAddress("0x000000000000000000000000000000000000dEaD"), true)
      ).to.be.revertedWithCustomError(disputes, "NotAdmin");
      await expect(
        disputes.connect(backer).setRegistrar(backer.address, true)
      ).to.be.revertedWithCustomError(disputes, "NotAdmin");
    });

    it("rejects a bad weight exponent or slash parameter", async () => {
      const { disputes, creator } = await loadFixture(fixture);
      await expect(
        disputes.connect(creator).setParameters(0, 1, 1, 2n * 10n ** 18n, 1_000)
      ).to.be.revertedWithCustomError(disputes, "InvalidBps");
      await expect(
        disputes.connect(creator).setParameters(0, 1, 1, 1n * 10n ** 18n, 20_000)
      ).to.be.revertedWithCustomError(disputes, "InvalidBps");
    });
  });
});
