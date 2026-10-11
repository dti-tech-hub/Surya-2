import { time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Shared fixture helpers for the campaign test suites.
 *
 * Defaults used across the suite:
 *  - goal                 : 100 ETH
 *  - funding window       : 30 days
 *  - milestones           : 3 tranches of 4000/3500/2500 bps (sums to exactly 10 000)
 *  - voting window        : 2 days
 *  - quorum               : 50% of active stake
 *  - approval threshold   : 60% of cast weight
 */

export const BPS = 10_000n;
export const DAY = 86_400n;

export const GOAL = ethers.parseEther("100");
export const VERIFIER_STAKE = ethers.parseEther("1");

export interface Deployment {
  factory: any;
  verifier: any;
  creator: HardhatEthersSigner;
  backer: HardhatEthersSigner;
  backer2: HardhatEthersSigner;
  verifier1: HardhatEthersSigner;
  verifier2: HardhatEthersSigner;
  verifier3: HardhatEthersSigner;
  treasury: HardhatEthersSigner;
}

export async function deploySystem(): Promise<Deployment> {
  const signers = await ethers.getSigners();
  const [creator, backer, backer2, verifier1, verifier2, verifier3, , , , treasury] = signers;

  const Verifier = await ethers.getContractFactory("MilestoneVerifier");
  const verifier = await Verifier.deploy(
    creator.address, // admin
    treasury.address, // treasury
    ethers.ZeroAddress, // no oracle by default
    VERIFIER_STAKE, // min stake
    5_000, // quorumBps  = 50%
    6_000, // thresholdBps = 60%
    2n * DAY, // votingWindow
    ethers.parseEther("0.5"), // oracleWeight
    2_000, // slashBps = 20%
    5_000 // rewardBps = 50%
  );
  await verifier.waitForDeployment();

  const Factory = await ethers.getContractFactory("CampaignFactory");
  const factory = await Factory.deploy(
    await verifier.getAddress(),
    creator.address,
    treasury.address
  );
  await factory.waitForDeployment();

  // The factory needs registrar rights so its deployments can be verified.
  await verifier.connect(creator).setRegistrar(await factory.getAddress(), true);

  return {
    factory,
    verifier,
    creator,
    backer,
    backer2,
    verifier1,
    verifier2,
    verifier3,
    treasury,
  };
}

/** Builds a valid CampaignParams struct for the factory. */
export async function buildParams(goal = GOAL, fundingDays = 30n) {
  const now = await time.latest();
  const fundingDeadline = now + Number(fundingDays * DAY);

  return {
    goal,
    fundingDeadline,
    trancheBps: [4_000, 3_500, 2_500],
    descriptionHashes: [
      ethers.keccak256(ethers.toUtf8Bytes("prototype built and tested")),
      ethers.keccak256(ethers.toUtf8Bytes("first 100 units produced")),
      ethers.keccak256(ethers.toUtf8Bytes("shipped to backers")),
    ],
    specificationCIDs: ["bafybeigspec0", "bafybeigspec1", "bafybeigspec2"],
    milestoneDeadlines: [
      fundingDeadline + Number(10n * DAY),
      fundingDeadline + Number(20n * DAY),
      fundingDeadline + Number(30n * DAY),
    ],
    // address(0) makes the factory fall back to its own immutable treasury.
    treasury: ethers.ZeroAddress,
  };
}

/** Creates a campaign through the factory and returns its deployed address. */
export async function createCampaign(
  factory: any,
  creator: HardhatEthersSigner,
  params: any
): Promise<string> {
  const tx = await factory.connect(creator).createCampaign(params);
  const receipt = await tx.wait();
  const event = receipt!.logs
    .map((log: any) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed?.name === "CampaignDeployed");
  return event.args.campaign;
}

/** Stakes `signer` as a verifier. */
export async function stakeVerifier(verifier: any, signer: HardhatEthersSigner) {
  await verifier.connect(signer).stakeVerifier({ value: VERIFIER_STAKE });
}

/**
 * Drives a milestone through the full verification cycle.
 *
 * Ordering matters: votes must be cast *during* the voting window, and settlement may
 * only happen after it closes.
 *
 * @param approveVotes how many verifier signers should vote Approve (the rest Reject).
 */
export async function resolveMilestone(
  campaign: any,
  verifier: any,
  index: number,
  verifiers: HardhatEthersSigner[],
  approveVotes: number
) {
  const campaignAddress = await campaign.getAddress();

  for (let i = 0; i < verifiers.length; i++) {
    const choice = i < approveVotes ? 1 : 2; // 1 = Approve, 2 = Reject
    await verifier.connect(verifiers[i]).castVote(campaignAddress, index, choice);
  }

  const round = await verifier.getRound(campaignAddress, index);
  await time.increaseTo(Number(round.voteDeadline) + 1);

  await campaign.resolveMilestone(index);
}