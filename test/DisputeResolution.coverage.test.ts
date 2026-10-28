import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

import { deploySystem } from "./helpers";

/**
 * Additional branch coverage for the dispute module that does not need a live campaign:
 * juror withdrawal accounting, admin controls, and unknown-dispute handling.
 * Campaign-coupled behaviour lives in DisputeResolution.test.ts.
 */
async function fixture() {
  const system = await deploySystem();
  const { creator, treasury, verifier, reputation } = system;

  const Dispute = await ethers.getContractFactory("DisputeResolution");
  const disputes = await Dispute.deploy(
    creator.address,
    treasury.address,
    await verifier.getAddress(),
    await reputation.getAddress()
  );
  await disputes.waitForDeployment();
  await reputation.connect(creator).setWriter(await disputes.getAddress(), true);

  return { ...system, disputes };
}

describe("DisputeResolution additional coverage", () => {
  describe("juror staking lifecycle", () => {
    it("allows a juror to withdraw part and all of their stake", async () => {
      const { disputes, backer } = await loadFixture(fixture);
      await disputes.connect(backer).stakeJuror({ value: ethers.parseEther("2") });

      await (await disputes.connect(backer).withdrawJurorStake(ethers.parseEther("0.5"))).wait();
      expect(await disputes.jurorWeight(backer.address)).to.equal(ethers.parseEther("1.5"));

      await (await disputes.connect(backer).withdrawJurorStake(ethers.parseEther("1.5"))).wait();
      expect(await disputes.jurorWeight(backer.address)).to.equal(0n);
    });

    it("rejects withdrawal from an unstaked address and over-withdrawal", async () => {
      const { disputes, backer, backer2 } = await loadFixture(fixture);
      await expect(
        disputes.connect(backer).withdrawJurorStake(ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(disputes, "NotAStakedJuror");

      await disputes.connect(backer2).stakeJuror({ value: ethers.parseEther("1") });
      await expect(
        disputes.connect(backer2).withdrawJurorStake(ethers.parseEther("5"))
      ).to.be.revertedWithCustomError(disputes, "InsufficientShare");
    });

    it("rejects a zero withdrawal", async () => {
      const { disputes, backer } = await loadFixture(fixture);
      await disputes.connect(backer).stakeJuror({ value: ethers.parseEther("1") });
      await expect(
        disputes.connect(backer).withdrawJurorStake(0)
      ).to.be.revertedWithCustomError(disputes, "InsufficientShare");
    });
  });

  describe("admin controls", () => {
    it("transfers admin and gates registrar changes", async () => {
      const { disputes, creator, backer } = await loadFixture(fixture);
      await expect(
        disputes.connect(backer).setRegistrar(backer.address, true)
      ).to.be.revertedWithCustomError(disputes, "NotAdmin");

      await (await disputes.connect(creator).transferAdmin(backer.address)).wait();
      expect(await disputes.admin()).to.equal(backer.address);

      await expect(
        disputes.connect(creator).transferAdmin(creator.address)
      ).to.be.revertedWithCustomError(disputes, "NotAdmin");
    });

    it("updates all dispute parameters", async () => {
      const { disputes, creator } = await loadFixture(fixture);
      await (
        await disputes
          .connect(creator)
          .setParameters(ethers.parseEther("0.1"), 4 * 86400, 2 * 86400, 10n ** 18n, 1_500)
      ).wait();

      expect(await disputes.disputeBond()).to.equal(ethers.parseEther("0.1"));
      expect(await disputes.votingWindow()).to.equal(4 * 86400);
      expect(await disputes.disputeCooldown()).to.equal(2 * 86400);
      expect(await disputes.weightCurveExponent()).to.equal(10n ** 18n);
      expect(await disputes.jurorSlashBps()).to.equal(1_500);
    });

    it("rejects judgeable and parameter changes from a non-admin", async () => {
      const { disputes, backer } = await loadFixture(fixture);
      await expect(
        disputes
          .connect(backer)
          .setJudgeable(ethers.getAddress("0x000000000000000000000000000000000000dEaD"), true)
      ).to.be.revertedWithCustomError(disputes, "NotAdmin");
      await expect(
        disputes.connect(backer).setParameters(0, 1, 1, 1, 1_000)
      ).to.be.revertedWithCustomError(disputes, "NotAdmin");
    });
  });

  describe("unknown disputes", () => {
    it("rejects settling an unknown dispute", async () => {
      const { disputes, backer } = await loadFixture(fixture);
      const key = ethers.keccak256(ethers.toUtf8Bytes("missing"));
      await expect(
        disputes.connect(backer).settleJuror(key)
      ).to.be.revertedWithCustomError(disputes, "NotOpen");
    });

    it("rejects resolving an unknown dispute", async () => {
      const { disputes, backer } = await loadFixture(fixture);
      const key = ethers.keccak256(ethers.toUtf8Bytes("missing"));
      await expect(
        disputes.connect(backer).resolve(key)
      ).to.be.revertedWithCustomError(disputes, "NotOpen");
    });
  });
});
