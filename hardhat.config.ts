import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "hardhat-gas-reporter";
import "solidity-coverage";

/**
 * Hardhat configuration.
 *
 * Network selection:
 *  - `hardhat`   : in-process EVM, used for the functional test suite and benchmarks.
 *  - `sepolia`   : Ethereum L1 testnet  (chainId 11155111).
 *  - `amoy`      : Polygon Amoy L2 testnet (chainId 80002). Note: Polygon Mumbai is
 *                  deprecated/sunset, Amoy is its current replacement.
 *  - `arbitrumSepolia` : Arbitrum Sepolia L2 testnet (chainId 421614).
 *
 * All RPC URLs and keys are read from the environment; no secrets live in this file.
 */
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // viaIR removes the EVM stack-depth limit, which the solidity-coverage
      // instrumentation hits on DisputeResolution.settleJuror (it adds stack pressure
      // that the plain build tolerates). Compile time increases, output is equivalent.
      // Documented in docs/DECISIONS.md (D-011).
      viaIR: true,
    },
  },
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      chainId: 31337,
      blockGasLimit: 30_000_000,
      allowUnlimitedContractSize: false,
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? "",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 11155111,
    },
    amoy: {
      url: process.env.AMOY_RPC_URL ?? "",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 80002,
    },
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL ?? "",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 421614,
    },
  },
  paths: {
    sources: "contracts",
    tests: "test",
    cache: "cache",
    artifacts: "artifacts",
  },
  mocha: {
    timeout: 120_000,
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    // Gas price assumptions are stated explicitly in benchmarks/README.md.
    gasPrice: Number(process.env.GAS_REPORT_GAS_PRICE ?? 20),
    token: "ETH",
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY ?? "",
      sepolia: process.env.ETHERSCAN_API_KEY ?? "",
      arbitrumSepolia: process.env.ARBISCAN_API_KEY ?? "",
    },
  },
};

export default config;