/**
 * Chain client: typed access to the deployed contracts.
 *
 * ABIs are loaded from the Hardhat build artifacts at runtime rather than hardcoded
 * here. A hand-copied ABI drifts the moment a contract changes, and the failure mode is
 * silent: a mis-encoded event topic just yields zero events, so the indexer looks like it
 * is working while indexing nothing. Loading from `artifacts/` makes a contract change
 * immediately visible as a missing-method error instead.
 *
 * Contract addresses come from `deployments/<network>.json`, written by `scripts/deploy.ts`.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, ethers, type Provider, type Signer } from "ethers";

import { config } from "../config.js";

export const CONTRACTS = [
  "ReputationRegistry",
  "CredentialRegistry",
  "MilestoneVerifier",
  "DisputeResolution",
  "CampaignFactory",
  /**
   * `Campaign` is not a single address: the factory deploys one per campaign. It is
   * listed here so its ABI can be loaded for per-campaign instances. The indexer
   * instantiates these from addresses discovered in CampaignDeployed events rather than
   * from the deployment manifest.
   */
  "Campaign",
] as const;

export type ContractName = (typeof CONTRACTS)[number];

/**
 * Repo-root-relative paths, resolved from this file's location rather than the process
 * working directory. `path.resolve("../../x")` resolves against `process.cwd()`, which is
 * wherever the operator happened to launch the backend from — so the deployment
 * manifest and the ABIs silently fail to load whenever the backend is not started from
 * the repo root. Anchoring to `import.meta.url` makes this independent of cwd.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ARTIFACT_DIR = join(REPO_ROOT, "artifacts", "contracts");
const DEPLOYMENT_DIR = join(REPO_ROOT, "deployments");

/** Loads a contract ABI from the Hardhat artifact tree. */
export function loadAbi(name: ContractName): any[] {
  // Artifacts live under artifacts/contracts/<file>.sol/<Name>.sol/<Name>.json
  const candidates = [
    resolve(ARTIFACT_DIR, `${name}.sol`, `${name}.json`),
    resolve(ARTIFACT_DIR, "interfaces", "IOracleAdapter.sol", "IOracleAdapter.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")).abi;
    }
  }
  throw new Error(
    `ABI for ${name} not found under ${ARTIFACT_DIR}. Run \`npx hardhat compile\` first.`
  );
}

/** Returns a Contract bound to an explicit address, using the loaded ABI. */
export function contractAt(name: ContractName, address: string): Contract {
  return new Contract(address, loadAbi(name), cached?.provider ?? new ethers.JsonRpcProvider(config.RPC_URL));
}

export interface Deployment {
  chainId: string;
  network: string;
  deployer: string;
  treasury: string;
  contracts: Record<string, string>;
}

/** Reads the deployment manifest for a network, if it exists. */
export function loadDeployment(network = "hardhat"): Deployment | null {
  const path = resolve(DEPLOYMENT_DIR, `${network}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export interface ChainClient {
  provider: Provider;
  signer?: Signer;
  networkName: string;
  get(name: ContractName): Contract;
  at(name: ContractName, address: string): Contract;
  addresses: Record<string, string>;
  blockNumber(): Promise<number>;
}

let cached: ChainClient | null = null;

export function getChainClient(): ChainClient {
  if (cached) return cached;

  const provider = new ethers.JsonRpcProvider(config.RPC_URL, {
    chainId: config.CHAIN_ID,
    name: "configured-network",
  });

  const deployment = loadDeployment(config.NETWORK_NAME);
  const addresses: Record<string, string> = deployment?.contracts ?? {};

  // Env vars take precedence over the manifest so a deployment can be pointed at
  // without editing a file.
  const override: Partial<Record<ContractName, string | undefined>> = {
    ReputationRegistry: config.REPUTATION_ADDRESS,
    CredentialRegistry: config.CREDENTIALS_ADDRESS,
    MilestoneVerifier: config.VERIFIER_ADDRESS,
    DisputeResolution: config.DISPUTES_ADDRESS,
    CampaignFactory: config.FACTORY_ADDRESS,
  };
  for (const [key, value] of Object.entries(override)) {
    if (value) addresses[key] = value;
  }

  cached = {
    provider,
    networkName: deployment?.network ?? config.NETWORK_NAME,
    addresses,
    blockNumber: async () => Number(await provider.getBlockNumber()),
    get(name: ContractName): Contract {
      const address = addresses[name];
      if (!address) {
        throw new Error(
          `No address for ${name}. Deploy first (\`npx hardhat run scripts/deploy.ts\`) ` +
            `or set ${name.toUpperCase()}_ADDRESS.`
        );
      }
      return new Contract(address, loadAbi(name), provider);
    },
    at(name: ContractName, address: string): Contract {
      return new Contract(address, loadAbi(name), provider);
    },
  };

  return cached;
}

/** Resets the cached client. Used by tests. */
export function resetChainClient(): void {
  cached = null;
}