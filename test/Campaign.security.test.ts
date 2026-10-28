import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

import { buildParams, createCampaign, DAY, deploySystem, GOAL, stakeVerifier } from "./helpers";

/**
 * Security-focused tests.
 *
 * Each test corresponds to a threat enumerated in security/THREAT_MODEL.md:
 *  - reentrancy on payout functions
 *  - double release of a tranche
 *  - quorum bypass / under-participation (fail-closed)
 *  - unauthorised verifier registration
 *  - double voting
 *  - oracle spoofing
 *  - deadline manipulation
 */
describe("Security invariants", () => {
  async function fixture() {
    const system = await deploySystem();
    await stakeVerifier(system.verifier, system.verifier1);
    await stakeVerifier(system.verifier, system.verifier2);
    await stakeVerifier(system.verifier, system.verifier3);
    return system;
  }

  describe("reentrancy", () => {
    it("blocks reentrant calls into claimRefund", async () => {
      const { factory, creator, backer, treasury } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      const ReentrantBacker = await ethers.getContractFactory("ReentrantBacker");
      const attacker = await ReentrantBacker.deploy(campaignAddress);
      await attacker.waitForDeployment();

      const amount = ethers.parseEther("25");
      // Attack mode 1 = ClaimRefund.
      await (await attacker.armAttack(campaignAddress, 1, { value: amount })).wait();

      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();

      await (await attacker.trigger()).wait();

      expect(await attacker.reentrySucceeded()).to.equal(false);
      expect(await campaign.escrowBalance()).to.equal(0n);
      void backer;
      void treasury;
    });

    it("refuses a second refund from the same backer", async () => {
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
  });

  describe("double release", () => {
    it("cannot resolve the same milestone twice", async () => {
      const { factory, verifier, creator, backer, verifier1, verifier2, verifier3 } =
        await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();

      await campaign.submitEvidence(0, "ev0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));
      for (const v of [verifier1, verifier2, verifier3]) {
        await verifier.connect(v).castVote(campaignAddress, 0, 1);
      }
      const round = await verifier.getRound(campaignAddress, 0);
      await time.increaseTo(Number(round.voteDeadline) + 1);
      await campaign.resolveMilestone(0);

      const released = await campaign.totalReleased();
      expect(released).to.equal(ethers.parseEther("40"));

      // Second resolution must fail: the milestone is no longer in Submitted.
      await expect(campaign.resolveMilestone(0)).to.be.revertedWithCustomError(
        campaign,
        "MilestoneNotSubmitted"
      );
      expect(await campaign.totalReleased()).to.equal(released);
    });

    it("cannot claim the creator balance twice", async () => {
      const { factory, verifier, creator, backer, verifier1, verifier2, verifier3 } =
        await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();

      await campaign.submitEvidence(0, "ev0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));
      for (const v of [verifier1, verifier2, verifier3]) {
        await verifier.connect(v).castVote(campaignAddress, 0, 1);
      }
      const round = await verifier.getRound(campaignAddress, 0);
      await time.increaseTo(Number(round.voteDeadline) + 1);
      await campaign.resolveMilestone(0);

      await campaign.claimCreatorBalance();
      await expect(campaign.claimCreatorBalance()).to.be.revertedWithCustomError(
        campaign,
        "NothingToClaim"
      );
    });
  });

  describe("verifier registry access control", () => {
    it("rejects campaign registration from a non-registrar", async () => {
      const { verifier, backer } = await loadFixture(fixture);

      await expect(
        verifier.connect(backer).registerCampaign(backer.address)
      ).to.be.revertedWithCustomError(verifier, "NotRegistrar");
    });

    it("rejects parameter updates from a non-admin", async () => {
      const { verifier, backer } = await loadFixture(fixture);

      await expect(
        verifier
          .connect(backer)
          .setParameters(
            ethers.parseEther("1"),
            5_000,
            6_000,
            Number(2n * DAY),
            0,
            2_000,
            5_000
          )
      ).to.be.revertedWithCustomError(verifier, "NotAdmin");
    });

    it("rejects voting from an unstaked address", async () => {
      const { factory, verifier, creator, backer } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();
      await campaign.submitEvidence(0, "ev0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));

      await expect(
        verifier.connect(backer).castVote(campaignAddress, 0, 1)
      ).to.be.revertedWithCustomError(verifier, "NotActiveVerifier");
    });

    it("rejects a second vote from the same verifier", async () => {
      const { factory, verifier, creator, backer, verifier1 } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();
      await campaign.submitEvidence(0, "ev0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));

      await verifier.connect(verifier1).castVote(campaignAddress, 0, 1);
      await expect(
        verifier.connect(verifier1).castVote(campaignAddress, 0, 2)
      ).to.be.revertedWithCustomError(verifier, "AlreadyVoted");
    });

    it("rejects voting after the window closes", async () => {
      const { factory, verifier, creator, backer, verifier1 } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();
      await campaign.submitEvidence(0, "ev0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));

      const round = await verifier.getRound(campaignAddress, 0);
      await time.increaseTo(Number(round.voteDeadline) + 1);

      await expect(
        verifier.connect(verifier1).castVote(campaignAddress, 0, 1)
      ).to.be.revertedWithCustomError(verifier, "VotingStillOpen");
    });
  });

  describe("fail-closed quorum", () => {
    it("rejects a milestone when quorum is not met, even with all votes Approve", async () => {
      // Deploy a verifier whose quorum (90%) cannot be met by the 3 ETH of total stake.
      const signers = await ethers.getSigners();
      const [creator, backer, , verifier1, verifier2, verifier3, , , , treasury] = signers;

      const Verifier = await ethers.getContractFactory("MilestoneVerifier");
      const verifier = await Verifier.deploy(
        creator.address,
        treasury.address,
        ethers.ZeroAddress,
        ethers.parseEther("1"),
        9_000, // 90% quorum
        6_000,
        Number(2n * DAY),
        0,
        2_000,
        5_000
      );
      await verifier.waitForDeployment();

      const Reputation = await ethers.getContractFactory("ReputationRegistry");
      const reputation = await Reputation.deploy(creator.address);
      await reputation.waitForDeployment();

      const Factory = await ethers.getContractFactory("CampaignFactory");
      const factory = await Factory.deploy(
        await verifier.getAddress(),
        await reputation.getAddress(),
        creator.address,
        treasury.address
      );
      await factory.waitForDeployment();
      await verifier.connect(creator).setRegistrar(await factory.getAddress(), true);
      await reputation.connect(creator).setRegistrar(await factory.getAddress(), true);

      for (const v of [verifier1, verifier2, verifier3]) {
        await verifier.connect(v).stakeVerifier({ value: ethers.parseEther("1") });
      }

      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();
      await campaign.submitEvidence(0, "ev0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));

      // Only ONE of three equal-stake verifiers votes. Quorum requires 90% of the
      // 3 ETH active stake (2.7 ETH), but only 1 ETH was cast, so quorum fails.
      await verifier.connect(verifier1).castVote(campaignAddress, 0, 1);
      const round = await verifier.getRound(campaignAddress, 0);
      await time.increaseTo(Number(round.voteDeadline) + 1);

      await campaign.resolveMilestone(0);

      // The single Approve vote is unanimous among those cast, yet the milestone is
      // REJECTED because quorum was not met: money does not move on thin participation.
      const milestone = await campaign.getMilestone(0);
      expect(milestone.state).to.equal(3n); // Rejected
      expect(await campaign.totalReleased()).to.equal(0n);
      expect(await campaign.refundableBalance()).to.equal(GOAL);
    });
  });

  describe("oracle adapter", () => {
    it("rejects an oracle vote from a non-oracle address", async () => {
      const signers = await ethers.getSigners();
      const [creator, backer, , verifier1, verifier2, verifier3, , , , treasury] = signers;

      const MockOracle = await ethers.getContractFactory("MockOracleAdapter");
      const oracle = await MockOracle.deploy(true, "test source");
      await oracle.waitForDeployment();

      const Verifier = await ethers.getContractFactory("MilestoneVerifier");
      const verifier = await Verifier.deploy(
        creator.address,
        treasury.address,
        await oracle.getAddress(),
        ethers.parseEther("1"),
        5_000,
        6_000,
        Number(2n * DAY),
        ethers.parseEther("0.5"),
        2_000,
        5_000
      );
      await verifier.waitForDeployment();

      const Reputation = await ethers.getContractFactory("ReputationRegistry");
      const reputation = await Reputation.deploy(creator.address);
      await reputation.waitForDeployment();

      const Factory = await ethers.getContractFactory("CampaignFactory");
      const factory = await Factory.deploy(
        await verifier.getAddress(),
        await reputation.getAddress(),
        creator.address,
        treasury.address
      );
      await factory.waitForDeployment();
      await verifier.connect(creator).setRegistrar(await factory.getAddress(), true);
      await reputation.connect(creator).setRegistrar(await factory.getAddress(), true);

      for (const v of [verifier1, verifier2, verifier3]) {
        await verifier.connect(v).stakeVerifier({ value: ethers.parseEther("1") });
      }

      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();
      await campaign.submitEvidence(0, "ev0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));

      await expect(
        verifier.connect(backer).submitOracleVote(campaignAddress, 0, 1)
      ).to.be.revertedWithCustomError(verifier, "NotAnOracle");
    });
  });

  describe("milestone index bounds", () => {
    it("rejects out-of-range milestone indices", async () => {
      const { factory, creator, backer } = await loadFixture(fixture);
      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();

      await expect(campaign.getMilestone(99)).to.be.revertedWithCustomError(
        campaign,
        "ZeroMilestoneIndex"
      );
      await expect(
        campaign.submitEvidence(99, "cid", ethers.keccak256(ethers.toUtf8Bytes("x")))
      ).to.be.revertedWithCustomError(campaign, "ZeroMilestoneIndex");
    });
  });
});
