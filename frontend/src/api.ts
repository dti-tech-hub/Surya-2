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
  credentials: (subject: string) =>
    get<{
      data: { subject: string; credentials: unknown[]; canLaunchCampaign: boolean };
    }>(`/api/credentials/${subject}`),
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
