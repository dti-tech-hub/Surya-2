# Benchmarks and Cost Model

This directory contains the reproducible measurement harness and its generated artifacts.
Read the evidence labels before quoting any number.

## What is measured, and what is not

| Measurement | Label | Where |
|---|---|---|
| EVM gas per operation, 5 samples, median | `MEASURED` (local EVM) | `results/bench-hardhat.json` |
| In-process throughput at 10/50/100 concurrency | `SIMULATED` (local EVM) | `results/bench-hardhat.json` |
| USD cost from measured gas × assumed gas price × assumed token price | `SIMULATED` | `results/l1-vs-l2-comparison.json` |
| Public-testnet latency, throughput, and L1 data-availability cost | `NOT YET MEASURED` | — |

Gas is a property of bytecode, calldata, and the active gas schedule. Values measured on the
local Hardhat EVM therefore apply to other EVMs using the same schedule. Latency, throughput,
and data-availability cost **do not transfer**: the in-process EVM has no network propagation
delay, no block-building competition, and no L1 calldata posting.

No public testnet deployment has been performed. `deployedToTestnet` is `false` in the cost
model, and it must stay `false` until a funded deployer key is actually used.

## Commands

```bash
# Gas samples and local throughput (writes results/bench-hardhat.json + .csv)
npx hardhat run benchmarks/run-benchmarks.ts

# Cost model over the measured gas values (writes results/l1-vs-l2-comparison.json + .csv).
# A bare run uses live eth_gasPrice and refuses implausible values; this invocation
# records the assumptions behind the checked-in artifact.
BENCH_L1_GWEI=10 BENCH_L2_GWEI=30 BENCH_ETH_USD=2500 BENCH_POL_USD=0.5 \
  npx hardhat run benchmarks/compare-l1-l2.ts
```

On PowerShell, set the four variables first, e.g.
`$env:BENCH_L1_GWEI="10"; $env:BENCH_L2_GWEI="30"; $env:BENCH_ETH_USD="2500";
$env:BENCH_POL_USD="0.5"`.

The harness talks to the chain through ethers directly. It does not start the backend, the
SQLite indexer, or the frontend, so its latency numbers are chain-side only.

## Canonical artifacts

`results/bench-hardhat.json` is the authoritative gas artifact consumed by the backend
research route and the dashboard. `results/l1-vs-l2-comparison.json` is the authoritative
cost model. Regenerating either command replaces these files.

`results/bench-hardhat-run1.json`, `run2.json`, and `run3.json` are earlier replicate runs kept
for history. They are not consumed by the application and are not the values quoted in the
paper reference.

## Cost-model assumptions

The comparison uses:

- Ethereum Sepolia (L1): **10 gwei**, ETH **$2,500**
- Polygon Amoy (L2): **30 gwei**, POL **$0.50**
- Combined gas-price × token-price ratio: **1,666.6667×**

These are operator assumptions, not live oracle readings. The L2 column **excludes the L1
data-availability charge**, which is often the dominant rollup cost. The model therefore
supports a relative comparison, not a claim that L2 is 1,666.67× cheaper in practice.

Separately, `hardhat.config.ts` configures the `hardhat-gas-reporter` plugin with a
display-only price of 20 gwei (overridable via `GAS_REPORT_GAS_PRICE`). That plugin's console
table is a developer convenience; it is not the source of the values above.

## Raw local logs

`results/gas-report-*.txt` and `results/coverage-local.txt` are raw console logs from ad-hoc
local runs. They are git-ignored, may predate the current contracts, and are not authoritative.
In particular, `gas-report-local-viaIR-false-legacy.txt` records an early 26-test build with
`viaIR: false`. Use `results/bench-hardhat.json` and `coverage/coverage-summary.json` instead.
