/**
 * Migration runner.
 *
 * Applies any migration whose id is greater than the highest recorded one, inside a
 * transaction each, and records it in `schema_migrations`.
 *
 * Usage:
 *   npm run migrate            # apply pending migrations
 *   npm run migrate -- --status   # show what is applied
 */
import { getDb, transaction } from "./client.js";
import { migrations } from "./migrations.js";

export function migrate(): number {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations ORDER BY id")
      .all()
      .map((row: any) => Number(row.id))
  );

  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    // SQLite DDL is transactional, so a failed migration leaves no partial schema.
    transaction(() => {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        migration.id,
        migration.name,
        Math.floor(Date.now() / 1000)
      );
    });

    console.log(`[migrate] applied ${migration.id}: ${migration.name}`);
    count++;
  }

  if (count === 0) console.log("[migrate] schema already up to date");
  return count;
}

export function migrationStatus(): Array<{ id: number; name: string; appliedAt: number | null }> {
  const db = getDb();
  const applied = new Map(
    db
      .prepare("SELECT id, name, applied_at FROM schema_migrations")
      .all()
      .map((row: any) => [Number(row.id), { name: String(row.name), appliedAt: Number(row.applied_at) }])
  );

  return migrations.map((m) => ({
    id: m.id,
    name: m.name,
    appliedAt: applied.get(m.id)?.appliedAt ?? null,
  }));
}

const isMain = process.argv[1]?.includes("migrate");
if (isMain) {
  const status = process.argv.includes("--status");
  if (status) {
    console.table(migrationStatus());
  } else {
    migrate();
  }
}