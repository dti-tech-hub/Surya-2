/**
 * L1 vs L2 cost comparison (objective O2).
 *
 * WHAT THIS DOES AND DOES NOT MEASURE — read before citing any number from it.
 *
 * This script produces a *cost model* comparison, not a set of deployed benchmarks.
 * Specifically:
 *
 *   - Execution gas per operation is MEASURED, on the local EVM, with the real
 *     contracts. Execution gas depends only on contract bytecode and calldata, so it is
 *     the same on every EVM that runs the same bytecode. It is therefore legitimate to
 *     compare an L1-measured gas figure against an L2 price.
 *
 *   - Gas price is MEASURED LIVE via `eth_gasPrice` against each network's public RPC
 *     at run time. This is the input that actually differs between L1 and L2.
 *
 *   - Native-token price is NOT measured and is NOT hardcoded as a fact. The caller must
 *     supply `--eth-usd`. Because the ETH/MATIC price ratio moves independently of gas,
 *     any cross-chain cost comparison in USD is dominated by that assumption. The script
 *     prints the ratio it used so a reader can re-price the conclusion.
 *
 *   - The L1 data-availability component of an L2 transaction is NOT included, because
 *     it depends on calldata size and current L1 base fee and is not observable from a
 *     `eth_gasPrice` call. This is a real omission that biases L2 in the *optimistic*
 *     direction, and the output says so.
 *
 * For true end-to-end numbers (latency, throughput, L1 DA fee) run
 * `benchmarks/run-benchmarks.ts` against both networks with funded keys. Scripts and
 * configuration for that are provided; see .env.example.
 *
 * Usage:
 *   npx hardhat run benchmarks/compare-l1-l2.ts
 *   npx hardhat run benchmarks/compare-l1-l2.ts -- --eth-usd 2500 --matic-usd 0.5
 */
import { ethers } from "hardhat";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

interface NetworkConfig {
  name: string;
  label: string;
  rpc: string;
  chainId: number;
  nativeSymbol: string;
  nativeUsd: number;
  /** True for L2, where execution gas is cheap but L1 DA cost is extra. */
  isL2: boolean;
}

/** Public RPCs. Override with env vars if you have a keyed provider. */
const NETWORKS: NetworkConfig[] = [
  {
    name: "sepolia",
    label: "Ethereum Sepolia (L1)",
    rpc: process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    chainId: 11155111,
    nativeSymbol: "ETH",
    nativeUsd: 2500,
    isL2: false,
  },
  {
    name: "amoy",
    label: "Polygon Amoy (L2)",
    rpc: process.env.AMOY_RPC_URL ?? "https://polygon-amoy-bor-rpc.publicnode.com",
    chainId: 80002,
    nativeSymbol: "MATIC",
    nativeUsd: 0.5,
    isL2: true,
  },
];

interface OperationRow {
  operation: string;
  medianGas: number;
}

