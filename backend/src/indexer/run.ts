/**
 * One-shot indexer run. Useful for CI and for the end-to-end demo:
 *
 *   npx tsx src/indexer/run.ts
 *
 * The long-running server uses the same Indexer class from `index.ts`; this entry point
 * exists so a test can index a local chain to completion and exit deterministically.
 */
import { migrate } from "../db/migrate.js";
import { indexer } from "./indexer.js";

async function main(): Promise<void> {
  migrate();
  const indexed = await indexer.tick();
  const status = indexer.getStatus();
  console.log(
    JSON.stringify(
      {
        indexed,
        headBlock: status.headBlock,
        confirmedThrough: status.confirmedThrough,
        cursors: status.cursors,
        lastError: status.lastError,
      },
      null,
      2
    )
  );
  if (status.lastError) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
