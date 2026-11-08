/**
 * Minimal forward-only migration runner.
 *  - Applies db/migrations/*.sql in lexical order, each in its own transaction.
 *  - Records a sha256 checksum; refuses to run if an applied file was edited.
 *  - Takes a Postgres advisory lock so concurrent runs cannot interleave.
 *
 * Needs only DATABASE_URL (not the full backend config), so it can run before
 * NEAR keys exist.
 */
import { config as loadEnv } from "dotenv";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// .env lives at the repo root; pnpm --filter runs this with cwd = apps/backend.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../../.env") });

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
const LOCK_KEY = 727_001; // arbitrary, constant

export async function migrate(databaseUrl: string, log: (s: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        checksum   CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    const done = new Map<string, string>(
      (await client.query<{ filename: string; checksum: string }>("SELECT filename, checksum FROM schema_migrations")).rows.map(
        (r) => [r.filename, r.checksum],
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = done.get(file);
      if (prior !== undefined) {
        if (prior !== checksum) throw new Error(`Migration ${file} was modified after being applied. Add a new migration instead.`);
        continue;
      }
      log(`applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
    log(applied.length ? `applied ${applied.length} migration(s)` : "database is up to date");
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  migrate(url).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