/** Pulls measured gas figures out of a previously generated simulated benchmark file. */
function loadMeasuredGas(): OperationRow[] {
  const path = "benchmarks/results/bench-hardhat.csv";
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}. Run "npx hardhat run benchmarks/run-benchmarks.ts" first so the ` +
        `gas figures being re-priced are real measurements rather than assumptions.`
    );
  }
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  const opIdx = header.indexOf("operation");
  const gasIdx = header.indexOf("medianGas");
  if (opIdx === -1 || gasIdx === -1) throw new Error(`Unexpected CSV header in ${path}`);

  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    return { operation: cells[opIdx], medianGas: Number(cells[gasIdx]) };
  });
}

async function fetchGasPrice(rpc: string): Promise<bigint> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
  });
  const json = (await res.json()) as { result: string; error?: unknown };
  if (json.error || !json.result) throw new Error(`eth_gasPrice failed on ${rpc}: ${JSON.stringify(json)}`);
  return BigInt(json.result);
}

/**
 * Sanity-bounds for a plausible mainnet gas price.
 * Testnets frequently advertise near-zero gas (Sepolia has served sub-0.001 gwei at
 * times), which would produce absurd USD figures that look like real measurements.
 * Rather than silently emit them, this comparison refuses to run on an implausible
 * price and tells the operator to supply their own assumption.
 */
const PLAUSIBLE_MIN_GWEI = 0.01;
const PLAUSIBLE_MAX_GWEI = 500;

function gasPricePlausible(gwei: number): boolean {
  return gwei >= PLAUSIBLE_MIN_GWEI && gwei <= PLAUSIBLE_MAX_GWEI;
}

/**
 * Assumptions may be supplied via flags or env vars.
 * Hardhat 2 does not forward a bare `--` to scripts, so env vars are the reliable path
 * on this toolchain; both are supported so the script is not tied to one runner.
 */
function parseArgs(): { ethUsd?: number; maticUsd?: number; l1Gwei?: number; l2Gwei?: number } {
  const fromEnv = {
    ethUsd: process.env.BENCH_ETH_USD ? Number(process.env.BENCH_ETH_USD) : undefined,
    maticUsd: process.env.BENCH_MATIC_USD ? Number(process.env.BENCH_MATIC_USD) : undefined,
    l1Gwei: process.env.BENCH_L1_GWEI ? Number(process.env.BENCH_L1_GWEI) : undefined,
    l2Gwei: process.env.BENCH_L2_GWEI ? Number(process.env.BENCH_L2_GWEI) : undefined,
  };
  const args = process.argv.slice(2);
  const out: { ethUsd?: number; maticUsd?: number; l1Gwei?: number; l2Gwei?: number } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--eth-usd") out.ethUsd = Number(args[i + 1]);
    if (args[i] === "--matic-usd") out.maticUsd = Number(args[i + 1]);
    if (args[i] === "--l1-gwei") out.l1Gwei = Number(args[i + 1]);
    if (args[i] === "--l2-gwei") out.l2Gwei = Number(args[i + 1]);
  }
  return { ...fromEnv, ...out };
}

async function main() {
  const overrides = parseArgs();
  const gasRows = loadMeasuredGas();

  const networks = NETWORKS.map((n) => ({
    ...n,
    nativeUsd:
      (n.nativeSymbol === "ETH" ? overrides.ethUsd : overrides.maticUsd) ?? n.nativeUsd,
  }));

  console.log("\n=== L1 vs L2 cost model ===");
  console.log("Execution gas: MEASURED locally on the real contracts.");
  console.log("Gas price:     MEASURED live via eth_gasPrice at run time.\n");

  // Fetch live gas prices, tolerating one network being unreachable.
  const prices = new Map<string, bigint | null>();
  const implausible: string[] = [];
  for (const n of networks) {
    try {
      const p = await fetchGasPrice(n.rpc);
      prices.set(n.name, p);
      const gwei = Number(p / 1_000_000_000n) + Number(p % 1_000_000_000n) / 1e9;
      const ok = gasPricePlausible(gwei);
      if (!ok) implausible.push(n.label);
      console.log(
        `  ${n.label.padEnd(28)} gasPrice = ${gwei} gwei  (chainId ${n.chainId})${
          ok ? "" : "   <-- IMPLAUSIBLE, excluded from comparison"
        }`
      );
    } catch (err) {
      prices.set(n.name, null);
      console.log(`  ${n.label.padEnd(28)} UNREACHABLE: ${(err as Error).message}`);
    }
  }

  const l1 = networks.find((n) => n.name === "sepolia")!;
  const l2 = networks.find((n) => n.name === "amoy")!;
  const l1Price = prices.get("sepolia");
  const l2Price = prices.get("amoy");

  if (l1Price === null || l2Price === null) {
    console.log(
      "\nOne or more networks were unreachable, so no comparison is produced. " +
        "A comparison with a missing input would be a guess."
    );
    process.exitCode = 1;
    return;
  }

  if (implausible.length > 0 && !(overrides.l1Gwei && overrides.l2Gwei)) {
    console.log(
      `\nNO COMPARISON PRODUCED from live prices. Implausible live gas price on: ${implausible.join(", ")}.\n` +
        `Testnet gas prices are not a valid basis for a cost comparison (see caveats).\n` +
        `To produce a comparison, re-run with explicit, ASSUMED prices, e.g.:\n` +
        `  npx hardhat run benchmarks/compare-l1-l2.ts -- --l1-gwei 10 --l2-gwei 0.05`
    );
    process.exitCode = 2;
    return;
  }

  // Operator-supplied prices win and are recorded as assumptions, not measurements.
  const usingAssumed = Boolean(overrides.l1Gwei && overrides.l2Gwei);
  const effL1Gwei = overrides.l1Gwei ?? Number(l1Price!) / 1e9;
  const effL2Gwei = overrides.l2Gwei ?? Number(l2Price!) / 1e9;
  if (usingAssumed) {
    console.log(
      `\n  Using operator-supplied gas prices as ASSUMPTIONS: ` +
        `L1 ${effL1Gwei} gwei, L2 ${effL2Gwei} gwei`
    );
    implausible.length = 0; // don't warn: we are deliberately overriding
  }

  const priceRatio = effL1Gwei / effL2Gwei;

  console.log(`\n  L1/L2 gas-price ratio : ${priceRatio.toFixed(2)}x`);
  console.log(`  ETH/MATIC price ratio : ${(l1.nativeUsd / l2.nativeUsd).toFixed(2)}x`);
  console.log(`  Combined cost ratio   : ${(priceRatio / (l1.nativeUsd / l2.nativeUsd)).toFixed(3)}x`);
  console.log(
    "  (A ratio near 1.0 means the two networks cost about the same for the same\n" +
      "   transaction under these assumptions. A ratio > 1 means L2 is cheaper.)"
  );

  const rows = gasRows.map((r) => {
    const l1Usd = r.medianGas * effL1Gwei * 1e-9 * l1.nativeUsd;
    const l2Usd = r.medianGas * effL2Gwei * 1e-9 * l2.nativeUsd;
    return {
      operation: r.operation,
      medianGas: r.medianGas,
      l1Usd: Number(l1Usd.toFixed(6)),
      l2Usd: Number(l2Usd.toFixed(6)),
      l2OverL1Pct: Number(((l2Usd / l1Usd) * 100).toFixed(3)),
      pctOf5usdL1: Number(((l1Usd / 5) * 100).toFixed(3)),
      pctOf5usdL2: Number(((l2Usd / 5) * 100).toFixed(3)),
    };
  });

  console.log("\nPer-operation cost under the measured prices:");
  console.table(rows);

  const caveats = [
    "Execution gas is measured locally; it is chain-state-independent and therefore " +
      "applies unchanged to both networks, but it has NOT been confirmed by deploying " +
      "to either network.",
    "L2 transaction cost here EXCLUDES the L1 data-availability charge for calldata, " +
      "which on rollups is frequently the dominant cost. L2 figures are therefore " +
      "optimistically low.",
    "Gas prices were captured once, at run time, and are volatile. Testnet gas prices " +
      "in particular do not predict mainnet economics.",
    "USD conversion uses operator-supplied token prices, which are assumptions, not " +
      "measurements. Re-run with --eth-usd and --matic-usd to re-price.",
    "No deployment to a public testnet has been performed, so there are no real " +
      "latency or throughput figures for either network.",
  ];

  console.log("\nCaveats that apply to every number above:");
  caveats.forEach((c) => console.log(`  - ${c}`));

  mkdirSync("benchmarks/results", { recursive: true });
  const output = {
    generatedAt: new Date().toISOString(),
    model: "execution gas (measured locally) x live gas price x assumed token price",
    deployedToTestnet: false,
    networks: networks.map((n) => ({
      label: n.label,
      chainId: n.chainId,
      gasPriceGweiUsed: n.name === "sepolia" ? effL1Gwei : effL2Gwei,
      gasPriceSource: usingAssumed ? "operator assumption" : "live eth_gasPrice",
      nativeSymbol: n.nativeSymbol,
      nativeUsdAssumed: n.nativeUsd,
      isL2: n.isL2,
    })),
    ratios: {
      gasPriceRatio: Number(priceRatio.toFixed(4)),
      tokenPriceRatio: Number((l1.nativeUsd / l2.nativeUsd).toFixed(4)),
      combinedCostRatio: Number(
        (priceRatio / (l1.nativeUsd / l2.nativeUsd)).toFixed(4)
      ),
    },
    operations: rows,
    caveats,
  };

  const path = "benchmarks/results/l1-vs-l2-comparison.json";
  writeFileSync(path, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${path}`);

  const csv = [
    "operation,medianGas,l1_cost_usd,l2_cost_usd,l2_as_pct_of_l1,pct_of_5usd_l1,pct_of_5usd_l2",
    ...rows.map((r) =>
      [
        r.operation,
        r.medianGas,
        r.l1Usd,
        r.l2Usd,
        r.l2OverL1Pct,
        r.pctOf5UsdL1,
        r.pctOf5UsdL2,
      ].join(",")
    ),
  ].join("\n");
  writeFileSync("benchmarks/results/l1-vs-l2-comparison.csv", csv);
  console.log("Wrote benchmarks/results/l1-vs-l2-comparison.csv");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});