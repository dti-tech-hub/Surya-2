/**
 * ML service client.
 *
 * The backend computes features from its own indexed data and calls the ML service over
 * HTTP. It never reads the service's model files, and the ML service never reads this
 * database. That separation is what keeps the storage engine swappable (D-009).
 *
 * Failure policy: if the ML service is unreachable, campaign routes return the campaign
 * with `risk: null` rather than failing the request. A fraud badge is useful
 * enrichment, not a reason for a user's campaign list to 500.
 */
import { config } from "../config.js";
import { logger } from "./logger.js";

export interface RiskScore {
  campaign_id: string | null;
  risk_score: number;
  risk_band: "low" | "medium" | "high";
  components: Record<string, unknown>;
  top_factors: Array<{
    feature: string;
    value: number;
    dataset_mean: number;
    importance: number;
    contribution: number;
    direction: string;
  }>;
  disclaimer: string;
}

export interface MlHealth {
  status: string;
  models_trained: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ML_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.ML_SERVICE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(`ML service ${path} -> HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function getMlHealth(): Promise<MlHealth> {
  return request<MlHealth>("/health");
}

export async function getMlMetrics(): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>("/metrics");
}

/**
 * Scores one campaign. Returns null on any failure, logging the reason.
 * @param features Feature payload matching the ML service's CampaignFeatures model.
 */
export async function scoreCampaign(features: Record<string, unknown>): Promise<RiskScore | null> {
  try {
    return await request<RiskScore>("/score", {
      method: "POST",
      body: JSON.stringify(features),
    });
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "ML scoring failed; returning null risk");
    return null;
  }
}

/** Scores many campaigns; individual failures degrade to a null risk entry. */
export async function scoreCampaigns(
  features: Array<Record<string, unknown>>
): Promise<Array<RiskScore | null>> {
  try {
    return await request<Array<RiskScore>>("/score/batch", {
      method: "POST",
      body: JSON.stringify(features),
    });
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "ML batch scoring failed");
    return features.map(() => null);
  }
}