/**
 * Express application assembly.
 *
 * Middleware order is deliberate:
 *   1. helmet      — security headers, before anything else touches the response
 *   2. cors        — must answer preflight before rate limiting counts it
 *   3. body parser — bounded size, so a large payload cannot exhaust memory
 *   4. rate limit  — after CORS so preflights are not counted as API calls
 *   5. request log
 *   6. routes
 */
import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { config } from "./config.js";
import { logger } from "./services/logger.js";
import { campaignsRouter } from "./routes/campaigns.js";
import { healthRouter, systemRouter } from "./routes/system.js";

export function createApp(): Express {
  const app = express();

  // Behind a proxy, trust X-Forwarded-For once. express-rate-limit warns and disables
  // itself if trust proxy is unset, which would silently apply the limit per-proxy
  // rather than per-client.
  app.set("trust proxy", 1);

  app.use(
    helmet({
      // The API serves JSON, not HTML, so a restrictive CSP costs nothing. Swagger UI
      // is mounted separately and relaxes this via its own headers.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );

  app.use(
    cors({
      origin: config.FRONTEND_ORIGIN.split(",").map((s) => s.trim()),
      credentials: true,
    })
  );

  // Bound the body size. Evidence files go to IPFS directly, not through this service,
  // so there is no reason to accept a large multipart payload here.
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.use(
    rateLimit({
      windowMs: config.RATE_LIMIT_WINDOW_MS,
      max: config.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      // Health checks come from orchestrators at high frequency; throttling them causes
      // spurious restarts.
      skip: (req) => req.path.startsWith("/health"),
      message: { error: "rate limit exceeded" },
    })
  );

  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      logger.info(
        { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started },
        "request"
      );
    });
    next();
  });

  // Health is at the root so orchestrators can probe it without the API prefix.
  app.use(healthRouter);

  // campaignsRouter exposes a GET "/:address" route, so it must be mounted under
  // /api/campaigns. Mounting it at /api would let "/api/stats" match "/:address" and
  // shadow every sibling route.
  app.use("/api/campaigns", campaignsRouter);
  app.use("/api", systemRouter);

  app.use((req, res) => {
    res.status(404).json({ error: "not found", path: req.path });
  });

  // Express 4 does not catch errors thrown inside async handlers, so this wrapper is
  // required for the async routes to surface failures instead of hanging the request.
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err: error.message, stack: error.stack }, "unhandled error");
    res.status(500).json({ error: "internal server error" });
  });

  return app;
}