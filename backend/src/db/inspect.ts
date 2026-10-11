/**
 * Prints the live schema and index inventory.
 * Usage: npx tsx src/db/inspect.ts
 */
import { getDb } from "./client.js";

const db = getDb();

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as Array<{ name: string }>;

console.log(`\nTables (${tables.length}):`);
for (const { name } of tables) console.log(`  ${name}`);

console.log("\nIndexes:");
const indexes = db
  .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY tbl_name, name")
  .all() as Array<{ name: string; tbl_name: string }>;
for (const { name, tbl_name } of indexes) console.log(`  ${tbl_name.padEnd(16)} ${name}`);
console.log(`\nTotal indexes: ${indexes.length}`);

console.log("\nPragmas:");
for (const pragma of ["journal_mode", "foreign_keys", "synchronous"]) {
  const row = db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>;
  console.log(`  ${pragma.padEnd(14)} ${Object.values(row)[0]}`);
}