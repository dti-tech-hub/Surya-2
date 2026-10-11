import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

import { buildParams, createCampaign, deploySystem, stakeVerifier } from "./helpers";

/**
 * Coverage for DisputeResolution paths not exercised by the main dispute suite:
 * bond settlement (return vs slash), juror withdrawal, challenge bonds, oracle-authorised
 * resolution, and partial outcomes.
 */
async function fixture() {
  const system = await deploySystem();
  await stakeVerifier(system.verifier, system.verifier1);
  await stakeVerifier(system.verifier, system.verifier2);

  const { disputes, factory, creator } = system;
  // disputes is not part of deploySystem, so build the full stack here.
  const [admin, treasury, , backer, , juror1, juror2, , , backerB] =
    await ethers.getSigners();

  const Reputation = await ethers.getContractFactory("ReputationRegistry");
  const reputation = await Reputation.deploy(admin.address);
  await reputation.waitForDeployment();

  const Dispute = await ethers.getContractFactory("DisputeResolution");
  const disputeContract = await Dispute.deploy(
    admin.address,
    treasury.address,
    await system.verifier.getAddress(),
    await reputation.getAddress()
  );
  await disputeContract.waitForDeployment();
  await reputation.connect(admin).setWriter(await disputeContract.getAddress(), true);
  await disputeContract.connect(admin).setArbiter(admin.address, true);

  const campaignAddress = await createCampaign(factory, creator, await buildParams());
  await disputeContract.connect(admin).setJudgeable(campaignAddress, true);

  return {
    disputes: disputeContract,
    reputation,
    factory,
    campaignAddress,
    admin,
    treasury,
    backer,
    backerB,
    juror1,
    juror2,
    creator,
  };
}

/** Raises a dispute with the given bond and returns its key. */
async function raise(f: any, bond: bigint, milestone = 0) {
  const tx = await f.disputes
    .connect(f.backer)
    .raiseDispute(f.campaignAddress, milestone, ethers.parseEther("5"), { value: bond });
  await tx.wait();
  return f.disputes.disputeKey(f.campaignAddress, milestone);
}

/** Advances past the dispute voting window. */
async function expireVoting(f: any, key: string) {
  await time.increaseTo(Number((await f.disputes.getDispute(key)).voteDeadline) + 1);
}

