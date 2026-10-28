/**
 * Evidence upload/retrieval API.
 *
 * The body is the raw file, not multipart, so the backend does not need a parser
 * dependency. The client sets `X-Filename` and `X-Content-Type`; the response is the
 * CID plus the provider that produced it. A `local-content-store` response is explicitly
 * not IPFS.
 */
import express, { Router, type Request, type Response } from "express";

import {
  EvidenceError,
  evidenceMode,
  readEvidence,
  uploadEvidence,
} from "../services/evidence.js";

export const evidenceRouter = Router();

evidenceRouter.get("/evidence/status", (_req: Request, res: Response) => {
  res.json({ data: evidenceMode() });
});

evidenceRouter.post(
  "/evidence",
  express.raw({
    type: [
      "application/octet-stream",
      "application/pdf",
      "image/png",
      "image/jpeg",
      "image/webp",
      "text/plain",
      "application/json",
    ],
    limit: "10mb",
  }),
  async (req: Request, res: Response) => {
    if (!Buffer.isBuffer(req.body)) {
      return res.status(415).json({
        error: "unsupported media type",
        detail: "Send the file bytes with Content-Type: application/octet-stream.",
      });
    }

    const filename =
      (typeof req.headers["x-filename"] === "string" && req.headers["x-filename"]) ||
      (typeof req.query.filename === "string" && req.query.filename) ||
      "evidence.bin";
    const contentType =
      (typeof req.headers["x-content-type"] === "string" && req.headers["x-content-type"]) ||
      (typeof req.headers["content-type"] === "string" && req.headers["content-type"]) ||
      "application/octet-stream";

    try {
      const upload = await uploadEvidence(req.body, filename, contentType);
      res.status(201).json({ data: upload });
    } catch (error) {
      if (error instanceof EvidenceError) {
        return res.status(error.status).json({ error: error.message });
      }
      res.status(502).json({ error: (error as Error).message });
    }
  }
);

evidenceRouter.get("/evidence/:cid", async (req: Request, res: Response) => {
  const found = await readEvidence(req.params.cid);
  if (!found) return res.status(404).json({ error: "evidence not found" });
  res.setHeader("Content-Type", found.contentType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${found.filename.replace(/["\\\r\n]/g, "_")}"`
  );
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.send(found.data);
});
