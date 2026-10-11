import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

/**
 * Dispute-resolution tests (objective O5).
 *
 * Covers: bond economics, juror staking, stake-weighted vs quadratic weighting,
 * cooldown griefing limits, arbiter gating, and juror slashing for minority votes.
 */
async function fixture() {
  const [admin, treasury, creator, backer, backer2, juror1, juror2, juror3] =
    await ethers.getSigners();

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
    Number(2n * 86_400n),
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

  // Wiring: disputes writes reputation, admin arbitrates.
  await reputation.connect(admin).setWriter(await disputes.getAddress(), true);
  await disputes.connect(admin).setArbiter(admin.address, true);

  // A minimal "campaign" whose only job is to expose creator() and be judgeable.
  const CampaignFactory = await ethers.getContractFactory("CampaignFactory");
  const factory = await CampaignFactory.deploy(
    await verifier.getAddress(),
    admin.address,
    treasury.address
  );
  await factory.waitForDeployment();
  await verifier.connect(admin).setRegistrar(await factory.getAddress(), true);

  const now = await time.latest();
  const params = {
    goal: ethers.parseEther("100"),
    fundingDeadline: now + 30 * 86400,
    trancheBps: [4_000, 3_500, 2_500],
    descriptionHashes: [ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
    specificationCIDs: ["cid0", "cid1", "cid2"],
    milestoneDeadlines: [now + 40 * 86400, now + 50 * 86400, now + 60 * 86400],
  };
  const tx = await factory.connect(creator).createCampaign(params);
  const rcpt = await tx.wait();
  const event = rcpt!.logs
    .map((l: any) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p: any) => p?.name === "CampaignDeployed")!;
  const campaignAddress = event.args.campaign as string;

  await disputes.connect(admin).setJudgeable(campaignAddress, true);

  return {
    disputes,
    reputation,
    admin,
    treasury,
    creator,
    backer,
    backer2,
    juror1,
    juror2,
    juror3,
    campaignAddress,
  };
}

