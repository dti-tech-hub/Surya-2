import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

import { buildParams, deploySystem, stakeVerifier } from "./helpers";

/**
 * CampaignFactory coverage: admin paths, batching, and pagination that the lifecycle
 * suite does not exercise.
 */
async function fixture() {
  const system = await deploySystem();
  await stakeVerifier(system.verifier, system.verifier1);
  return system;
}

describe("CampaignFactory coverage", () => {
  it("rejects a mismatched milestone array length", async () => {
    const { factory, creator } = await loadFixture(fixture);
    const params = await buildParams();
    const bad = { ...params, specificationCIDs: ["only-one"] };
    await expect(
      factory.connect(creator).createCampaign(bad)
    ).to.be.revertedWithCustomError(factory, "MilestoneArrayLengthMismatch");
  });

  it("rejects zero milestones", async () => {
    const { factory, creator } = await loadFixture(fixture);
    const params = await buildParams();
    const bad = {
      ...params,
      trancheBps: [],
      descriptionHashes: [],
      specificationCIDs: [],
      milestoneDeadlines: [],
    };
    await expect(
      factory.connect(creator).createCampaign(bad)
    ).to.be.revertedWithCustomError(factory, "MilestoneArrayLengthMismatch");
  });

  it("rejects transferAdmin from a non-admin", async () => {
    const { factory, backer } = await loadFixture(fixture);
    await expect(
      factory.connect(backer).transferAdmin(backer.address)
    ).to.be.revertedWithCustomError(factory, "NotAdmin");
  });

  it("transfers admin successfully and locks out the old admin", async () => {
    const { factory, creator, backer } = await loadFixture(fixture);
    await factory.connect(creator).transferAdmin(backer.address);
    expect(await factory.admin()).to.equal(backer.address);

    await expect(
      factory.connect(creator).transferAdmin(creator.address)
    ).to.be.revertedWithCustomError(factory, "NotAdmin");
  });

  it("rejects transferAdmin to the zero address", async () => {
    const { factory, creator } = await loadFixture(fixture);
    await expect(
      factory.connect(creator).transferAdmin(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  it("rejects an out-of-range campaignAt index", async () => {
    const { factory } = await loadFixture(fixture);
    await expect(factory.campaignAt(0)).to.be.revertedWithCustomError(
      factory,
      "MilestoneArrayLengthMismatch"
    );
  });

it("tracks multiple campaigns and exposes them by index", async () => {
      const { factory, creator } = await loadFixture(fixture);
      await factory.connect(creator).createCampaign(await buildParams());
      await factory.connect(creator).createCampaign(await buildParams());

      expect(await factory.campaignCount()).to.equal(2n);
      const first = await factory.campaignAt(0);
      const second = await factory.campaignAt(1);
      expect(first).to.not.equal(second);

      // Both are registered as this factory's deployments. The `campaigns` mapping has
      // no public getter because CampaignInfo contains a nested mapping, which ethers
      // cannot auto-generate; isCampaign covers the registration check.
      expect(await factory.isCampaign(first)).to.equal(true);
      expect(await factory.isCampaign(second)).to.equal(true);

      // Each deployed campaign reports the creator through its own immutable field.
      const c1 = await ethers.getContractAt("Campaign", first);
      const c2 = await ethers.getContractAt("Campaign", second);
      expect(await c1.creator()).to.equal(creator.address);
      expect(await c2.creator()).to.equal(creator.address);
    });
});