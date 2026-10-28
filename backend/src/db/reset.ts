/**
 * Clears every indexed row for the configured chain, leaving the schema in place.
 * Re-index with `npm run index` (or the running server) afterwards.
 */
import { config } from "../config.js";
import { getDb } from "./client.js";
import { eventRepository } from "./repositories.js";
import { migrate } from "./migrate.js";

migrate();
eventRepository.resetAll(config.CHAIN_ID);

const remaining = getDb()
  .prepare("SELECT COUNT(*) AS n FROM events WHERE chain_id = ?")
  .get(config.CHAIN_ID) as { n: number };
console.log(`Cleared indexed data for chain ${config.CHAIN_ID}; events remaining: ${remaining.n}`);
