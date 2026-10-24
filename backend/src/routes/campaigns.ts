/**
 * Campaign API routes.
 *
 * Validation is done with zod at the boundary. Handlers never trust a query parameter or
 * a request body; anything that reaches a repository has already been coerced and bounded.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { config } from "../config.js";
import {
  campaignRepository,
  contributionRepository,
  credentialRepository,
  disputeRepository,
  milestoneRepository,
  voteRepository,
} from "../db/repositories.js";
import { featuresForCampaign } from "../services/features.js";
import { scoreCampaign, scoreCampaigns } from "../services/mlClient.js";

export const campaignsRouter = Router();

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  state: z.string().optional(),
});

const addressParam = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, "invalid address") });

/** GET /api/campaigns — paginated list, optionally filtered by state, with risk badges. */
campaignsRouter.get("/", async (req: Request, res: Response) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid query", detail: parsed.error.flatten() });
  }
  const { limit, offset, state } = parsed.data;

  const rows = campaignRepository.list(config.CHAIN_ID, { limit, offset, state });
  const now = Math.floor(Date.now() / 1000);

  // Compute risk for the page concurrently. A failure in any single campaign must not
  // take down the whole list.
  const withRisk = await Promise.all(
    rows.map(async (row) => {
      const features = featuresForCampaign(String(row.address), now);
      const risk = features ? await scoreCampaign(features as unknown as Record<string, unknown>) : null;
      return {
        address: row.address,
        creator: row.creator,
        goalWei: row.goal_wei,
        fundingDeadline: row.funding_deadline,
        state: row.state,
        totalContributed: row.total_contributed,
        totalReleased: row.total_released,
        releasedBps: row.released_bps,
        createdAt: row.created_at,
        risk: risk ? { score: risk.risk_score, band: risk.risk_band } : null,
      };
    })
  );

  res.json({
    data: withRisk,
    pagination: { limit, offset, total: campaignRepository.count(config.CHAIN_ID, state) },
  });
});

/** GET /api/campaigns/:address — full detail: milestones, votes, disputes, risk. */
campaignsRouter.get("/:address", async (req: Request, res: Response) => {
  const parsed = addressParam.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid address" });
  }
  const { address } = parsed.data;

  const campaign = campaignRepository.findByAddress(config.CHAIN_ID, address);
  if (!campaign) {
    return res.status(404).json({ error: "campaign not found" });
  }

  const milestones = milestoneRepository.listByCampaign(config.CHAIN_ID, address);
  const disputes = disputeRepository.listByCampaign(config.CHAIN_ID, address);

  const votesByMilestone = milestones.map((m) => ({
    milestoneIndex: m.idx,
    votes: voteRepository.listByMilestone(config.CHAIN_ID, address, Number(m.idx)),
  }));

  const now = Math.floor(Date.now() / 1000);
  const features = featuresForCampaign(address, now);
  const risk = features ? await scoreCampaign(features as unknown as Record<string, unknown>) : null;

  res.json({
    data: {
      address,
      creator: campaign.creator,
      goalWei: campaign.goal_wei,
      fundingDeadline: campaign.funding_deadline,
      state: campaign.state,
      totalContributed: campaign.total_contributed,
      totalReleased: campaign.total_released,
      releasedBps: campaign.released_bps,
      createdAt: campaign.created_at,
      milestones,
      disputes,
      votesByMilestone,
      contributors: contributionRepository.listByCampaign(config.CHAIN_ID, address).length,
      risk,
    },
  });
});

/** POST /api/campaigns/score — score an arbitrary feature vector (debugging / demos). */
const scoreBody = z.record(z.string(), z.unknown());

campaignsRouter.post("/score", async (req: Request, res: Response) => {
  const parsed = scoreBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body" });
  }
  const risk = await scoreCampaign(parsed.data);
  if (!risk) {
    return res.status(503).json({ error: "ML service unavailable" });
  }
  res.json({ data: risk });
});

/** POST /api/campaigns/batch-risk — risk for a list of addresses. */
const batchBody = z.object({ addresses: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)).max(50) });

campaignsRouter.post("/batch-risk", async (req: Request, res: Response) => {
  const parsed = batchBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", detail: parsed.error.flatten() });
  }
  const now = Math.floor(Date.now() / 1000);
  const vectors = parsed.data.addresses
    .map((address) => featuresForCampaign(address, now))
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .map((f) => f as unknown as Record<string, unknown>);

  const risks = await scoreCampaigns(vectors);
  res.json({ data: risks });
});