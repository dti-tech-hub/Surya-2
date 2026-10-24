/**
 * Server entry point.
 *
 * Applies migrations before listening, so a fresh checkout does not serve 500s on every
 * query until someone remembers to run `npm run migrate`. Starting the indexer is
 * controlled by INDEXER_ENABLED so that a read-only API replica does not also become a
 * writer (the single-writer constraint, D-009).
 */
import { createApp } from "./app.js";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { indexer } from "./indexer/indexer.js";
import { logger } from "./services/logger.js";

const INDEXER_ENABLED = process.env.INDEXER_ENABLED !== "false";

async function main(): Promise<void> {
  migrate();

  const app = createApp();

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, chainId: config.CHAIN_ID, indexer: INDEXER_ENABLED },
      "backend listening"
    );
  });

  if (INDEXER_ENABLED) {
    // Kick off immediately, then poll. The first tick also validates that the RPC and
    // the deployment manifest actually work, surfacing misconfiguration at boot rather
    // than on the first user request.
    indexer.start();
    indexer
      .tick()
      .then((count) => logger.info({ indexed: count }, "initial indexer pass complete"))
      .catch((error) => logger.warn({ err: error.message }, "initial indexer pass failed"));
  }

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    indexer.stop();
    server.close(() => process.exit(0));
    // Do not let a hung connection block the exit forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  logger.error({ err: error.message, stack: error.stack }, "failed to start");
  process.exit(1);
});