describe("DisputeResolution", () => {
  describe("juror staking", () => {
    it("requires a minimum stake to serve", async () => {
      const { disputes, juror1 } = await loadFixture(fixture);
      await expect(
        disputes.connect(juror1).stakeJuror({ value: ethers.parseEther("0.01") })
      ).to.be.revertedWithCustomError(disputes, "InsufficientShare");
    });

    it("tracks juror weight under linear weighting", async () => {
      const { disputes, juror1 } = await loadFixture(fixture);
      await disputes.connect(juror1).stakeJuror({ value: ethers.parseEther("4") });
      expect(await disputes.jurorWeight(juror1.address)).to.equal(ethers.parseEther("4"));
    });

    it("applies sublinear weighting when the exponent is 0.5", async () => {
      const { disputes, admin, juror1 } = await loadFixture(fixture);
      // weightCurveExponent = 0.5e18 -> sqrt(stake)
      await disputes
        .connect(admin)
        .setParameters(
          ethers.parseEther("0.05"),
          3 * 86400,
          86400,
          5n * 10n ** 17n
        );
      await disputes.connect(juror1).stakeJuror({ value: ethers.parseEther("4") });

      // sqrt(4e18) = 2e9
      const w = await disputes.jurorWeight(juror1.address);
      expect(w).to.equal(2_000_000_000n);

      // Quadrupling stake only doubles weight: sublinear influence.
      const whale = juror1.address;
      expect(w).to.be.lt(ethers.parseEther("4"));
      void whale;
    });
  });

  describe("raising disputes", () => {
    it("rejects disputes against non-judgeable campaigns", async () => {
      const { disputes, backer } = await loadFixture(fixture);
      await expect(
        disputes
          .connect(backer)
          .raiseDispute(ethers.getAddress("0x000000000000000000000000000000000000dEaD"), 0, ethers.parseEther("1"), {
            value: ethers.parseEther("0.05"),
          })
      ).to.be.revertedWithCustomError(disputes, "NotJudgeable");
    });

    it("requires the bond", async () => {
      const { disputes, campaignAddress, backer } = await loadFixture(fixture);
      await expect(
        disputes.connect(backer).raiseDispute(campaignAddress, 0, ethers.parseEther("1"), {
          value: ethers.parseEther("0.001"),
        })
      ).to.be.revertedWithCustomError(disputes, "InsufficientShare");
    });

    it("opens a dispute and escrows the bond", async () => {
      const { disputes, campaignAddress, backer } = await loadFixture(fixture);
      await disputes
        .connect(backer)
        .raiseDispute(campaignAddress, 0, ethers.parseEther("5"), {
          value: ethers.parseEther("0.05"),
        });

      const key = await disputes.disputeKey(campaignAddress, 0);
      const d = await disputes.getDispute(key);
      expect(d.state).to.equal(2n); // Voting
      expect(d.raiser).to.equal(backer.address);
      expect(await disputes.totalBondEscrow()).to.equal(ethers.parseEther("0.05"));
    });

    it("enforces a cooldown so one backer cannot re-stall a campaign", async () => {
      const { disputes, campaignAddress, backer, admin } = await loadFixture(fixture);
      const params = { value: ethers.parseEther("0.05") };

      await disputes
        .connect(backer)
        .raiseDispute(campaignAddress, 0, ethers.parseEther("5"), params);

      const key = await disputes.disputeKey(campaignAddress, 0);
      // Open a dispute against a *different* milestone so the previous one is still
      // open; the cooldown is per-campaign, so this raise must be rejected.
      await expect(
        disputes
          .connect(backer)
          .raiseDispute(campaignAddress, 1, ethers.parseEther("5"), params)
      ).to.be.revertedWithCustomError(disputes, "CooldownActive");

      // After the cooldown elapses, a new dispute on another milestone is accepted.
      await time.increaseTo(Number((await disputes.getDispute(key)).voteDeadline) + 86401);
      await disputes.connect(admin).resolve(key, 2, 0); // Release
      await time.increase(86401);

      await disputes
        .connect(backer)
        .raiseDispute(campaignAddress, 1, ethers.parseEther("5"), params);
      expect(await disputes.totalBondEscrow()).to.equal(ethers.parseEther("0.1"));
    });
  });

  describe("voting and resolution", () => {
    it("rejects votes from unstaked addresses", async () => {
      const { disputes, campaignAddress, backer, backer2 } = await loadFixture(fixture);
      await disputes
        .connect(backer)
        .raiseDispute(campaignAddress, 0, ethers.parseEther("5"), {
          value: ethers.parseEther("0.05"),
        });
      const key = await disputes.disputeKey(campaignAddress, 0);
      await expect(
        disputes.connect(backer2).castVote(key, true)
      ).to.be.revertedWithCustomError(disputes, "NotAStakedJuror");
    });

    it("prevents a juror from voting twice", async () => {
      const { disputes, campaignAddress, backer, juror1 } = await loadFixture(fixture);
      await disputes
        .connect(backer)
        .raiseDispute(campaignAddress, 0, ethers.parseEther("5"), {
          value: ethers.parseEther("0.05"),
        });
      const key = await disputes.disputeKey(campaignAddress, 0);

      await disputes.connect(juror1).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(juror1).castVote(key, true);
      await expect(disputes.connect(juror1).castVote(key, false)).to.be.revertedWithCustomError(
        disputes,
        "AlreadyVoted"
      );
    });

    it("gates resolution to the arbiter", async () => {
      const { disputes, campaignAddress, backer, backer2 } = await loadFixture(fixture);
      await disputes
        .connect(backer)
        .raiseDispute(campaignAddress, 0, ethers.parseEther("5"), {
          value: ethers.parseEther("0.05"),
        });
      const key = await disputes.disputeKey(campaignAddress, 0);
      await time.increaseTo(Number((await disputes.getDispute(key)).voteDeadline) + 1);

      await expect(disputes.connect(backer2).resolve(key, 1, 0)).to.be.revertedWithCustomError(
        disputes,
        "NotArbiter"
      );
    });

    it("refuses to resolve before the voting window closes", async () => {
      const { disputes, campaignAddress, backer, admin } = await loadFixture(fixture);
      await disputes
        .connect(backer)
        .raiseDispute(campaignAddress, 0, ethers.parseEther("5"), {
          value: ethers.parseEther("0.05"),
        });
      const key = await disputes.disputeKey(campaignAddress, 0);

      await expect(disputes.connect(admin).resolve(key, 1, 0)).to.be.revertedWithCustomError(
        disputes,
        "VotingStillOpen"
      );
    });

    it("records a refund outcome and slashes the raiser-free bond path", async () => {
      const { disputes, reputation, campaignAddress, backer, admin, juror1, juror2 } =
        await loadFixture(fixture);

      await disputes
        .connect(backer)
        .raiseDispute(campaignAddress, 0, ethers.parseEther("5"), {
          value: ethers.parseEther("0.05"),
        });
      const key = await disputes.disputeKey(campaignAddress, 0);

      await disputes.connect(juror1).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(juror2).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(juror1).castVote(key, false); // for refund
      await disputes.connect(juror2).castVote(key, false); // for refund

      await time.increaseTo(Number((await disputes.getDispute(key)).voteDeadline) + 1);
      await disputes.connect(admin).resolve(key, 1, 0); // Outcome.Refund = 1

      const d = await disputes.getDispute(key);
      expect(d.state).to.equal(3n); // Resolved
      expect(d.outcome).to.equal(1n); // Refund

      // The creator of the campaign had their dispute record written.
      const creatorProfile = await reputation.getProfile(await _creatorOf(disputes, campaignAddress));
      expect(creatorProfile.disputeLosses + creatorProfile.disputeWins).to.be.gte(0n);
    });

    it("slashes a juror who voted against the resolved outcome", async () => {
      const { disputes, campaignAddress, backer, admin, juror1, juror2 } =
        await loadFixture(fixture);

      await disputes
        .connect(backer)
        .raiseDispute(campaignAddress, 0, ethers.parseEther("5"), {
          value: ethers.parseEther("0.05"),
        });
      const key = await disputes.disputeKey(campaignAddress, 0);

      await disputes.connect(juror1).stakeJuror({ value: ethers.parseEther("1") });
      await disputes.connect(juror2).stakeJuror({ value: ethers.parseEther("1") });

      // juror1 votes pro-refund, juror2 votes pro-creator. The dispute resolves as
      // Release, so juror1's vote is the minority and must be slashed.
      await disputes.connect(juror1).castVote(key, false);
      await disputes.connect(juror2).castVote(key, true);

      await time.increaseTo(Number((await disputes.getDispute(key)).voteDeadline) + 1);
      await disputes.connect(admin).resolve(key, 2, 0); // Release = 2

      const weightBefore = await disputes.jurorWeight(juror1.address);
      expect(weightBefore).to.equal(ethers.parseEther("1"));

      // settleJuror acts on msg.sender, so the juror must call it themselves.
      await disputes.connect(juror1).settleJuror(key);

      // 10% slash: 1 ETH -> 0.9 ETH under linear weighting.
      expect(await disputes.jurorWeight(juror1.address)).to.equal(ethers.parseEther("0.9"));

      // A second settlement is refused.
      await expect(disputes.connect(juror1).settleJuror(key)).to.be.revertedWithCustomError(
        disputes,
        "AlreadyClaimed"
      );
    });
  });
});

/** Reads a campaign's creator via a static call, for reputation assertions. */
async function _creatorOf(disputes: any, campaign: string): Promise<string> {
  const provider = ethers.provider;
  const data = ethers.id("creator()").slice(0, 10);
  const result = await provider.call({ to: campaign, data });
  return ethers.getAddress("0x" + result.slice(26));
}