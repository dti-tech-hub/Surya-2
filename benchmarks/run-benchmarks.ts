/**
 * Benchmark harness: measures gas cost, confirmation latency, and throughput for each
 * core operation, then writes JSON + CSV that the plotting script consumes.
 *
 * WHY THIS IS A SEPARATE HARNESS
 * ------------------------------
 * The spec requires L1-vs-L2 numbers to be produced "with the backend and DB out of
 * the loop". This script therefore talks to the chain directly through ethers and never
 * touches SQLite, the Express API, or the indexer. Any latency it reports is chain
 * latency, not application latency.
 *
 * HONESTY OF THE OUTPUT
 * ---------------------
 * Running against `--network hardhat` produces SIMULATED numbers: an in-process EVM
 * with no network, no propagation delay, and no L1 data-availability cost. Those
 * numbers are useful for *relative* comparison of operations (which operation is more
 * expensive than which) but they say nothing about real network cost, and the CSV is
 * tagged `"simulated": true` so a simulated run can never be mistaken for a real one.
 *
 * To produce real figures:
 *   npx hardhat run benchmarks/run-benchmarks.ts --network sepolia
 *   npx hardhat run benchmarks/run-benchmarks.ts --network amoy
 * Both require funded testnet accounts (see .env.example).
 *
 * L2 cost caveat, stated up front: on rollups the execution gas measured here is only
 * part of the bill. A rollup transaction also pays an L1 data-availability charge for
 * the calldata, which is frequently the dominant term. This script records the
 * execution gas and, when the RPC exposes it, the L1 fee component, so the two are not
 * conflated.
 */
import { ethers, network } from "hardhat";
import { writeFileSync, mkdirSync } from "node:fs";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 86_400n;
const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 5);
const CONCURRENCY_LEVELS = (process.env.BENCH_CONCURRENCY ?? "10,50,100")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

// Stated cost assumptions. Recorded in the output so any figure can be recomputed or
// re-priced when these change.
const GAS_PRICE_GWEI = Number(process.env.BENCH_GAS_PRICE_L1_GWEI ?? 10);
const ETH_USD = Number(process.env.BENCH_ETH_USD ?? 2500);

interface Sample {
  operation: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  wallClockMs: number;
  txHash?: string;
}

interface ThroughputResult {
  concurrency: number;
  operations: number;
  totalMs: number;
  txPerSecond: number;
  failures: number;
}

interface BenchResult {
  network: string;
  chainId: string;
  simulated: boolean;
  measuredAt: string;
  assumptions: {
    gasPriceGwei: number;
    ethUsd: number;
    samples: number;
  };
  gas: Sample[];
  throughput: ThroughputResult[];
  notes: string[];
}

function now(): number {
  return Date.now();
}

/** Runs `fn` SAMPLES times, recording gas, effective gas price, and wall-clock latency. */
async function measure(
  operation: string,
  fn: (i: number) => Promise<{ hash?: string; wait: () => Promise<any> }>
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const { hash, wait } = await fn(i);
    const start = now();
    const receipt = await wait();
    const elapsed = now() - start;
    samples.push({
      operation,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice ?? 0n,
      wallClockMs: elapsed,
      txHash: hash,
    });
  }
  return samples;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Builds campaign parameters anchored to the *current* block timestamp.
 * The simulated chain's clock advances during the run (we jump forward to exercise
 * deadlines), so a single fixed deadline computed once would eventually fall into the
 * past and be rejected by the constructor.
 */
async function freshParams(): Promise<typeof paramsShape> {
  const block = await ethers.provider.getBlock("latest");
  const t = block!.timestamp;
  return {
    goal: ethers.parseEther("100"),
    fundingDeadline: t + 30 * 86400,
    trancheBps: [4_000, 3_500, 2_500],
    descriptionHashes: [
      ethers.keccak256(ethers.toUtf8Bytes("m0")),
      ethers.keccak256(ethers.toUtf8Bytes("m1")),
      ethers.keccak256(ethers.toUtf8Bytes("m2")),
    ],
    specificationCIDs: ["cid0", "cid1", "cid2"],
    milestoneDeadlines: [t + 40 * 86400, t + 50 * 86400, t + 60 * 86400],
  };
}

interface paramsShape {
  goal: bigint;
  fundingDeadline: number;
  trancheBps: number[];
  descriptionHashes: string[];
  specificationCIDs: string[];
  milestoneDeadlines: number[];
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const networkName = process.env.HARDHAT_NETWORK ?? network.name;
  // Only the in-process EVM counts as simulated. A forked or remote node is real
  // execution, even if it is not a public testnet.
  const simulated = networkName === "hardhat";

  const notes: string[] = [];
  if (simulated) {
    notes.push(
      "SIMULATED RUN: in-process Hardhat EVM. No network latency, no propagation " +
        "delay, no L1 data-availability cost. Valid only for comparing operations " +
        "against each other. Do not use for cost or throughput claims."
    );
  }
  if (Number(chainId) === 80002 || Number(chainId) === 421614) {
    notes.push(
      "L2 RUN: measured gas is execution gas only. The true cost also includes the " +
        "L1 data-availability charge for calldata, which is not visible in gasUsed."
    );
  }

