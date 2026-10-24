/**
 * System routes: health, readiness, indexer status, and credential lookup.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { credentialRepository } from "../db/repositories.js";
import { indexer } from "../indexer/indexer.js";
import { getMlHealth } from "../services/mlClient.js";

export const systemRouter = Router();

/**
 * Health endpoints are mounted at the ROOT so orchestrators can probe `/health`
 * without knowing the API prefix.
 */
export const healthRouter = Router();

/**
 * GET /health — liveness. Intentionally does not touch the database or the chain: a
 * liveness probe that fails because a dependency is slow causes orchestrators to kill a
 * process that is actually fine.
 */
healthRouter.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", service: "backend", uptime: process.uptime() });
});

/**
 * GET /health/ready — readiness. Checks the things that actually matter to serve
 * traffic: the database is reachable and migrated, and the chain is answering.
 */
healthRouter.get("/health/ready", async (_req: Request, res: Response) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    getDb().prepare("SELECT 1").get();
    const migrated = getDb()
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
      .get() as { n: number };
    checks.database = { ok: Number(migrated.n) > 0, detail: `${migrated.n} migrations applied` };
  } catch (error) {
    checks.database = { ok: false, detail: (error as Error).message };
  }

  try {
    const { getChainClient } = await import("../chain/client.js");
    const block = await getChainClient().blockNumber();
    checks.chain = { ok: true, detail: `head block ${block}` };
  } catch (error) {
    // A missing chain connection is degraded, not fatal: the API still serves indexed
    // data. Marked non-ok so the ops dashboard shows it.
    checks.chain = { ok: false, detail: (error as Error).message };
  }

  try {
    const ml = await getMlHealth();
    checks.ml = { ok: ml.models_trained === true, detail: `models_trained=${ml.models_trained}` };
  } catch (error) {
    checks.ml = { ok: false, detail: (error as Error).message };
  }

  const ready = checks.database?.ok === true;
  res.status(ready ? 200 : 503).json({ ready, checks });
});

/** GET /api/indexer/status — indexer progress, cursor per contract, last error. */
systemRouter.get("/indexer/status", (_req: Request, res: Response) => {
  res.json({ data: indexer.getStatus() });
});

const credQuery = z.object({
  subject: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  schemaType: z.string().optional(),
});

/**
 * GET /api/credentials/:subject — credential attestations for a subject.
 *
 * Returns only the attestation metadata (schema type, issuer, expiry, revoked flag).
 * No claims, no PII: the registry stores hashes only, and this endpoint does not invent
 * information the chain does not hold.
 */
systemRouter.get("/credentials/:subject", (req: Request, res: Response) => {
  const parsed = credQuery.safeParse({ subject: req.params.subject, schemaType: req.query.schemaType });
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid subject address" });
  }

  const rows = credentialRepository.findBySubject(config.CHAIN_ID, parsed.data.subject);
  const now = Math.floor(Date.now() / 1000);

  const credentials = rows.map((row) => ({
    credentialId: row.credential_id,
    schemaType: row.schema_type,
    issuer: row.issuer,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revoked: Boolean(row.revoked),
    valid: !row.revoked && Number(row.expires_at) > now,
  }));

  res.json({
    data: {
      subject: parsed.data.subject,
      credentials,
      // Aggregate gate used by the "can launch a campaign" check. This is a boolean,
      // never a disclosure of which claims the credential contains.
      canLaunchCampaign:
        credentials.some((c) => c.valid && c.schemaType === "VerifiedCreator"),
    },
  });
});

/** GET /api/stats — aggregate counts for the landing page. */
systemRouter.get("/stats", (_req: Request, res: Response) => {
  const db = getDb();
  const total = db
    .prepare("SELECT COUNT(*) AS n FROM campaigns WHERE chain_id = ?")
    .get(config.CHAIN_ID) as { n: number };

  const byState = db
    .prepare("SELECT state, COUNT(*) AS n FROM campaigns WHERE chain_id = ? GROUP BY state")
    .all(config.CHAIN_ID) as Array<{ state: string; n: number }>;

  const raised = db
    .prepare(
      "SELECT COALESCE(SUM(CAST(total_contributed AS INTEGER)), 0) AS total FROM campaigns WHERE chain_id = ?"
    )
    .get(config.CHAIN_ID) as { total: number | bigint };

  res.json({
    data: {
      campaigns: Number(total.n),
      byState: Object.fromEntries(byState.map((r) => [r.state, Number(r.n)])),
      // Approximate: SQLite SUM over a wide range loses precision above 2^53. Reported
      // as a string so a consumer can parse it without silent corruption.
      totalRaisedWei: String(raised.total),
    },
  });
});