describe("DisputeResolution additional coverage", () => {
  describe("juror staking lifecycle", () => {
    it("allows a juror to withdraw part and all of their stake", async () => {
      const f = await loadFixture(fixture);
      await f.disputes.connect(f.juror1).stakeJuror({ value: ethers.parseEther("2") });

      const partial = await f.disputes.connect(f.juror1).withdrawJurorStake(
        ethers.parseEther("0.5")
      );
      await partial.wait();
      expect(await f.disputes.jurorWeight(f.juror1.address)).to.equal(
        ethers.parseEther("1.5")
      );

      const rest = await f.disputes.connect(f.juror1).withdrawJurorStake(
        ethers.parseEther("1.5")
      );
      await rest.wait();
      expect(await f.disputes.jurorWeight(f.juror1.address)).to.equal(0n);
    });

    it("rejects withdrawal from an unstaked address and over-withdrawal", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.disputes.connect(f.juror1).withdrawJurorStake(ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(f.disputes, "NotAStakedJuror");

      await f.disputes.connect(f.juror2).stakeJuror({ value: ethers.parseEther("1") });
      await expect(
        f.disputes.connect(f.juror2).withdrawJurorStake(ethers.parseEther("5"))
      ).to.be.revertedWithCustomError(f.disputes, "InsufficientShare");
    });

    it("rejects a zero withdrawal", async () => {
      const f = await loadFixture(fixture);
      await f.disputes.connect(f.juror1).stakeJuror({ value: ethers.parseEther("1") });
      await expect(
        f.disputes.connect(f.juror1).withdrawJurorStake(0)
      ).to.be.revertedWithCustomError(f.disputes, "InsufficientShare");
    });
  });

  describe("bond settlement", () => {
    it("returns the raiser's bond when the dispute resolves for a refund", async () => {
      const f = await loadFixture(fixture);
      const bond = await f.disputes.disputeBond();
      const key = await raise(f, bond);

      await expireVoting(f, key);
      await f.disputes.connect(f.admin).resolve(key, 1, 0); // Refund -> raiser prevailed

      const raiserBefore = await ethers.provider.getBalance(f.backer.address);
      await f.disputes.connect(f.admin).settleBond(key);
      const raiserAfter = await ethers.provider.getBalance(f.backer.address);

      // Gas is paid by the arbiter here, so the raiser receives the full bond.
      expect(raiserAfter - raiserBefore).to.equal(bond);
    });

    it("slashes the raiser's bond to the treasury when the dispute resolves for the creator", async () => {
      const f = await loadFixture(fixture);
      const bond = await f.disputes.disputeBond();
      const key = await raise(f, bond);

      await expireVoting(f, key);
      await f.disputes.connect(f.admin).resolve(key, 2, 0); // Release -> raiser lost

      const treasuryBefore = await ethers.provider.getBalance(f.treasury.address);
      await f.disputes.connect(f.admin).settleBond(key);
      const treasuryAfter = await ethers.provider.getBalance(f.treasury.address);

      expect(treasuryAfter - treasuryBefore).to.equal(bond);
    });

    it("refuses to settle a bond twice", async () => {
      const f = await loadFixture(fixture);
      const bond = await f.disputes.disputeBond();
      const key = await raise(f, bond);
      await expireVoting(f, key);
      await f.disputes.connect(f.admin).resolve(key, 1, 0);
      await f.disputes.connect(f.admin).settleBond(key);

      await expect(
        f.disputes.connect(f.admin).settleBond(key)
      ).to.be.revertedWithCustomError(f.disputes, "AlreadyClaimed");
    });
  });

  describe("challenge bonds", () => {
    it("accepts a challenge bond from a third party", async () => {
      const f = await loadFixture(fixture);
      const bond = await f.disputes.disputeBond();
      const key = await raise(f, bond);

      const escrowBefore = await f.disputes.totalBondEscrow();
      await f.disputes.connect(f.backerB).challengeDispute(f.campaignAddress, 0, { value: bond });
      const escrowAfter = await f.disputes.totalBondEscrow();

      expect(escrowAfter - escrowBefore).to.equal(bond);

      const d = await f.disputes.getDispute(key);
      expect(d.bondEscrowed).to.equal(bond * 2n);
    });

    it("rejects an under-funded challenge and challenges on a non-voting dispute", async () => {
      const f = await loadFixture(fixture);
      const bond = await f.disputes.disputeBond();
      const key = await raise(f, bond);

      await expect(
        f.disputes.connect(f.backerB).challengeDispute(f.campaignAddress, 0, { value: 1n })
      ).to.be.revertedWithCustomError(f.disputes, "InsufficientShare");

      // No dispute on milestone 1 -> NotOpen.
      await expect(
        f.disputes.connect(f.backerB).challengeDispute(f.campaignAddress, 1, { value: bond })
      ).to.be.revertedWithCustomError(f.disputes, "NotOpen");
    });
  });

  describe("arbiter gating and outcomes", () => {
    it("rejects arbiter-role changes from a non-admin", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.disputes.connect(f.backer).setArbiter(f.backer.address, true)
      ).to.be.revertedWithCustomError(f.disputes, "NotAdmin");
    });

    it("rejects judgeable changes from a non-admin", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.disputes.connect(f.backer).setJudgeable(f.campaignAddress, false)
      ).to.be.revertedWithCustomError(f.disputes, "NotAdmin");
    });

    it("rejects parameter changes from a non-admin and bad exponents", async () => {
      const f = await loadFixture(fixture);
      await expect(
        f.disputes.connect(f.backer).setParameters(0, 1, 1, 1)
      ).to.be.revertedWithCustomError(f.disputes, "NotAdmin");

      // exponent must be <= 1e18
      await expect(
        f.disputes.connect(f.admin).setParameters(0, 1, 1, 2n * 10n ** 18n)
      ).to.be.revertedWithCustomError(f.disputes, "InvalidBps");
    });

    it("rejects an out-of-range partial split", async () => {
      const f = await loadFixture(fixture);
      const bond = await f.disputes.disputeBond();
      const key = await raise(f, bond);
      await expireVoting(f, key);
      // Outcome.Partial with partialBps > 10000
      await expect(
        f.disputes.connect(f.admin).resolve(key, 3, 10001)
      ).to.be.revertedWithCustomError(f.disputes, "InvalidBps");
    });

    it("settles a partial outcome with a valid split", async () => {
      const f = await loadFixture(fixture);
      const bond = await f.disputes.disputeBond();
      const key = await raise(f, bond);
      await f.disputes.connect(f.juror1).stakeJuror({ value: ethers.parseEther("1") });
      await f.disputes.connect(f.juror1).castVote(key, true);

      await expireVoting(f, key);
      await f.disputes.connect(f.admin).resolve(key, 3, 6000); // Partial, creator 60%

      const d = await f.disputes.getDispute(key);
      expect(d.outcome).to.equal(3n); // Partial
      expect(d.partialBps).to.equal(6000);
    });

    it("rejects settleJuror and settleBond on a still-voting dispute", async () => {
      const f = await loadFixture(fixture);
      const bond = await f.disputes.disputeBond();
      const key = await raise(f, bond);

      await expect(
        f.disputes.connect(f.juror1).settleJuror(key)
      ).to.be.revertedWithCustomError(f.disputes, "NotOpen");
      await expect(
        f.disputes.connect(f.admin).settleBond(key)
      ).to.be.revertedWithCustomError(f.disputes, "NotOpen");
    });

    it("settleJuror is a no-op for a non-voter", async () => {
      const f = await loadFixture(fixture);
      const bond = await f.disputes.disputeBond();
      const key = await raise(f, bond);
      await expireVoting(f, key);
      await f.disputes.connect(f.admin).resolve(key, 1, 0);

      // juror1 never voted; settleJuror should simply return, not revert or pay.
      await f.disputes.connect(f.juror1).settleJuror(key);
      // The reward pool should be untouched (no bond was pulled for a non-voter).
      expect(await f.disputes.jurorWeight(f.juror1.address)).to.equal(0n);
    });
  });
});