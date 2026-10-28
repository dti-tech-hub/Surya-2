/**
 * End-to-end lifecycle demo against a running local Hardhat node.
 *
 * This is the executable counterpart to the paper's evaluation narrative. It walks one
 * campaign through every trust mechanism in the prototype:
 *
 *   1. factory-created milestone escrow, overfunded raise
 *   2. evidence publication (backend Pinata/Kubo/local store) + on-chain digest
 *   3. stake-weighted verifier approval, with a dissenting verifier slashed
 *   4. creator tranche withdrawal
 *   5. a rejected milestone and a non-voter penalty
 *   6. backer-raised dispute, stake-weighted juror vote, refund verdict
 *   7. pro-rata refunds and on-chain reputation updates
 *
 * Everything printed here is measured against a live local EVM. It is NOT a public
 * testnet measurement: no L1/L2 latency, throughput, or DA cost is claimed.
 *
 * Prerequisites:
 *   npx hardhat node                                      # terminal 1
 *   npx hardhat run scripts/deploy.ts --network localhost  # terminal 2
 *   npx hardhat run scripts/demo.ts --network localhost    # terminal 3
 *
 * Optional:
 *   BACKEND_URL=http://127.0.0.1:4000  (evidence upload; falls back to an unpublished
 *                                       digest reference if the backend is offline)
 *
 * Writes evaluation/results/demo-lifecycle.json with every transaction hash and gas
 * value, so the paper can cite the run rather than a hand-written summary.
 */
import { ethers } from "hardhat";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ContractTransactionResponse } from "ethers";

const DAY = 86_400;
const BACKEND_URL = (process.env.BACKEND_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "");
const OUT_PATH = "evaluation/results/demo-lifecycle.json";

const CAMPAIGN_STATES = ["Funding", "Active", "Failed", "Completed", "Cancelled"];
const MILESTONE_STATES = ["Pending", "Submitted", "Verified", "Rejected"];
const DISPUTE_OUTCOMES = ["None", "Refund", "Release", "Partial"];
const TIERS = ["Unrated", "Bronze", "Silver", "Gold", "Platinum"];

type StepStatus = "MEASURED" | "SKIPPED" | "FAILED";

interface Step {
  stage: string;
  action: string;
  status: StepStatus;
  txHash?: string;
  gasUsed?: string;
  blockNumber?: number;
  detail?: string;
}

const steps: Step[] = [];

function record(step: Step): void {
  steps.push(step);
  if (step.status === "SKIPPED") {
    console.log(`  - ${step.action} (skipped: ${step.detail ?? "already satisfied"})`);
    return;
  }
  const gas = step.gasUsed ? ` gas=${step.gasUsed}` : "";
  console.log(`  ✓ ${step.action}${gas}${step.detail ? ` — ${step.detail}` : ""}`);
}

async function exec(
  stage: string,
  action: string,
  fn: () => Promise<ContractTransactionResponse>,
  detail?: string
): Promise<Awaited<ReturnType<ContractTransactionResponse["wait"]>> & object> {
  const tx = await fn();
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`transaction ${tx.hash} produced no receipt`);
  record({
    stage,
    action,
    status: "MEASURED",
    txHash: receipt.hash,
    gasUsed: receipt.gasUsed.toString(),
    blockNumber: receipt.blockNumber,
    detail,
  });
  return receipt;
}

async function latestTimestamp(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  if (!block) throw new Error("no latest block");
  return block.timestamp;
}

async function advance(seconds: number, reason: string): Promise<void> {
  if (seconds <= 0) seconds = 1;
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
  const ts = await latestTimestamp();
  console.log(
    `  [time] +${seconds}s -> ${new Date(ts * 1000).toISOString()} (${reason})`
  );
}

async function advancePast(timestamp: number | bigint, reason: string): Promise<void> {
  const now = await latestTimestamp();
  const target = Number(timestamp);
  await advance(target - now + 1, reason);
}

interface PublishedDocument {
  filename: string;
  cid: string;
  provider: string;
  isIpfs: boolean;
  sha256: string;
  keccak256: string;
  size: number;
}

