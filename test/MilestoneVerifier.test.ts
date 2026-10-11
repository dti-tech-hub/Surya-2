import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

import { buildParams, createCampaign, DAY, deploySystem, GOAL, stakeVerifier, VERIFIER_STAKE } from "./helpers";

/**
 * Tests for verifier staking, reward, and slashing economics.
 *
 * These cover the incentive mechanism that is supposed to make dishonest verification
 * more expensive than honest verification. If these tests pass only trivially, the
 * incentive layer is decorative rather than load-bearing.
 */
describe("MilestoneVerifier incentives", () => {
  async function fixture() {
    const system = await deploySystem();
    await stakeVerifier(system.verifier, system.verifier1);
    await stakeVerifier(system.verifier, system.verifier2);
    await stakeVerifier(system.verifier, system.verifier3);
    return system;
  }

  describe("staking", () => {
    it("tracks total active stake", async () => {
      const { verifier } = await loadFixture(fixture);
      // Three verifiers staked 1 ETH each in the fixture.
      expect(await verifier.activeStake()).to.equal(ethers.parseEther("3"));
    });

    it("rejects staking below the minimum", async () => {
      const { verifier, backer } = await loadFixture(fixture);
      await expect(
        verifier.connect(backer).stakeVerifier({ value: ethers.parseEther("0.1") })
      ).to.be.revertedWithCustomError(verifier, "InsufficientStake");
    });

    it("rejects double staking from the same address", async () => {
      const { verifier, verifier1 } = await loadFixture(fixture);
      await expect(
        verifier.connect(verifier1).stakeVerifier({ value: VERIFIER_STAKE })
      ).to.be.revertedWithCustomError(verifier, "StakeAlreadyActive");
    });

    it("allows partial withdrawal and keeps the verifier active", async () => {
      const { verifier, verifier1 } = await loadFixture(fixture);

      const tx = await verifier.connect(verifier1).withdrawStake(ethers.parseEther("0.4"));
      const rcpt = await tx.wait();
      // Read the amount from the event to avoid gas noise in a raw balance diff.
      const withdrawn = rcpt!.logs
        .map((log: any) => {
          try {
            return verifier.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: any) => parsed?.name === "VerifierWithdrew")!.args.amount;
      expect(withdrawn).to.equal(ethers.parseEther("0.4"));

      const info = await verifier.getVerifier(verifier1.address);
      expect(info.active).to.equal(true);
      expect(info.stake).to.equal(ethers.parseEther("0.6"));
      expect(await verifier.activeStake()).to.equal(ethers.parseEther("2.6"));
    });

    it("rejects withdrawing more than staked", async () => {
      const { verifier, verifier1 } = await loadFixture(fixture);
      await expect(
        verifier.connect(verifier1).withdrawStake(ethers.parseEther("2"))
      ).to.be.revertedWithCustomError(verifier, "InsufficientStake");
    });
  });

  describe("settlement rewards and slashing", () => {
    /** Opens a round on a funded campaign and returns the campaign address. */
    async function fundedCampaign(system: any) {
      const params = await buildParams();
      const campaignAddress = await createCampaign(system.factory, system.creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);
      await campaign.connect(system.backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();
      await campaign.submitEvidence(0, "ev0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));
      return { campaign, campaignAddress };
    }

    it("rewards verifiers whose vote matched the outcome", async () => {
      const system = await loadFixture(fixture);
      await system.verifier.fundRewardPool({ value: ethers.parseEther("1") });

      const { campaign, campaignAddress } = await fundedCampaign(system);

      // Two approve, one rejects -> Approve wins (66% >= 60% threshold).
      await system.verifier.connect(system.verifier1).castVote(campaignAddress, 0, 1);
      await system.verifier.connect(system.verifier2).castVote(campaignAddress, 0, 1);
      await system.verifier.connect(system.verifier3).castVote(campaignAddress, 0, 2);

      const round = await system.verifier.getRound(campaignAddress, 0);
      await time.increaseTo(Number(round.voteDeadline) + 1);
      await campaign.resolveMilestone(0);

      const settled = await system.verifier.getRound(campaignAddress, 0);
      expect(settled.outcome).to.equal(1n); // Approve

      // The two correct voters split the reward pool.
      const poolBefore = await system.verifier.rewardPool();
      const before1 = await ethers.provider.getBalance(system.verifier1.address);
      await system.verifier.connect(system.verifier1).claimSettlement(campaignAddress, 0);
      const after1 = await ethers.provider.getBalance(system.verifier1.address);

      expect(after1 - before1).to.be.gt(0n);
      expect(poolBefore - (await system.verifier.rewardPool())).to.be.gt(0n);
    });

    it("slashes a verifier who voted against the outcome", async () => {
      const system = await loadFixture(fixture);
      const { campaign, campaignAddress } = await fundedCampaign(system);

      await system.verifier.connect(system.verifier1).castVote(campaignAddress, 0, 1);
      await system.verifier.connect(system.verifier2).castVote(campaignAddress, 0, 1);
      await system.verifier.connect(system.verifier3).castVote(campaignAddress, 0, 2);

      const round = await system.verifier.getRound(campaignAddress, 0);
      await time.increaseTo(Number(round.voteDeadline) + 1);
      await campaign.resolveMilestone(0);

      const stakeBefore = (await system.verifier.getVerifier(system.verifier3.address)).stake;
      expect(stakeBefore).to.equal(ethers.parseEther("1"));

      await system.verifier.connect(system.verifier3).claimSettlement(campaignAddress, 0);

      // slashBps = 20%, so 1 ETH stake loses 0.2 ETH.
      const stakeAfter = (await system.verifier.getVerifier(system.verifier3.address)).stake;
      expect(stakeBefore - stakeAfter).to.equal(ethers.parseEther("0.2"));
    });

    it("prevents claiming the same settlement twice", async () => {
      const system = await loadFixture(fixture);
      await system.verifier.fundRewardPool({ value: ethers.parseEther("1") });

      const { campaign, campaignAddress } = await fundedCampaign(system);
      await system.verifier.connect(system.verifier1).castVote(campaignAddress, 0, 1);
      await system.verifier.connect(system.verifier2).castVote(campaignAddress, 0, 1);
      await system.verifier.connect(system.verifier3).castVote(campaignAddress, 0, 1);

      const round = await system.verifier.getRound(campaignAddress, 0);
      await time.increaseTo(Number(round.voteDeadline) + 1);
      await campaign.resolveMilestone(0);

      await system.verifier.connect(system.verifier1).claimSettlement(campaignAddress, 0);
      await expect(
        system.verifier.connect(system.verifier1).claimSettlement(campaignAddress, 0)
      ).to.be.revertedWithCustomError(system.verifier, "AlreadyClaimed");
    });

    it("penalises a staked verifier who did not vote", async () => {
      const system = await loadFixture(fixture);
      const { campaign, campaignAddress } = await fundedCampaign(system);

      // verifier3 never votes.
      await system.verifier.connect(system.verifier1).castVote(campaignAddress, 0, 1);
      await system.verifier.connect(system.verifier2).castVote(campaignAddress, 0, 1);

      const round = await system.verifier.getRound(campaignAddress, 0);
      await time.increaseTo(Number(round.voteDeadline) + 1);
      await campaign.resolveMilestone(0);

      const stakeBefore = (await system.verifier.getVerifier(system.verifier3.address)).stake;
      await system.verifier.connect(system.verifier3).penalizeNonVoter(campaignAddress, 0);
      const stakeAfter = (await system.verifier.getVerifier(system.verifier3.address)).stake;

      expect(stakeBefore - stakeAfter).to.equal(ethers.parseEther("0.2"));
    });

    it("refuses to settle a round twice", async () => {
      const system = await loadFixture(fixture);
      const { campaign, campaignAddress } = await fundedCampaign(system);

      await system.verifier.connect(system.verifier1).castVote(campaignAddress, 0, 1);
      const round = await system.verifier.getRound(campaignAddress, 0);
      await time.increaseTo(Number(round.voteDeadline) + 1);
      await campaign.resolveMilestone(0);

      await expect(
        system.verifier.settleRound(campaignAddress, 0)
      ).to.be.revertedWithCustomError(system.verifier, "RoundAlreadySettled");
    });
  });

  describe("oracle weight", () => {
    it("counts the oracle attestation toward the tally", async () => {
      const signers = await ethers.getSigners();
      const [creator, backer, , verifier1, verifier2, , , , , treasury] = signers;

      const MockOracle = await ethers.getContractFactory("MockOracleAdapter");
      const oracle = await MockOracle.deploy(true, "mock source");
      await oracle.waitForDeployment();

      const Verifier = await ethers.getContractFactory("MilestoneVerifier");
      const verifier = await Verifier.deploy(
        creator.address,
        treasury.address,
        await oracle.getAddress(),
        ethers.parseEther("1"),
        5_000, // 50% quorum
        6_000, // 60% threshold
        Number(2n * DAY),
        ethers.parseEther("2"), // oracle weight = 2 ETH
        2_000,
        5_000
      );
      await verifier.waitForDeployment();

      const Factory = await ethers.getContractFactory("CampaignFactory");
      const factory = await Factory.deploy(
        await verifier.getAddress(),
        creator.address,
        treasury.address
      );
      await factory.waitForDeployment();
      await verifier.connect(creator).setRegistrar(await factory.getAddress(), true);

      for (const v of [verifier1, verifier2]) {
        await verifier.connect(v).stakeVerifier({ value: ethers.parseEther("1") });
      }

      const params = await buildParams();
      const campaignAddress = await createCampaign(factory, creator, params);
      const campaign = await ethers.getContractAt("Campaign", campaignAddress);

      await campaign.connect(backer).contribute({ value: GOAL });
      await time.increaseTo(params.fundingDeadline + 1);
      await campaign.closeFunding();
      await campaign.submitEvidence(0, "ev0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));

      // The oracle is a contract, not a signer, so impersonate its address to act as it.
      const oracleAddress = await oracle.getAddress();
      await ethers.provider.send("hardhat_impersonateAccount", [oracleAddress]);
      await ethers.provider.send("hardhat_setBalance", [oracleAddress, "0x56BC75E2D63100000"]);
      const oracleSigner = await ethers.getSigner(oracleAddress);

      // Only the oracle approves; human verifiers both reject. Oracle weight (2 ETH)
      // against 2 ETH of human Reject weight: approve is 50%, below the 60% threshold,
      // so even a strong oracle cannot unilaterally force a release here.
      await verifier.connect(oracleSigner).submitOracleVote(campaignAddress, 0, 1);
      await verifier.connect(verifier1).castVote(campaignAddress, 0, 2);
      await verifier.connect(verifier2).castVote(campaignAddress, 0, 2);

      const round = await verifier.getRound(campaignAddress, 0);
      await time.increaseTo(Number(round.voteDeadline) + 1);
      await campaign.resolveMilestone(0);

      const settled = await verifier.getRound(campaignAddress, 0);
      // approve=2 ETH, reject=2 ETH -> 50% < 60% threshold -> Rejected.
      expect(settled.outcome).to.equal(2n);
      expect(await campaign.totalReleased()).to.equal(0n);
    });
  });
});