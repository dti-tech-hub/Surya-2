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
 * Regression tests for defects fixed after the initial audit.
 *
 * Each test would fail against the previous revision:
 *   F1  Overfunded campaigns stranded the surplus forever on Completed.
 *   F2  Dispute outcomes never touched campaign escrow.
 *   F3  Campaigns were not wired into ReputationRegistry, so delivery/completion
 *       counters stayed empty no matter how many campaigns finished.
 *   F4  A verifier could vote and immediately withdraw, escaping the minority slash.
 *   F5  Non-voters could only penalise themselves, so the penalty was never enforced.
 */
describe("Integration fixes", () => {
  async function fixture() {
    const system = await deploySystem();
    await stakeVerifier(system.verifier, system.verifier1);
    await stakeVerifier(system.verifier, system.verifier2);
    await stakeVerifier(system.verifier, system.verifier3);
    return system;
  }

  it("F1: releases the full raise, including overfunding surplus, on completion", async () => {
    const { factory, verifier, creator, backer, backer2, verifier1, verifier2, verifier3 } =
      await loadFixture(fixture);
    const params = await buildParams();
    const campaignAddress = await createCampaign(factory, creator, params);
    const campaign = await ethers.getContractAt("Campaign", campaignAddress);

    // Raise 150 ETH against a 100 ETH goal.
    await campaign.connect(backer).contribute({ value: ethers.parseEther("100") });
    await campaign.connect(backer2).contribute({ value: ethers.parseEther("50") });
    await time.increaseTo(params.fundingDeadline + 1);
    await campaign.closeFunding();

    const verifiers = [verifier1, verifier2, verifier3];
    for (let i = 0; i < 3; i++) {
      await campaign
        .connect(creator)
        .submitEvidence(i, `cid${i}`, ethers.keccak256(ethers.toUtf8Bytes(`ev${i}`)));
      await resolveMilestone(campaign, verifier, i, verifiers, 3);
    }

    // Old code released only goal * 100% = 100 ETH and left 50 ETH locked forever.
    expect(await campaign.state()).to.equal(3n); // Completed
    expect(await campaign.totalReleased()).to.equal(ethers.parseEther("150"));
    expect(await campaign.refundableBalance()).to.equal(0n);

    await campaign.connect(creator).claimCreatorBalance();
    expect(await campaign.escrowBalance()).to.equal(0n);
  });

  it("F2: only the factory can bind a dispute module and only it can resolve one", async () => {
    const { factory, creator, backer } = await loadFixture(fixture);
    const campaignAddress = await createCampaign(factory, creator, await buildParams());
    const campaign = await ethers.getContractAt("Campaign", campaignAddress);

    const fakeResolver = backer.address;
    await expect(
      campaign.connect(creator).setDisputeModule(fakeResolver)
    ).to.be.revertedWithCustomError(campaign, "NotFactory");

    // Even the creator cannot push a fake verdict into escrow.
    await expect(
      campaign.connect(creator).resolveDispute(0, 2, 0)
    ).to.be.revertedWithCustomError(campaign, "NotDisputeModule");
  });

  it("F3: records delivery and campaign completion in the reputation registry", async () => {
    const { factory, verifier, reputation, creator, backer, verifier1, verifier2, verifier3 } =
      await loadFixture(fixture);
    const params = await buildParams();
    const campaignAddress = await createCampaign(factory, creator, params);
    const campaign = await ethers.getContractAt("Campaign", campaignAddress);

    await campaign.connect(backer).contribute({ value: GOAL });
    await time.increaseTo(params.fundingDeadline + 1);
    await campaign.closeFunding();

    const verifiers = [verifier1, verifier2, verifier3];
    for (let i = 0; i < 3; i++) {
      await campaign
        .connect(creator)
        .submitEvidence(i, `cid${i}`, ethers.keccak256(ethers.toUtf8Bytes(`ev${i}`)));
      await resolveMilestone(campaign, verifier, i, verifiers, 3);
    }

    const profile = await reputation.getProfile(creator.address);
    expect(profile.milestonesTotal).to.equal(3n);
    expect(profile.milestonesOnTime).to.equal(3n);
    expect(profile.campaignsCompleted).to.equal(1n);
    expect(profile.campaignsFailed).to.equal(0n);
  });

  it("F3b: records a failed campaign exactly once", async () => {
    const { factory, reputation, creator, backer } = await loadFixture(fixture);
    const params = await buildParams();
    const campaignAddress = await createCampaign(factory, creator, params);
    const campaign = await ethers.getContractAt("Campaign", campaignAddress);

    await campaign.connect(backer).contribute({ value: GOAL / 2n });
    await time.increaseTo(params.fundingDeadline + 1);
    await campaign.closeFunding();

    const profile = await reputation.getProfile(creator.address);
    expect(profile.campaignsFailed).to.equal(1n);
    expect(profile.campaignsCompleted).to.equal(0n);
  });

  it("F4: locks verifier stake while a round is live, so a voter cannot escape slashing", async () => {
    const { factory, verifier, creator, backer, verifier1, verifier2, verifier3 } =
      await loadFixture(fixture);
    const params = await buildParams();
    const campaignAddress = await createCampaign(factory, creator, params);
    const campaign = await ethers.getContractAt("Campaign", campaignAddress);

    await campaign.connect(backer).contribute({ value: GOAL });
    await time.increaseTo(params.fundingDeadline + 1);
    await campaign.closeFunding();
    await campaign.submitEvidence(0, "cid0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));

    await verifier.connect(verifier1).castVote(campaignAddress, 0, 1);
    await verifier.connect(verifier2).castVote(campaignAddress, 0, 1);
    await verifier.connect(verifier3).castVote(campaignAddress, 0, 2);

    await expect(
      verifier.connect(verifier3).withdrawStake(ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(verifier, "StakeLocked");

    const round = await verifier.getRound(campaignAddress, 0);
    await time.increaseTo(Number(round.voteDeadline) + 1);
    await campaign.resolveMilestone(0);

    // The dissent is slashed against the vote-time stake, not bypassed by withdrawal.
    await verifier.connect(verifier3).claimSettlement(campaignAddress, 0);
    expect((await verifier.getVerifier(verifier3.address)).stake).to.equal(
      ethers.parseEther("0.8")
    );
  });

  it("F5: lets a third party penalise a non-voter", async () => {
    const { factory, verifier, creator, backer, verifier1, verifier2, verifier3 } =
      await loadFixture(fixture);
    const params = await buildParams();
    const campaignAddress = await createCampaign(factory, creator, params);
    const campaign = await ethers.getContractAt("Campaign", campaignAddress);

    await campaign.connect(backer).contribute({ value: GOAL });
    await time.increaseTo(params.fundingDeadline + 1);
    await campaign.closeFunding();
    await campaign.submitEvidence(0, "cid0", ethers.keccak256(ethers.toUtf8Bytes("ev0")));

    await verifier.connect(verifier1).castVote(campaignAddress, 0, 1);
    await verifier.connect(verifier2).castVote(campaignAddress, 0, 1);
    // verifier3 abstains.
    const round = await verifier.getRound(campaignAddress, 0);
    await time.increaseTo(Number(round.voteDeadline) + 1);
    await campaign.resolveMilestone(0);

    const before = (await verifier.getVerifier(verifier3.address)).stake;
    await verifier
      .connect(backer)
      ["penalizeNonVoter(address,uint256,address)"](campaignAddress, 0, verifier3.address);
    const after = (await verifier.getVerifier(verifier3.address)).stake;

    // slashBps = 20% of 1 ETH.
    expect(before - after).to.equal(ethers.parseEther("0.2"));
  });
});