/**
 * Publishes a document through the backend's evidence adapter when available.
 *
 * The adapter is honest about its storage mode: `local-content-store` is a CIDv1 raw
 * identifier on this machine, NOT an IPFS pin. The returned `provider` is recorded in
 * the artifact so a paper table cannot accidentally describe local bytes as IPFS.
 */
async function publishDocument(filename: string, body: string): Promise<PublishedDocument> {
  const bytes = Buffer.from(body, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const keccak256 = ethers.keccak256(bytes);
  const base = { filename, sha256, keccak256, size: bytes.length };

  try {
    const res = await fetch(`${BACKEND_URL}/api/evidence`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": filename,
        "X-Content-Type": "text/plain; charset=utf-8",
      },
      body: bytes,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      data?: { cid?: string; provider?: string };
    };
    const cid = json.data?.cid;
    const provider = json.data?.provider ?? "unknown";
    if (!cid) throw new Error("backend response had no CID");
    return { ...base, cid, provider, isIpfs: provider === "pinata" || provider === "local-ipfs" };
  } catch (error) {
    const reason = (error as Error).message;
    console.log(
      `  ! evidence backend unavailable at ${BACKEND_URL} (${reason}); ` +
        "using an unpublished digest reference (NOT IPFS)"
    );
    return {
      ...base,
      // Clearly non-IPFS: the on-chain string is a local audit reference, not a CID.
      cid: `demo-unpublished-${sha256.slice(0, 40)}`,
      provider: "not-published",
      isIpfs: false,
    };
  }
}

function stateName(value: bigint | number): string {
  return CAMPAIGN_STATES[Number(value)] ?? `unknown(${value})`;
}

function milestoneStateName(value: bigint | number): string {
  return MILESTONE_STATES[Number(value)] ?? `unknown(${value})`;
}

function disputeOutcomeName(value: bigint | number): string {
  return DISPUTE_OUTCOMES[Number(value)] ?? `unknown(${value})`;
}

function tierName(value: bigint | number): string {
  return TIERS[Number(value)] ?? `unknown(${value})`;
}

function eth(value: bigint): string {
  return `${ethers.formatEther(value)} ETH`;
}

function jsonify(value: any): any {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonify);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonify(v)]));
  }
  return value;
}

