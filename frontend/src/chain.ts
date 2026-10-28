/** Minimal browser wallet + contract bindings for the dApp. */
import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  Wallet,
  type Eip1193Provider,
  type Signer,
  keccak256,
} from "ethers";

export interface EthereumProvider extends Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export interface WalletConnection {
  provider: BrowserProvider;
  signer: Signer;
  address: string;
  chainId: number;
}

/** --- Wallet discovery (EIP-6963) ------------------------------------------
 *
 * MetaMask (and most EIP-1193 wallets) inject `window.ethereum`, but some
 * extension combinations live only behind the EIP-6963 `announceProvider`
 * handshake. When the synchronous injection is missing we dispatch the
 * standard request event and briefly collect announced providers before
 * concluding that no wallet is present.
 */
interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: EthereumProvider;
}

function walletNotDetectedMessage(): string {
  return (
    "No injected wallet was detected on this page. If MetaMask IS installed: " +
    "1) open this dashboard at http://localhost:5180 — wallet extensions do not " +
    "inject into plain-HTTP pages served from other hosts (e.g. http://192.168.x.x:5180), " +
    "2) reload the page after installing/enabling the extension (injection happens " +
    "on page load, not retroactively), and " +
    "3) confirm the extension is enabled in this browser window/profile."
  );
}

/** Returns the wallet provider to bind to, or null with a diagnostic. */
export async function resolveEthereumProvider(): Promise<{
  provider: EthereumProvider | null;
  walletName: string | null;
}> {
  if (window.ethereum) {
    return {
      provider: window.ethereum,
      walletName: (window.ethereum as { isMetaMask?: boolean }).isMetaMask
        ? "MetaMask"
        : "your injected wallet",
    };
  }

  const found: Eip6963ProviderDetail[] = [];
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
    if (detail?.info && detail?.provider) found.push(detail);
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // Wallets that announce asynchronously get a short window to respond.
  await new Promise((resolve) => setTimeout(resolve, 300));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);

  if (found.length === 0) return { provider: null, walletName: null };
  // MetaMask first when several wallets announce; otherwise the first one.
  const preferred = found.find((d) => /metamask/i.test(d.info.name)) ?? found[0];
  return { provider: preferred.provider, walletName: preferred.info.name };
}

export async function connectWallet(): Promise<WalletConnection> {
  const { provider } = await resolveEthereumProvider();
  if (!provider) {
    throw new Error(walletNotDetectedMessage());
  }
  const browserProvider = new BrowserProvider(provider);
  await browserProvider.send("eth_requestAccounts", []);
  const signer = await browserProvider.getSigner();
  const address = await signer.getAddress();
  const network = await browserProvider.getNetwork();
  return { provider: browserProvider, signer, address, chainId: Number(network.chainId) };
}

