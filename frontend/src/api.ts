/** Typed client for the backend Express API (http://127.0.0.1:4000). */

const API_BASE: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_API_URL ?? "http://127.0.0.1:4000";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json as { error?: string }).error ?? `${path} -> HTTP ${res.status}`);
  }
  return json as T;
}

export interface EvidenceUpload {
  cid: string;
  provider: "pinata" | "local-ipfs" | "local-content-store";
  size: number;
  sha256: string;
  gatewayUrl: string;
  filename: string;
  contentType: string;
}

export interface AppConfig {
  chainId: number;
  network: string;
  contracts: {
    factory: string | null;
    verifier: string | null;
    disputes: string | null;
    credentials: string | null;
    reputation: string | null;
  };
  evidence: { provider: string; isIpfs: boolean; detail: string };
  mlService: string;
}

export interface CoverageMetric {
  total: number;
  covered: number;
  skipped: number;
  pct: number;
}

export interface CoverageEntry {
  statements: CoverageMetric;
  branches: CoverageMetric;
  functions: CoverageMetric;
  lines: CoverageMetric;
}

export type CoverageSummary = Record<string, CoverageEntry>;

export interface ResearchResults {
  benchmarks: {
    simulated: boolean;
    measuredAt: string;
    network: string;
    gas: Array<{ operation: string; gasUsed: string; wallClockMs: number }>;
    throughput: Array<{ concurrency: number; txPerSecond: number; failures: number }>;
    notes: string[];
  } | null;
  costModel: {
    generatedAt: string;
    deployedToTestnet: boolean;
    ratios: { gasPriceRatio: number; tokenPriceRatio: number; combinedCostRatio: number };
    networks: Array<{ label: string; gasPriceGweiUsed: number; gasPriceSource: string }>;
    operations: Array<{
      operation: string;
      medianGas: number;
      l1Usd: number;
      l2Usd: number;
      l2OverL1Pct: number;
    }>;
    caveats: string[];
  } | null;
  ml: {
    dataset: { n_samples: number; fraud_rate: number; synthetic: boolean };
    isolation_forest: Record<string, number>;
    random_forest: Record<string, number>;
    logistic_regression: Record<string, number>;
  } | null;
  attacks: {
    simulated: boolean;
    results: Array<{
      id: string;
      name: string;
      conclusion: string;
      limitations: string;
      parameters: Record<string, unknown>;
      observed: Record<string, unknown>;
    }>;
  } | null;
  coverage: CoverageSummary | null;
  provenance: Record<string, { path: string; label: string }>;
  survey: { status: string; path: string; detail: string };
}

export interface RiskBadge {
  score: number;
  band: string;
}

export interface CampaignSummary {
  address: string;
  creator: string;
  goalWei: string;
  fundingDeadline: number;
  state: string;
  totalContributed: string;
  totalReleased: string;
  releasedBps: number;
  createdAt: number;
  risk: RiskBadge | null;
  // Humanized fields
  title?: string;
  category?: string;
  creatorName?: string;
  tagline?: string;
}

export interface CampaignDetail extends CampaignSummary {
  milestones: unknown[];
  disputes: unknown[];
  votesByMilestone: unknown[];
  contributors: number;
  risk: RiskBadge | null;
}

export interface StatsData {
  campaigns: number;
  byState: Record<string, number>;
  totalRaisedWei: string;
}

export interface IndexerStatus {
  running: boolean;
  chainId: number;
  headBlock: number;
  confirmedThrough: number;
  confirmations: number;
  cursors: Record<string, number>;
  lastPollAt: number;
  lastError: string | null;
  eventsIndexed: number;
}

export interface ReadyChecks {
  ready: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export const api = {
  base: API_BASE,
  ready: () => get<ReadyChecks>("/health/ready"),
  campaigns: () => get<{ data: CampaignSummary[] }>("/api/campaigns"),
  campaign: (address: string) => get<{ data: CampaignDetail }>(`/api/campaigns/${address}`),
  stats: () => get<{ data: StatsData }>("/api/stats"),
  indexer: () => get<{ data: IndexerStatus }>("/api/indexer/status"),
  config: () => get<{ data: AppConfig }>("/api/config"),
  research: () => get<{ data: ResearchResults }>("/api/research/results"),
  reputation: (subject: string) => get<{ data: unknown }>(`/api/reputation/${subject}`),
  did: (address: string) => get<{ data: unknown }>(`/api/identity/${address}/did`),
  issueCredential: (body: {
    subject: string;
    schemaType: string;
    claims?: Record<string, unknown>;
    expiresInDays?: number;
    attestOnChain?: boolean;
  }) => post<{ data: unknown }>("/api/identity/credentials", body),
  credentialStatus: (subject: string) =>
    get<{
      data: { subject: string; credentials: unknown[]; canLaunchCampaign: boolean };
    }>(`/api/credentials/${subject}`),
  uploadEvidence: async (file: File): Promise<{ data: EvidenceUpload }> => {
    const res = await fetch(`${API_BASE}/api/evidence`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": file.name,
        "x-content-type": file.type || "application/octet-stream",
      },
      body: await file.arrayBuffer(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((json as { error?: string }).error ?? `upload -> HTTP ${res.status}`);
    }
    return json as { data: EvidenceUpload };
  },
};

/** 1 ETH = 1e18 wei. BigInt-safe formatter (never Number() on wei strings). */
export function formatEth(wei: string | number | bigint): string {
  const w = BigInt(wei.toString());
  const whole = w / 1_000_000_000_000_000_000n;
  const frac = ((w % 1_000_000_000_000_000_000n) / 1_000_000_000_000_000n)
    .toString()
    .padStart(3, "0");
  return `${whole.toString()}.${frac} ETH`;
}

export function formatTime(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString();
}