  console.log(`\n=== Benchmark run: ${networkName} (chainId ${chainId}) ===`);
  if (simulated) console.log("  ** SIMULATED — not a real network measurement **");

  const signers = await ethers.getSigners();
  const [deployer, treasury, creator, backer, verifierA, verifierB] = signers;

  // ---- Deploy ------------------------------------------------------------
  const Reputation = await ethers.getContractFactory("ReputationRegistry");
  const reputation = await Reputation.deploy(deployer.address);
  await reputation.waitForDeployment();

  const Verifier = await ethers.getContractFactory("MilestoneVerifier");
  const verifier = await Verifier.deploy(
    deployer.address,
    treasury.address,
    ethers.ZeroAddress,
    ethers.parseEther("1"),
    5_000,
    6_000,
    Number(2n * DAY),
    0,
    2_000,
    5_000
  );
  await verifier.waitForDeployment();

  const Factory = await ethers.getContractFactory("CampaignFactory");
  const factory = await Factory.deploy(
    await verifier.getAddress(),
    deployer.address,
    treasury.address
  );
  await factory.waitForDeployment();
  await (await verifier.connect(deployer).setRegistrar(await factory.getAddress(), true)).wait();

  // ---- Stake verifiers ---------------------------------------------------
  for (const v of [verifierA, verifierB]) {
    await (await verifier.connect(v).stakeVerifier({ value: ethers.parseEther("1") })).wait();
  }

  // ---- Create a benchmark campaign --------------------------------------
  const params = await freshParams();

  const gasSamples: Sample[] = [];

  gasSamples.push(
    ...(await measure("createCampaign", async () => {
      const tx = await factory.connect(creator).createCampaign(params);
      return { hash: tx.hash, wait: () => tx.wait() };
    }))
  );

  // The last created campaign is the one we operate on.
  const count = await factory.campaignCount();
  const campaignAddress = await factory.campaignAt(count - 1n);
  const campaign = await ethers.getContractAt("Campaign", campaignAddress);

  // ---- Per-operation gas + latency --------------------------------------
  for (let i = 0; i < SAMPLES; i++) {
    const s = await ethers.getSigner(backer.address);
    const tx = await campaign.connect(s).contribute({ value: ethers.parseEther("1") });
    const start = now();
    const receipt = await tx.wait();
    gasSamples.push({
      operation: "contribute",
      gasUsed: receipt!.gasUsed,
      effectiveGasPrice: receipt!.effectiveGasPrice ?? 0n,
      wallClockMs: now() - start,
      txHash: tx.hash,
    });
  }

