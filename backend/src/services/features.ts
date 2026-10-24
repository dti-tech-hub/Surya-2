/**
 * Feature extraction for the ML service.
 *
 * Computes the feature vector the ML service expects from data this backend has indexed.
 * The ML service deliberately does not read the database itself (see mlClient.ts), so
 * every feature is derived here and shipped over HTTP.
 *
 * FEATURE SEMANTICS (these map to `ml-service/train.py::NUMERIC_FEATURES`):
 *   creator_reputation       on-chain reputation score (0-100), or 0 if unreadable
 *   backer_count             distinct contributing addresses
 *   funding_velocity         fraction of funds raised in the first quarter of the
 *                            campaign's life; a burst indicates manufactured support
 *   contributor_clustering   fraction of backers contributing within the same short
 *                            window of each other (a Sybil proxy)
 *   amount_cv                coefficient of variation of contribution sizes; a very low
 *                            value suggests one actor splitting a wallet
 *   repeated_funder_ratio    share of this campaign's backers who also backed another
 *                            campaign
 *   evidence_delay           fraction of a milestone's window elapsed at submission
 *   evidence_count           milestones with submitted evidence
 *   funding_ratio            raised / goal, clamped
 *   dispute_history          disputes raised against this campaign
 *   text_similarity          mean TF-IDF cosine similarity of the description to the
 *                            rest of the corpus; supplied by the ML service when it can
 *                            compute it over a batch, otherwise 0
 *
 * MISSING DATA POLICY: a feature that cannot be computed is emitted as 0.0 rather than
 * omitted, so the vector shape is always stable. A young campaign legitimately has zeros
 * for evidence and disputes, and zeros are meaningful there.
 */
import { getDb } from "../db/client.js";
import {
  campaignRepository,
  contributionRepository,
  disputeRepository,
  milestoneRepository,
  type Row,
} from "../db/repositories.js";
import { config } from "../config.js";

export interface CampaignFeatures {
  campaign_id: string;
  goal_usd: number;
  age_days: number;
  creator_reputation: number;
  backer_count: number;
  funding_velocity: number;
  contributor_clustering: number;
  amount_cv: number;
  repeated_funder_ratio: number;
  evidence_delay: number;
  evidence_count: number;
  funding_ratio: number;
  dispute_history: number;
  text_similarity: number;
  description: string;
}

/** Mean of a list, or 0. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Coefficient of variation. 0 when undefined (single sample or zero variance). */
function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  if (m === 0) return 0;
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance) / m;
}

/**
 * Builds the feature vector for a campaign from indexed rows.
 *
 * `reputationLookup` is injected rather than imported so this stays a pure function of
 * its inputs and can be tested without a chain connection.
 */
export function extractFeatures(
  campaign: Row,
  contributions: Row[],
  milestones: Row[],
  disputes: Row[],
  nowSeconds: number,
  reputationLookup: (address: string) => number = () => 0
): CampaignFeatures {
  const goal = BigInt(campaign.goal_wei || "0");
  const createdAt = Number(campaign.created_at || nowSeconds);
  const ageDays = Math.max(0, (nowSeconds - createdAt) / 86_400);

  // --- backers -------------------------------------------------------------
  const backers = new Set<string>();
  const amounts: number[] = [];
  const timestamps: number[] = [];
  for (const c of contributions) {
    backers.add(String(c.backer));
    amounts.push(Number(BigInt(c.amount_wei || "0")));
    timestamps.push(Number(c.block_time));
  }

  // --- funding velocity ---------------------------------------------------
  // Share of contributions landing in the earliest quarter of the campaign window.
  let fundingVelocity = 0;
  if (timestamps.length > 0) {
    const earliest = Math.min(...timestamps);
    const latest = Math.max(...timestamps);
    const span = latest - earliest;
    if (span > 0) {
      const quarter = earliest + span / 4;
      const early = contributions.filter((c) => Number(c.block_time) <= quarter).length;
      fundingVelocity = early / contributions.length;
    } else {
      // Everything landed in one block: maximal burst.
      fundingVelocity = contributions.length > 1 ? 1 : 0;
    }
  }

  // --- contributor clustering --------------------------------------------
  // Fraction of backers that contributed within a 600-second window of another backer.
  let clustering = 0;
  if (timestamps.length > 1) {
    const sorted = [...timestamps].sort((a, b) => a - b);
    let clustered = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] <= 600) clustered++;
    }
    clustering = clustered / sorted.length;
  }

  // --- repeated funders ----------------------------------------------------
  // Share of this campaign's backers who appear in any other campaign.
  let repeated = 0;
  if (backers.size > 0) {
    const placeholders = [...backers].map(() => "?").join(",");
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT DISTINCT backer FROM contributions
           WHERE chain_id = ? AND backer IN (${placeholders})
             AND campaign_address != ?
         )`
      )
      .get(config.CHAIN_ID, ...backers, campaign.address) as { n: number };
    repeated = Number(row.n) / backers.size;
  }

  // --- evidence ------------------------------------------------------------
  const submitted = milestones.filter(
    (m) => m.state === "Submitted" || m.state === "Verified"
  );
  const delays: number[] = [];
  for (const m of submitted) {
    const created = Number(m.submitted_at ?? 0);
    const deadline = Number(m.deadline ?? 0);
    const start = Number(campaign.funding_deadline ?? created);
    if (deadline > start && created >= start) {
      delays.push(Math.min(1, (created - start) / (deadline - start)));
    }
  }

  const total = BigInt(campaign.total_contributed || "0");
  const goalFloat = Number(goal);
  const fundingRatio = goalFloat > 0 ? Math.min(Number(total) / goalFloat, 1.5) : 0;

  return {
    campaign_id: String(campaign.address),
    goal_usd: goalFloat,
    age_days: round(ageDays),
    creator_reputation: round(reputationLookup(String(campaign.creator))),
    backer_count: backers.size,
    funding_velocity: round(fundingVelocity),
    contributor_clustering: round(clustering),
    amount_cv: round(coefficientOfVariation(amounts)),
    repeated_funder_ratio: round(repeated),
    evidence_delay: round(mean(delays)),
    evidence_count: submitted.length,
    funding_ratio: round(fundingRatio),
    dispute_history: disputes.length,
    // Computed by the ML service over a batch; single-campaign requests pass 0.
    text_similarity: 0,
    description: "",
  };
}

/** Convenience: gathers all rows for a campaign and extracts features. */
export function featuresForCampaign(
  address: string,
  nowSeconds: number,
  reputationLookup?: (address: string) => number
): CampaignFeatures | null {
  const campaign = campaignRepository.findByAddress(config.CHAIN_ID, address);
  if (!campaign) return null;

  return extractFeatures(
    campaign,
    contributionRepository.listByCampaign(config.CHAIN_ID, address),
    milestoneRepository.listByCampaign(config.CHAIN_ID, address),
    disputeRepository.listByCampaign(config.CHAIN_ID, address),
    nowSeconds,
    reputationLookup
  );
}

function round(value: number, places = 6): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}