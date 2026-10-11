/**
 * SQLite connection and pragmas.
 *
 * Uses Node's built-in `node:sqlite` (Node >= 22.5) rather than `better-sqlite3`.
 * Rationale is recorded in docs/DECISIONS.md (D-013): better-sqlite3 requires a native
 * build via node-gyp, which fails on the Node 24 toolchain used for development, while
 * `node:sqlite` ships with the runtime and needs no compiler toolchain at all.
 *
 * PRAGMA choices and why:
 *   journal_mode = WAL      Readers do not block the indexer's writes. The indexer is a
 *                          single writer, but the API serves reads concurrently, so WAL
 *                          is what keeps a write from stalling a page load.
 *   foreign_keys = ON       Off by default in SQLite. Without this, the referential
 *                          integrity the schema declares would not actually be enforced.
 *   synchronous = NORMAL    With WAL this is durable across process crashes (the
 *                          realistic failure mode here) while avoiding an fsync per
 *                          transaction. FULL would be the choice if the DB were the
 *                          system of record, which it is not — see D-009.
 *   busy_timeout            Wait rather than immediately throwing SQLITE_BUSY when the
 *                          single writer briefly holds the lock.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { config } from "../config.js";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;

  // Read DATABASE_PATH at call time, not module load. Tests reassign
  // process.env.DATABASE_PATH to ":memory:" between cases and expect a fresh database;
  // reading the validated config once at import time would pin every test to the same
  // file and leak state between them.
  const configured = process.env.DATABASE_PATH ?? config.DATABASE_PATH;
  const file =
    configured === ":memory:" ? configured : isAbsolute(configured) ? configured : resolve(configured);

  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }

  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Runs `fn` inside a transaction, rolling back on throw. */
export function transaction<T>(fn: () => T): T {
  const handle = getDb();
  handle.exec("BEGIN");
  try {
    const result = fn();
    handle.exec("COMMIT");
    return result;
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }
}