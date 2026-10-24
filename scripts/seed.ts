/**
 * Seeds the local chain with a realistic campaign so the indexer and dApp have
 * something to display during development.
 *
 * Writes `deployments/hardhat.json`-independent state only to the chain; the backend
 * rebuilds its index from these events. Run with a local node:
 *   npx hardhat node                                    # terminal 1
 *   npx hardhat run scripts/seed.ts                      # terminal 2
 */
import { ethers } from "hardhat";

const DAY = 86_400n;

async function main() {
  const [deployer, treasury, creator, backer1, backer2, verifier1, verifier2, verifier3] =
    await ethers.getSigners();

  console.log("Seeding local chain...\n");

  // Load the deployment manifest produced by scripts/deploy.ts.
  const fs = await import("node:fs");
  const deploymentPath = "deployments/hardhat.json";
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(
      "deployments/hardhat.json not found. Run `npx hardhat run scripts/deploy.ts` first."
    );
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  // --- Stake verifiers ----------------------------------------------------
  const verifier = await ethers.getContractAt("MilestoneVerifier", deployment.contracts.MilestoneVerifier);
  for (const v of [verifier1, verifier2, verifier3]) {
    // Idempotent: re-running the seed against a chain where these accounts already
    // hold a verifier position must not revert.
    const already = await verifier.getVerifier(v.address);
    if (already.active) {
      console.log(`  verifier ${v.address} already staked, skipping`);
      continue;
    }
    const tx = await verifier.connect(v).stakeVerifier({ value: ethers.parseEther("2") });
    await tx.wait();
    console.log(`  staked verifier ${v.address}`);
  }

  // --- Create two campaigns -----------------------------------------------
  const factory = await ethers.getContractAt("CampaignFactory", deployment.contracts.CampaignFactory);

  /**
   * Reads the address of the most recently created campaign from the factory's public
   * array. Preferred over parsing the CampaignDeployed event: the event's argument list
   * differs from the tuple that the factory stores, and reading `campaignAt` is both
   * simpler and impossible to get subtly wrong.
   */
  const latestCampaign = async (): Promise<string> => {
    const count = await factory.campaignCount();
    if (count === 0n) throw new Error("no campaign was created");
    return factory.campaignAt(count - 1n);
  };

  const nowTs = (await ethers.provider.getBlock("latest"))!.timestamp;
  const baseParams = {
    goal: ethers.parseEther("100"),
    fundingDeadline: nowTs + Number(30n * DAY),
    trancheBps: [4_000, 3_500, 2_500],
    descriptionHashes: [
      ethers.keccak256(ethers.toUtf8Bytes("prototype built and tested")),
      ethers.keccak256(ethers.toUtf8Bytes("first 100 units produced")),
      ethers.keccak256(ethers.toUtf8Bytes("shipped to backers")),
    ],
    specificationCIDs: ["bafybeihd1a", "bafybeihd2b", "bafybeihd3c"],
    milestoneDeadlines: [nowTs + Number(40n * DAY), nowTs + Number(50n * DAY), nowTs + Number(60n * DAY)],
    treasury: ethers.ZeroAddress,
  };

  const deployed: string[] = [];

  // Campaign 1: fully funded.
  await (await factory.connect(creator).createCampaign(baseParams)).wait();
  const campaign1 = await latestCampaign();
  deployed.push(campaign1);

  const c1 = await ethers.getContractAt("Campaign", campaign1);
  await (await c1.connect(backer1).contribute({ value: ethers.parseEther("40") })).wait();
  await (await c1.connect(backer2).contribute({ value: ethers.parseEther("70") })).wait();
  console.log(`  campaign ${campaign1}: funded 110 ETH`);

  // Campaign 2: partially funded, still accepting.
  await (await factory.connect(creator).createCampaign({
    ...baseParams,
    goal: ethers.parseEther("50"),
    trancheBps: [5_000, 5_000],
    descriptionHashes: [
      ethers.keccak256(ethers.toUtf8Bytes("m0")),
      ethers.keccak256(ethers.toUtf8Bytes("m1")),
    ],
    specificationCIDs: ["bafybeix1", "bafybeix2"],
    // Must be strictly AFTER fundingDeadline; the constructor rejects equal-or-earlier.
    milestoneDeadlines: [
      nowTs + Number(45n * DAY),
      nowTs + Number(75n * DAY),
    ],
  })).wait();
  const campaign2 = await latestCampaign();
  deployed.push(campaign2);

  const c2 = await ethers.getContractAt("Campaign", campaign2);
  await (await c2.connect(backer1).contribute({ value: ethers.parseEther("12") })).wait();
  console.log(`  campaign ${campaign2}: funded 12 ETH (goal 50)`);

  // --- Verify milestone 0 of campaign 1 -----------------------------------
  // Evidence submission requires the funding window to close, which needs time travel.
  // On a live node that means waiting; for a seed we instead demonstrate the funding
  // path only and leave verification to the interactive demo script.
  console.log("\n  Note: milestone verification requires the funding deadline to pass.");
  console.log("  Use scripts/demo.ts for a full lifecycle walkthrough with time travel.");

  console.log("\nSeeded campaigns:");
  for (const address of deployed) console.log(`  ${address}`);
  void treasury;
  void verifier1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});