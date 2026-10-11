/**
 * Deploys the full trust-framework stack and wires cross-contract permissions.
 *
 * Deployment order matters: the verifier and reputation registry must exist before the
 * factory (which registers campaigns with the verifier) and the dispute module (which
 * writes reputation outcomes).
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts                       # local hardhat node
 *   npx hardhat run scripts/deploy.ts --network sepolia
 *   npx hardhat run scripts/deploy.ts --network amoy
 *
 * Writes deployments/<network>.json for the backend and frontend to consume.
 */
import { ethers } from "hardhat";
import { writeFileSync, mkdirSync } from "node:fs";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86_400n;

async function main() {
  const signers = await ethers.getSigners();
  const [deployer, treasury, oracleAuthority] = signers;

  const network = await ethers.provider.getNetwork();
  const chainId = network.chainId.toString();
  console.log(`\nDeploying trust framework on chainId ${chainId}`);
  console.log(`  deployer : ${deployer.address}`);
  console.log(`  treasury : ${treasury.address}\n`);

  // ---- ReputationRegistry -------------------------------------------------
  const Reputation = await ethers.getContractFactory("ReputationRegistry");
  const reputation = await Reputation.deploy(deployer.address);
  await reputation.waitForDeployment();
  console.log(`ReputationRegistry   ${await reputation.getAddress()}`);

  // ---- CredentialRegistry -------------------------------------------------
  const CredentialRegistryFactory = await ethers.getContractFactory("CredentialRegistry");
  const credentials = await CredentialRegistryFactory.deploy(
    deployer.address,
    deployer.address // issuer; replace with the Veramo agent address in production
  );
  await credentials.waitForDeployment();
  console.log(`CredentialRegistry   ${await credentials.getAddress()}`);

  // ---- MilestoneVerifier --------------------------------------------------
  // Optional oracle adapter: disabled by default (no real data source is wired up).
  const Verifier = await ethers.getContractFactory("MilestoneVerifier");
  const verifier = await Verifier.deploy(
    deployer.address,
    treasury.address,
    ethers.ZeroAddress, // oracle adapter
    ethers.parseEther("1"), // min verifier stake: 1 token
    5_000, // quorum: 50% of active stake
    6_000, // approval threshold: 60% of cast weight
    Number(2n * DAY), // voting window
    ethers.parseEther("0.5"), // oracle weight
    2_000, // slash: 20% of stake
    5_000 // reward: 50% of slash redistributed
  );
  await verifier.waitForDeployment();
  console.log(`MilestoneVerifier    ${await verifier.getAddress()}`);

  // ---- DisputeResolution --------------------------------------------------
  const Dispute = await ethers.getContractFactory("DisputeResolution");
  const disputes = await Dispute.deploy(
    deployer.address,
    treasury.address,
    await verifier.getAddress(),
    await reputation.getAddress()
  );
  await disputes.waitForDeployment();
  console.log(`DisputeResolution    ${await disputes.getAddress()}`);

  // ---- CampaignFactory ----------------------------------------------------
  const Factory = await ethers.getContractFactory("CampaignFactory");
  const factory = await Factory.deploy(
    await verifier.getAddress(),
    deployer.address,
    treasury.address
  );
  await factory.waitForDeployment();
  console.log(`CampaignFactory      ${await factory.getAddress()}\n`);

  // ---- Cross-contract permission wiring -----------------------------------
  // The factory must be able to register campaigns with the verifier.
  await (await verifier.connect(deployer).setRegistrar(await factory.getAddress(), true)).wait();

  // The dispute module writes dispute outcomes to reputation.
  await (
    await reputation.connect(deployer).setWriter(await disputes.getAddress(), true)
  ).wait();

  console.log("Permissions wired:");
  console.log(`  verifier.registerCampaign  <- ${await factory.getAddress()}`);
  console.log(`  reputation writer          <- ${await disputes.getAddress()}`);

  // ---- Persistence --------------------------------------------------------
  const outDir = "deployments";
  mkdirSync(outDir, { recursive: true });
  const deployment = {
    chainId,
    network: process.env.HARDHAT_NETWORK ?? "hardhat",
    deployer: deployer.address,
    treasury: treasury.address,
    contracts: {
      ReputationRegistry: await reputation.getAddress(),
      CredentialRegistry: await credentials.getAddress(),
      MilestoneVerifier: await verifier.getAddress(),
      DisputeResolution: await disputes.getAddress(),
      CampaignFactory: await factory.getAddress(),
    },
    parameters: {
      minVerifierStake: ethers.parseEther("1").toString(),
      quorumBps: 5_000,
      thresholdBps: 6_000,
      votingWindowSeconds: Number(2n * DAY),
      oracleWeight: ethers.parseEther("0.5").toString(),
      slashBps: 2_000,
      rewardBps: 5_000,
    },
  };
  const path = `${outDir}/${deployment.network}.json`;
  writeFileSync(path, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment written to ${path}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});