/** Switches to the configured chain, adding the local Hardhat chain if necessary. */
export async function ensureChain(chainId: number, rpcUrl = "http://127.0.0.1:8545"): Promise<void> {
  const { provider } = await resolveEthereumProvider();
  if (!provider) throw new Error(walletNotDetectedMessage());
  const hex = `0x${chainId.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hex }],
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: chainId === 31337 ? "Hardhat Local" : `Chain ${chainId}`,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [rpcUrl],
        },
      ],
    });
  }
}

/* Human-readable ABIs: only the functions the dApp actually calls are exposed. */
const CAMPAIGN_ABI = [
  "function contribute() payable",
  "function submitEvidence(uint256 index, string evidenceCID, bytes32 evidenceHash)",
  "function resolveMilestone(uint256 index)",
  "function claimRefund()",
  "function claimCreatorBalance()",
  "function state() view returns (uint8)",
  "function creator() view returns (address)",
  "function goal() view returns (uint256)",
  "function totalContributed() view returns (uint256)",
  "function totalReleased() view returns (uint256)",
  "function milestoneCount() view returns (uint256)",
  "function getMilestone(uint256 index) view returns (tuple(bytes32 descriptionHash, string specificationCID, uint16 trancheBps, uint64 deadline, uint8 state, bytes32 evidenceHash, string evidenceCID, uint64 submittedAt, uint64 resolvedAt))",
];

const VERIFIER_ABI = [
  "function castVote(address campaign, uint256 index, uint8 choice)",
  "function getRound(address campaign, uint256 index) view returns (tuple(uint64 openedAt, uint64 voteDeadline, bool closed, bool settled, uint64 oracleSubmitted, uint8 outcome, uint128 approveWeight, uint128 rejectWeight, uint128 oracleWeightCast, uint128 votedWeight, uint128 activeStakeAtOpen, uint256 rewardPoolShare, uint128 correctWeight, uint128 incorrectWeight))",
  "function getVerifier(address verifier) view returns (tuple(uint128 stake, bool active, uint256 rewardDebt, uint64 joinedAt))",
];

const DISPUTE_ABI = [
  "function raiseDispute(address campaign, uint256 milestoneIndex) payable",
  "function resolve(bytes32 disputeKey)",
  "function disputeBond() view returns (uint256)",
  "function votingWindow() view returns (uint64)",
  "function getDispute(bytes32 key) view returns (tuple(address campaign, uint256 milestoneIndex, address raiser, uint64 raisedAt, uint64 voteDeadline, uint128 forRefundWeight, uint128 forCreatorWeight, uint128 votedWeight, uint8 state, uint8 outcome, uint16 partialBps, uint256 bondEscrowed, uint256 raiserBond, uint256 rewardPool, bool bondsSettled))",
];

const REPUTATION_ABI = [
  "function scoreOf(address subject) view returns (uint256)",
  "function tierOf(address subject) view returns (uint8)",
];

const FACTORY_ABI = [
  "function createCampaign(tuple(uint256 goal, uint64 fundingDeadline, uint16[] trancheBps, bytes32[] descriptionHashes, string[] specificationCIDs, uint64[] milestoneDeadlines, address treasury)) returns (address)",
  "function campaignCount() view returns (uint256)",
  "function campaignAt(uint256 index) view returns (address)",
];

export interface ContractAddresses {
  factory: string | null;
  verifier: string | null;
  disputes: string | null;
  credentials: string | null;
  reputation: string | null;
}

export function campaignContract(address: string, signer: Signer): Contract {
  return new Contract(address, CAMPAIGN_ABI, signer);
}

export function verifierContract(address: string, signer: Signer): Contract {
  return new Contract(address, VERIFIER_ABI, signer);
}

export function disputeContract(address: string, signer: Signer): Contract {
  return new Contract(address, DISPUTE_ABI, signer);
}

export function reputationContract(address: string, provider: BrowserProvider | JsonRpcProvider): Contract {
  return new Contract(address, REPUTATION_ABI, provider);
}

export function factoryContract(address: string, signer: Signer): Contract {
  return new Contract(address, FACTORY_ABI, signer);
}

/** keccak256 of the raw file bytes, matching Campaign.submitEvidence's evidenceHash. */
export async function hashFile(file: File): Promise<string> {
  return keccak256(new Uint8Array(await file.arrayBuffer()));
}

/** --- Local demo-account mode ----------------------------------------------
 *
 * Bypasses injected wallets entirely: signs with Hardhat's well-known account
 * #0 private key (the first key `npx hardhat node` prints, pre-funded with
 * 10,000 fake ETH on chain 31337). Utterly unsafe on any real network — the
 * key is public — but ideal for local demonstration without MetaMask.
 */
const DEMO_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/** Adapts an ethers JsonRpcProvider into the minimal EIP-1193 surface BrowserProvider wants. */
function asInjected(provider: JsonRpcProvider): Eip1193Provider {
  return {
    request: (args) =>
      provider.send(args.method, (args.params ?? []) as Array<unknown>),
  };
}

export async function connectDemoWallet(
  rpcUrl = "http://127.0.0.1:8545"
): Promise<WalletConnection> {
  const rpc = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true });
  const wallet = new Wallet(DEMO_PRIVATE_KEY, rpc);
  return {
    provider: new BrowserProvider(asInjected(rpc)),
    signer: wallet,
    address: await wallet.getAddress(),
    chainId: 31337,
  };
}