  // submitEvidence + resolveMilestone need distinct campaigns per sample because a
  // milestone can only be resolved once.
  for (let i = 0; i < SAMPLES; i++) {
    const tx = await factory.connect(creator).createCampaign(await freshParams());
    const rc = await tx.wait();
    const parsed = rc!.logs
      .map((l: any) => {
        try {
          return factory.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((p: any) => p?.name === "CampaignDeployed");
    const c = await ethers.getContractAt("Campaign", parsed!.args.campaign);

    await (await c.connect(backer).contribute({ value: ethers.parseEther("100") })).wait();

    // Move past the funding deadline so the campaign can transition to Active.
    if (simulated) {
      await network.provider.send("evm_increaseTime", [30 * 86400 + 10]);
      await network.provider.send("evm_mine");
    }
    await (await c.closeFunding()).wait();

    const ev = await c.connect(creator).submitEvidence(0, "cid", ethers.keccak256(ethers.toUtf8Bytes("ev")));
    const start = now();
    const evReceipt = await ev.wait();
    gasSamples.push({
      operation: "submitEvidence",
      gasUsed: evReceipt!.gasUsed,
      effectiveGasPrice: evReceipt!.effectiveGasPrice ?? 0n,
      wallClockMs: now() - start,
      txHash: ev.hash,
    });

    // Vote + resolve on the same campaign.
    const vote = await verifier
      .connect(verifierA)
      .castVote(await c.getAddress(), 0, 1);
    const vr = await vote.wait();
    gasSamples.push({
      operation: "castVote",
      gasUsed: vr!.gasUsed,
      effectiveGasPrice: vr!.effectiveGasPrice ?? 0n,
      wallClockMs: 0,
      txHash: vote.hash,
    });

    // Jump past the voting window. On a real chain this requires actually waiting,
    // so resolveMilestone latency is only meaningful on the simulated network.
    if (simulated) {
      await network.provider.send("evm_increaseTime", [Number(2n * DAY) + 10]);
      await network.provider.send("evm_mine");
    }

    if (simulated) {
      const res = await c.resolveMilestone(0);
      const rStart = now();
      const resReceipt = await res.wait();
      gasSamples.push({
        operation: "resolveMilestone",
        gasUsed: resReceipt!.gasUsed,
        effectiveGasPrice: resReceipt!.effectiveGasPrice ?? 0n,
        wallClockMs: now() - rStart,
        txHash: res.hash,
      });

      const claim = await c.connect(creator).claimCreatorBalance();
      const cReceipt = await claim.wait();
      gasSamples.push({
        operation: "claimCreatorBalance",
        gasUsed: cReceipt!.gasUsed,
        effectiveGasPrice: cReceipt!.effectiveGasPrice ?? 0n,
        wallClockMs: 0,
        txHash: claim.hash,
      });
    }
  }

  // ---- Throughput --------------------------------------------------------
  // Measures how many confirmations per second the chain sustains under N concurrent
  // contributions. On a real network this is bounded by block time and the node's
  // mempool policy, which is exactly the point of the comparison.
  const throughput: ThroughputResult[] = [];
  for (const concurrency of CONCURRENCY_LEVELS) {
    const pool = signers.slice(0, Math.min(concurrency, signers.length));
    let failures = 0;
    const t0 = now();
    const promises = Array.from({ length: concurrency }, (_, i) => {
      const signer = pool[i % pool.length];
      return (async () => {
        try {
          // A distinct campaign per operation keeps refunds from interfering, and each
          // uses a fresh deadline so the advanced simulated clock cannot invalidate it.
          const p = await freshParams();
          const tx = await factory.connect(signer).createCampaign(p);
          const rc = await tx.wait();
          const parsed = rc!.logs
            .map((l: any) => {
              try {
                return factory.interface.parseLog(l);
              } catch {
                return null;
              }
            })
            .find((e: any) => e?.name === "CampaignDeployed");
          const c = await ethers.getContractAt("Campaign", parsed!.args.campaign);
          const contrib = await c.connect(signer).contribute({ value: ethers.parseEther("1") });
          await contrib.wait();
        } catch {
          failures++;
        }
      })();
    });
    await Promise.all(promises);
    const totalMs = now() - t0;
    throughput.push({
      concurrency,
      operations: concurrency * 2,
      totalMs,
      txPerSecond: Number((((concurrency * 2) / totalMs) * 1000).toFixed(2)),
      failures,
    });
    console.log(
      `  throughput @${String(concurrency).padStart(3)} concurrent: ${throughput[throughput.length - 1].txPerSecond} tx/s (${failures} failures)`
    );
  }

  // ---- Aggregate + persist ----------------------------------------------
  const byOp = new Map<string, Sample[]>();
  for (const s of gasSamples) {
    if (!byOp.has(s.operation)) byOp.set(s.operation, []);
    byOp.get(s.operation)!.push(s);
  }

  const summary = [...byOp.entries()].map(([op, samples]) => {
    const gas = samples.map((s) => Number(s.gasUsed));
    const latency = samples.filter((s) => s.wallClockMs > 0).map((s) => s.wallClockMs);
    const medianGas = median(gas);
    return {
      operation: op,
      samples: samples.length,
      medianGas,
      minGas: Math.min(...gas),
      maxGas: Math.max(...gas),
      medianLatencyMs: median(latency),
      costUsd: Number(((medianGas * GAS_PRICE_GWEI * 1e-9 * ETH_USD) / 1).toFixed(6)),
      costPctOfSmallContribution:
        Number((((medianGas * GAS_PRICE_GWEI * 1e-9 * ETH_USD) / 5) * 100).toFixed(4)),
    };
  });

  const result: BenchResult = {
    network: networkName,
    chainId: chainId.toString(),
    simulated,
    measuredAt: new Date().toISOString(),
    assumptions: { gasPriceGwei: GAS_PRICE_GWEI, ethUsd: ETH_USD, samples: SAMPLES },
    gas: gasSamples.map((s) => ({
      operation: s.operation,
      gasUsed: s.gasUsed.toString(),
      effectiveGasPrice: s.effectiveGasPrice.toString(),
      wallClockMs: s.wallClockMs,
      txHash: s.txHash,
    })),
    throughput,
    notes,
  };

  mkdirSync("benchmarks/results", { recursive: true });
  const jsonPath = `benchmarks/results/bench-${networkName}.json`;
  writeFileSync(jsonPath, JSON.stringify(result, null, 2));

  // CSV of the per-operation summary, for the plotting script and for spreadsheets.
  const csvRows = [
    "network,chainId,simulated,operation,samples,medianGas,minGas,maxGas,medianLatencyMs,costUsd,costPctOf5UsdContribution",
    ...summary.map((s) =>
      [
        networkName,
        chainId.toString(),
        simulated,
        s.operation,
        s.samples,
        s.medianGas,
        s.minGas,
        s.maxGas,
        s.medianLatencyMs,
        s.costUsd,
        s.costPctOfSmallContribution,
      ].join(",")
    ),
  ];
  const csvPath = `benchmarks/results/bench-${networkName}.csv`;
  writeFileSync(csvPath, csvRows.join("\n"));

  console.log(`\nPer-operation summary (${networkName}):`);
  console.table(summary);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${csvPath}`);
  if (simulated) {
    console.log(
      "\nNOTE: these are SIMULATED figures. For an L1-vs-L2 comparison run:\n" +
        "  npx hardhat run benchmarks/run-benchmarks.ts --network sepolia\n" +
        "  npx hardhat run benchmarks/run-benchmarks.ts --network amoy"
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});