async function main(): Promise<void> {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 31337n) {
    throw new Error(
      `demo.ts expects the local Hardhat chain (31337); connected to ${network.chainId}. ` +
        "Public-testnet measurements are not produced by this script."
    );
  }

  const manifestPath = "deployments/localhost.json";
  if (!existsSync(manifestPath)) {
    throw new Error(`${manifestPath} not found. Run scripts/deploy.ts --network localhost first.`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    chainId: string;
    network: string;
    contracts: Record<string, string>;
  };

  const signers = await ethers.getSigners();
  if (signers.length < 8) throw new Error(`need at least 8 signers, got ${signers.length}`);
  const [deployer, treasury, creator, backer1, backer2, verifier1, verifier2, verifier3] =
    signers;

  const factory = await ethers.getContractAt("CampaignFactory", manifest.contracts.CampaignFactory);
  const verifier = await ethers.getContractAt("MilestoneVerifier", manifest.contracts.MilestoneVerifier);
  const disputes = await ethers.getContractAt("DisputeResolution", manifest.contracts.DisputeResolution);
  const reputation = await ethers.getContractAt("ReputationRegistry", manifest.contracts.ReputationRegistry);

  console.log("\n=== Trust-management lifecycle demo (local Hardhat EVM) ===");
  console.log(`  chainId      : ${network.chainId}`);
  console.log(`  factory      : ${await factory.getAddress()}`);
  console.log(`  verifier     : ${await verifier.getAddress()}`);
  console.log(`  disputes     : ${await disputes.getAddress()}`);
  console.log(`  reputation   : ${await reputation.getAddress()}`);
  console.log(`  evidence API : ${BACKEND_URL}\n`);

  // -------------------------------------------------------------------------
  // Setup: stake the verifier panel and the dispute jurors.
  // -------------------------------------------------------------------------
  console.log("[setup] verifier and juror stake");
  const verifierSigners = [
    ["verifier-1", verifier1],
    ["verifier-2", verifier2],
    ["verifier-3", verifier3],
  ] as const;

  for (const [name, signer] of verifierSigners) {
    const info = await verifier.getVerifier(signer.address);
    if (info.active) {
      record({
        stage: "setup",
        action: `verifier ${name} already staked`,
        status: "SKIPPED",
        detail: `${eth(info.stake)} active`,
      });
      continue;
    }
    await exec(
      "setup",
      `verifier ${name} stakes 2 ETH`,
      () => verifier.connect(signer).stakeVerifier({ value: ethers.parseEther("2") }),
      "2 ETH"
    );
  }

  for (const [name, signer] of verifierSigners) {
    const weight = await disputes.jurorWeight(signer.address);
    if (weight > 0n) {
      record({
        stage: "setup",
        action: `juror ${name} already staked`,
        status: "SKIPPED",
        detail: `weight ${weight}`,
      });
      continue;
    }
    await exec(
      "setup",
      `juror ${name} stakes 1 ETH`,
      () => disputes.connect(signer).stakeJuror({ value: ethers.parseEther("1") }),
      "1 ETH"
    );
  }

  const verifierStakeStart = {
    verifier1: (await verifier.getVerifier(verifier1.address)).stake,
    verifier2: (await verifier.getVerifier(verifier2.address)).stake,
    verifier3: (await verifier.getVerifier(verifier3.address)).stake,
  };

  // -------------------------------------------------------------------------
  // Publish milestone specifications, then create the campaign.
  // -------------------------------------------------------------------------
  console.log("\n[campaign] publish specifications and create campaign");
  const spec0 = await publishDocument(
    "demo-milestone-0-spec.txt",
    "Milestone 0: working prototype. Acceptance: deployed contracts pass the integration suite; " +
      "repository contains reproducible deployment and demo scripts.\n"
  );
  const spec1 = await publishDocument(
    "demo-milestone-1-spec.txt",
    "Milestone 1: pilot batch. Acceptance: 100 units produced and shipped; evidence includes " +
      "batch records and carrier receipt.\n"
  );
  record({
    stage: "campaign",
    action: "publish milestone specifications",
    status: "MEASURED",
    detail: `spec0=${spec0.cid} (${spec0.provider}), spec1=${spec1.cid} (${spec1.provider})`,
  });

  const now = await latestTimestamp();
  const fundingDeadline = now + 2 * DAY;
  const params = {
    goal: ethers.parseEther("10"),
    fundingDeadline,
    trancheBps: [6_000, 4_000],
    descriptionHashes: [
      ethers.keccak256(ethers.toUtf8Bytes("prototype built and integration-tested")),
      ethers.keccak256(ethers.toUtf8Bytes("pilot batch produced and shipped")),
    ],
    specificationCIDs: [spec0.cid, spec1.cid],
    milestoneDeadlines: [fundingDeadline + 28 * DAY, fundingDeadline + 58 * DAY],
    treasury: ethers.ZeroAddress,
  };

  const createReceipt = await exec(
    "campaign",
    "createCampaign (goal 10 ETH, 2 milestones 60/40)",
    () => factory.connect(creator).createCampaign(params),
    "factory deploys + registers campaign, verifier and dispute module"
  );

  const deployedEvent = createReceipt.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "CampaignDeployed");
  if (!deployedEvent) throw new Error("CampaignDeployed event not found");
  const campaignAddress = deployedEvent.args.campaign as string;
  const campaign = await ethers.getContractAt("Campaign", campaignAddress);
  const campaignId = {
    address: campaignAddress,
    creator: creator.address,
    goal: params.goal,
    fundingDeadline,
    trancheBps: params.trancheBps,
    milestoneDeadlines: params.milestoneDeadlines,
  };
  console.log(`  campaign address: ${campaignAddress}`);

  // -------------------------------------------------------------------------
  // Funding: overfund the 10 ETH goal with 12 ETH.
  // -------------------------------------------------------------------------
  console.log("\n[funding] contributions and deadline");
  const backer1BalanceBefore = await ethers.provider.getBalance(backer1.address);
  const backer2BalanceBefore = await ethers.provider.getBalance(backer2.address);

  await exec(
    "funding",
    "backer-1 contributes 7 ETH",
    () => campaign.connect(backer1).contribute({ value: ethers.parseEther("7") }),
    "overfunding: total 12 ETH vs 10 ETH goal"
  );
  await exec(
    "funding",
    "backer-2 contributes 5 ETH",
    () => campaign.connect(backer2).contribute({ value: ethers.parseEther("5") }),
    "overfunding: total 12 ETH vs 10 ETH goal"
  );

  await advancePast(fundingDeadline, "funding deadline");
  await exec("funding", "closeFunding", () => campaign.connect(backer1).closeFunding(), "goal met");
  const stateAfterFunding = await campaign.state();
  if (Number(stateAfterFunding) !== 1) {
    throw new Error(`expected Active after closeFunding, got ${stateName(stateAfterFunding)}`);
  }
  const totalContributed = await campaign.totalContributed();

  // -------------------------------------------------------------------------
  // Milestone 0: approve, dissent slash, creator withdrawal.
  // -------------------------------------------------------------------------
  console.log("\n[milestone-0] evidence, verifier vote, settlement");
  const evidence0 = await publishDocument(
    "demo-milestone-0-evidence.txt",
    "Milestone 0 evidence: integration suite and deployment transcript. " +
      `Campaign ${campaignAddress}, generated ${new Date(now * 1000).toISOString()}.\n`
  );
  await exec(
    "milestone-0",
    "submitEvidence",
    () => campaign.connect(creator).submitEvidence(0, evidence0.cid, evidence0.keccak256),
    `CID ${evidence0.cid} (${evidence0.provider}); digest ${evidence0.keccak256}`
  );

  await exec("milestone-0", "verifier-1 votes Approve", () =>
    verifier.connect(verifier1).castVote(campaignAddress, 0, 1)
  );
  await exec("milestone-0", "verifier-2 votes Approve", () =>
    verifier.connect(verifier2).castVote(campaignAddress, 0, 1)
  );
  await exec("milestone-0", "verifier-3 votes Reject (minority)", () =>
    verifier.connect(verifier3).castVote(campaignAddress, 0, 2)
  );

  const round0 = await verifier.getRound(campaignAddress, 0);
  await advancePast(round0.voteDeadline, "milestone-0 verifier voting window");
  await exec("milestone-0", "resolveMilestone", () => campaign.connect(backer1).resolveMilestone(0));
  const milestone0 = await campaign.getMilestone(0);
  const releasedAfter0 = await campaign.totalReleased();
  if (Number(milestone0.state) !== 2) {
    throw new Error(`expected milestone 0 Verified, got ${milestoneStateName(milestone0.state)}`);
  }

  await exec(
    "milestone-0",
    "verifier-1 claimSettlement",
    () => verifier.connect(verifier1).claimSettlement(campaignAddress, 0),
    "correct majority vote"
  );
  await exec(
    "milestone-0",
    "verifier-2 claimSettlement",
    () => verifier.connect(verifier2).claimSettlement(campaignAddress, 0),
    "correct majority vote"
  );
  await exec(
    "milestone-0",
    "verifier-3 claimSettlement",
    () => verifier.connect(verifier3).claimSettlement(campaignAddress, 0),
    "minority vote slashed at 20% of vote-time stake"
  );
  const verifier3AfterM0 = (await verifier.getVerifier(verifier3.address)).stake;

  const creatorBalanceBeforeClaim = await campaign.creatorBalance();
  await exec(
    "milestone-0",
    "claimCreatorBalance",
    () => campaign.connect(creator).claimCreatorBalance(),
    `${eth(creatorBalanceBeforeClaim)} released`
  );

  // -------------------------------------------------------------------------
  // Milestone 1: reject and penalise a non-voter.
  // -------------------------------------------------------------------------
  console.log("\n[milestone-1] rejected evidence and non-voter penalty");
  const evidence1 = await publishDocument(
    "demo-milestone-1-evidence.txt",
    "Milestone 1 evidence: pilot batch records. Intentionally incomplete for the demo; " +
      "the verifier panel rejects it and a backer appeals.\n"
  );
  await exec(
    "milestone-1",
    "submitEvidence",
    () => campaign.connect(creator).submitEvidence(1, evidence1.cid, evidence1.keccak256),
    `CID ${evidence1.cid} (${evidence1.provider}); digest ${evidence1.keccak256}`
  );

  await exec("milestone-1", "verifier-1 votes Reject", () =>
    verifier.connect(verifier1).castVote(campaignAddress, 1, 2)
  );
  await exec("milestone-1", "verifier-2 votes Reject", () =>
    verifier.connect(verifier2).castVote(campaignAddress, 1, 2)
  );
  record({
    stage: "milestone-1",
    action: "verifier-3 abstains",
    status: "MEASURED",
    detail: "deliberate non-voter for penalty demonstration",
  });

  const round1 = await verifier.getRound(campaignAddress, 1);
  await advancePast(round1.voteDeadline, "milestone-1 verifier voting window");
  await exec("milestone-1", "resolveMilestone", () => campaign.connect(backer1).resolveMilestone(1));
  const milestone1 = await campaign.getMilestone(1);
  if (Number(milestone1.state) !== 3) {
    throw new Error(`expected milestone 1 Rejected, got ${milestoneStateName(milestone1.state)}`);
  }

  await exec(
    "milestone-1",
    "penalizeNonVoter(verifier-3)",
    () => verifier.connect(backer1)["penalizeNonVoter(address,uint256,address)"](campaignAddress, 1, verifier3.address),
    "permissionless enforcement; 20% of current stake"
  );
  const verifier3AfterNonVote = (await verifier.getVerifier(verifier3.address)).stake;

  await exec(
    "milestone-1",
    "verifier-1 claimSettlement",
    () => verifier.connect(verifier1).claimSettlement(campaignAddress, 1),
    "correct majority vote"
  );
  await exec(
    "milestone-1",
    "verifier-2 claimSettlement",
    () => verifier.connect(verifier2).claimSettlement(campaignAddress, 1),
    "correct majority vote"
  );

  // -------------------------------------------------------------------------
  // Dispute: backer appeals the rejection; jurors vote; refund verdict.
  // -------------------------------------------------------------------------
  console.log("\n[dispute] backer appeal, juror vote, refund verdict");
  const refundQuote1 = await campaign.refundQuote(backer1.address);
  const refundQuote2 = await campaign.refundQuote(backer2.address);

  const disputeReceipt = await exec(
    "dispute",
    "backer-1 raiseDispute(milestone 1)",
    () => disputes.connect(backer1).raiseDispute(campaignAddress, 1, { value: ethers.parseEther("0.05") }),
    "bond 0.05 ETH; caller must be an on-chain backer"
  );
  const disputeRaised = disputeReceipt.logs
    .map((log) => {
      try {
        return disputes.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "DisputeRaised");
  const disputeKey = disputeRaised
    ? (disputeRaised.args.disputeKey as string)
    : await disputes.disputeKey(campaignAddress, 1);

  await exec("dispute", "juror-1 votes Refund", () =>
    disputes.connect(verifier1).castVote(disputeKey, false)
  );
  await exec("dispute", "juror-2 votes Refund", () =>
    disputes.connect(verifier2).castVote(disputeKey, false)
  );
  await exec("dispute", "juror-3 votes Release (minority)", () =>
    disputes.connect(verifier3).castVote(disputeKey, true)
  );

  const disputeBeforeResolve = await disputes.getDispute(disputeKey);
  await advancePast(disputeBeforeResolve.voteDeadline, "dispute voting window");
  await exec("dispute", "resolve", () => disputes.connect(backer2).resolve(disputeKey), "permissionless");

  const resolvedDispute = await disputes.getDispute(disputeKey);
  const stateAfterDispute = await campaign.state();
  if (Number(stateAfterDispute) !== 2) {
    throw new Error(`expected Failed after refund verdict, got ${stateName(stateAfterDispute)}`);
  }

  await exec("dispute", "juror-1 settleJuror", () =>
    disputes.connect(verifier1).settleJuror(disputeKey)
  );
  await exec("dispute", "juror-2 settleJuror", () =>
    disputes.connect(verifier2).settleJuror(disputeKey)
  );
  await exec(
    "dispute",
    "juror-3 settleJuror",
    () => disputes.connect(verifier3).settleJuror(disputeKey),
    "minority juror slashed at 10% of vote-time stake"
  );

  // -------------------------------------------------------------------------
  // Refunds: each backer withdraws their pro-rata share of the unreleased pot.
  // -------------------------------------------------------------------------
  console.log("\n[refunds] pro-rata claims after the refund verdict");
  await exec(
    "refunds",
    "backer-1 claimRefund",
    () => campaign.connect(backer1).claimRefund(),
    `${eth(refundQuote1)} quoted`
  );
  await exec(
    "refunds",
    "backer-2 claimRefund",
    () => campaign.connect(backer2).claimRefund(),
    `${eth(refundQuote2)} quoted`
  );

  const totalReleased = await campaign.totalReleased();
  const totalRefunded = await campaign.totalRefunded();
  const escrowBalance = await campaign.escrowBalance();
  const finalState = await campaign.state();
  const backer1BalanceAfter = await ethers.provider.getBalance(backer1.address);
  const backer2BalanceAfter = await ethers.provider.getBalance(backer2.address);

  // -------------------------------------------------------------------------
  // Reputation: the terminal outcomes must be visible on-chain.
  // -------------------------------------------------------------------------
  console.log("\n[reputation] on-chain profiles");
  const creatorProfile = await reputation.getProfile(creator.address);
  const creatorScore = await reputation.scoreOf(creator.address);
  const creatorTier = await reputation.tierOf(creator.address);

  const verifierProfiles = {
    verifier1: {
      profile: await reputation.getProfile(verifier1.address),
      score: await reputation.scoreOf(verifier1.address),
      tier: await reputation.tierOf(verifier1.address),
      stake: (await verifier.getVerifier(verifier1.address)).stake,
    },
    verifier2: {
      profile: await reputation.getProfile(verifier2.address),
      score: await reputation.scoreOf(verifier2.address),
      tier: await reputation.tierOf(verifier2.address),
      stake: (await verifier.getVerifier(verifier2.address)).stake,
    },
    verifier3: {
      profile: await reputation.getProfile(verifier3.address),
      score: await reputation.scoreOf(verifier3.address),
      tier: await reputation.tierOf(verifier3.address),
      stake: (await verifier.getVerifier(verifier3.address)).stake,
    },
  };

  console.log(
    `  creator: score=${creatorScore} tier=${tierName(creatorTier)} ` +
      `milestones=${creatorProfile.milestonesOnTime}/${creatorProfile.milestonesTotal} ` +
      `campaigns=${creatorProfile.campaignsCompleted} completed / ${creatorProfile.campaignsFailed} failed ` +
      `disputes=${creatorProfile.disputeWins} won / ${creatorProfile.disputeLosses} lost`
  );
  for (const [name, data] of Object.entries(verifierProfiles)) {
    console.log(
      `  ${name}: score=${data.score} tier=${tierName(data.tier)} ` +
        `votes=${data.profile.votesCorrect}/${data.profile.votesTotal} correct ` +
        `stake=${eth(data.stake)}`
    );
  }

  if (totalReleased + totalRefunded !== totalContributed) {
    throw new Error(
      `accounting mismatch: released ${totalReleased} + refunded ${totalRefunded} != contributed ${totalContributed}`
    );
  }
  if (escrowBalance !== 0n) {
    throw new Error(`escrow should be empty after all claims, got ${eth(escrowBalance)}`);
  }
  if (Number(finalState) !== 2) {
    throw new Error(`expected final state Failed, got ${stateName(finalState)}`);
  }

  // -------------------------------------------------------------------------
  // Persist the measured run.
  // -------------------------------------------------------------------------
  const artifact = {
    status: "MEASURED",
    label:
      "Live local Hardhat EVM run. Measures contract behaviour, gas, and lifecycle outcomes only; " +
      "not public-testnet latency, throughput, or L1 data-availability cost.",
    generatedAt: new Date().toISOString(),
    network: {
      name: "localhost",
      chainId: network.chainId.toString(),
      rpc: "http://127.0.0.1:8545",
      manifestPath,
    },
    deployment: manifest.contracts,
    actors: {
      deployer: deployer.address,
      treasury: treasury.address,
      creator: creator.address,
      backer1: backer1.address,
      backer2: backer2.address,
      verifier1: verifier1.address,
      verifier2: verifier2.address,
      verifier3: verifier3.address,
    },
    campaign: {
      ...campaignId,
      totalContributed,
      totalReleased,
      totalRefunded,
      escrowBalance,
      finalState: stateName(finalState),
      creatorBalanceClaimed: creatorBalanceBeforeClaim,
    },
    evidence: {
      specifications: [spec0, spec1],
      milestone0: evidence0,
      milestone1: evidence1,
      note:
        "Providers are reported verbatim. `local-content-store` is a local CIDv1 raw store, " +
        "not an IPFS pin; `not-published` means the backend was offline.",
    },
    verifierEconomics: {
      stakesAtStart: verifierStakeStart,
      verifier3AfterMilestone0Slash: verifier3AfterM0,
      verifier3AfterNonVoterPenalty: verifier3AfterNonVote,
    },
    outcomes: {
      funding: {
        goalMet: true,
        totalContributed,
        overfundedBy: totalContributed - params.goal,
      },
      milestone0: {
        state: milestoneStateName(milestone0.state),
        trancheBps: params.trancheBps[0],
        released: releasedAfter0,
        creatorWithdrew: creatorBalanceBeforeClaim,
      },
      milestone1: {
        state: milestoneStateName(milestone1.state),
      },
      dispute: {
        key: disputeKey,
        outcome: disputeOutcomeName(resolvedDispute.outcome),
        partialBps: resolvedDispute.partialBps,
        forRefundWeight: resolvedDispute.forRefundWeight,
        forCreatorWeight: resolvedDispute.forCreatorWeight,
        raiserBond: resolvedDispute.raiserBond,
        campaignStateAfter: stateName(stateAfterDispute),
      },
      refunds: {
        backer1: {
          quoted: refundQuote1,
          balanceBefore: backer1BalanceBefore,
          balanceAfter: backer1BalanceAfter,
        },
        backer2: {
          quoted: refundQuote2,
          balanceBefore: backer2BalanceBefore,
          balanceAfter: backer2BalanceAfter,
        },
      },
    },
    reputation: {
      creator: {
        score: creatorScore,
        tier: tierName(creatorTier),
        profile: creatorProfile,
      },
      verifiers: verifierProfiles,
    },
    steps,
    stepCount: steps.length,
    note:
      "All transaction hashes and gas values are reproduced on the local Hardhat node. " +
      "Re-running against a fresh node produces a new campaign and new hashes.",
  };

  mkdirSync("evaluation/results", { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(jsonify(artifact), null, 2));

  console.log(`\n=== Demo complete ===`);
  console.log(`  campaign       : ${campaignAddress}`);
  console.log(`  contributed    : ${eth(totalContributed)}`);
  console.log(`  released        : ${eth(totalReleased)}`);
  console.log(`  refunded        : ${eth(totalRefunded)}`);
  console.log(`  escrow remaining: ${eth(escrowBalance)}`);
  console.log(`  transactions    : ${steps.filter((s) => s.txHash).length}`);
  console.log(`  artifact        : ${OUT_PATH}\n`);
  void deployer;
}

main().catch((error) => {
  console.error("\nDEMO FAILED");
  console.error(error);
  process.exitCode = 1;
});
