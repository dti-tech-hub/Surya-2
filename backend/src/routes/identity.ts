/**
 * Identity and reputation API.
 *
 * DID resolution is deterministic and does not need a database. Credential issuance
 * requires an issuer key in the environment; without one the endpoint fails closed with
 * 503 rather than issuing an unsigned or self-asserted credential.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { config } from "../config.js";
import { getChainClient } from "../chain/client.js";
import {
  IdentityError,
  didDocument,
  didForAddress,
  issueCredential,
  issuerAddress,
  verifyCredential,
} from "../services/identity.js";
import { reputationCacheRepository } from "../db/repositories.js";

export const identityRouter = Router();

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "invalid address");

identityRouter.get("/identity/issuer", (_req: Request, res: Response) => {
  const address = issuerAddress();
  res.json({
    data: {
      available: Boolean(address),
      address,
      did: address ? config.VC_ISSUER_DID ?? didForAddress(address) : null,
      note: address
        ? "Prototype issuer: Ethereum personal_sign VC proof, hash anchored in CredentialRegistry."
        : "Set VC_ISSUER_PRIVATE_KEY (or VERAMO_AGENT_PRIVATE_KEY) to enable issuance.",
    },
  });
});

identityRouter.get("/identity/:address/did", (req: Request, res: Response) => {
  const parsed = address.safeParse(req.params.address);
  if (!parsed.success) return res.status(400).json({ error: "invalid address" });
  res.json({ data: didDocument(parsed.data) });
});

const issueBody = z.object({
  subject: address,
  schemaType: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "schemaType must be an identifier"),
  claims: z.record(z.string(), z.unknown()).optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  attestOnChain: z.boolean().optional(),
});

identityRouter.post("/identity/credentials", async (req: Request, res: Response) => {
  const parsed = issueBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid body", detail: parsed.error.flatten() });
  }

  try {
    const issued = await issueCredential({
      ...parsed.data,
      attestOnChain: parsed.data.attestOnChain ?? config.VC_ATTEST_ONCHAIN,
    });
    res.status(201).json({ data: issued });
  } catch (error) {
    if (error instanceof IdentityError) {
      return res.status(error.status).json({ error: error.message });
    }
    res.status(500).json({ error: (error as Error).message });
  }
});

const verifyBody = z.object({ credential: z.record(z.string(), z.unknown()) });

identityRouter.post("/identity/credentials/verify", async (req: Request, res: Response) => {
  const parsed = verifyBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid body" });
  const result = await verifyCredential(parsed.data.credential, { checkOnChain: true });
  res.status(result.valid ? 200 : 400).json({ data: result });
});

const reputationParams = z.object({ subject: address });

/**
 * GET /api/reputation/:subject — live read from ReputationRegistry.
 *
 * The chain is the source of truth. The SQLite row is only a cache maintained from
 * indexed events and is returned as a fallback when the RPC is unavailable, clearly
 * marked stale.
 */
identityRouter.get("/reputation/:subject", async (req: Request, res: Response) => {
  const parsed = reputationParams.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "invalid address" });
  const subject = parsed.data.subject;

  try {
    const registry = getChainClient().get("ReputationRegistry");
    const [score, tier, profile] = await Promise.all([
      registry.scoreOf(subject) as Promise<bigint>,
      registry.tierOf(subject) as Promise<bigint>,
      registry.getProfile(subject) as Promise<any>,
    ]);
    const tierName = ["Unrated", "Bronze", "Silver", "Gold", "Platinum"][Number(tier)] ?? "Unknown";
    return res.json({
      data: {
        subject,
        scoreBps: Number(score),
        tier: tierName,
        profile: {
          milestonesOnTime: Number(profile.milestonesOnTime),
          milestonesTotal: Number(profile.milestonesTotal),
          campaignsCompleted: Number(profile.campaignsCompleted),
          campaignsFailed: Number(profile.campaignsFailed),
          disputeWins: Number(profile.disputeWins),
          disputeLosses: Number(profile.disputeLosses),
          votesCorrect: Number(profile.votesCorrect),
          votesTotal: Number(profile.votesTotal),
          slashedWei: profile.slashedWei.toString(),
          lastUpdated: Number(profile.lastUpdated),
        },
        source: "chain",
      },
    });
  } catch (error) {
    const cached = reputationCacheRepository.get(config.CHAIN_ID, subject);
    if (!cached) {
      return res.status(503).json({ error: "reputation unavailable", detail: (error as Error).message });
    }
    return res.json({
      data: {
        subject,
        scoreBps: Number(cached.score_bps),
        tier: cached.tier,
        fetchedAt: Number(cached.fetched_at),
        source: "cache",
        stale: true,
      },
    });
  }
});
