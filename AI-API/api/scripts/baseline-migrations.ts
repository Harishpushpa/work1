/**
 * Mark the current drizzle journal entries as already applied without running SQL.
 * Use on an existing DB that already matches schema (e.g. after squashing to 0000).
 *
 * Fresh installs should run: npm run db:migrate
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
  buildPostgresPoolConfig,
  logPostgresConnInfo,
} from "../src/platform/database/postgres-env";

const conn = buildPostgresPoolConfig();
logPostgresConnInfo(conn);
const pool = new Pool(conn.poolConfig);

async function main() {
  const drizzleDir = path.join(process.cwd(), "drizzle");
  const journal = JSON.parse(
    fs.readFileSync(path.join(drizzleDir, "meta", "_journal.json"), "utf8"),
  );

  await pool.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);

  // Drop stale hashes from pre-v1 incremental migrations so migrate doesn't get confused.
  await pool.query(`TRUNCATE drizzle.__drizzle_migrations RESTART IDENTITY`);

  for (const entry of journal.entries) {
    const sql = fs.readFileSync(
      path.join(drizzleDir, `${entry.tag}.sql`),
      "utf8",
    );
    const hash = crypto.createHash("sha256").update(sql).digest("hex");

    await pool.query(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
      [hash, entry.when],
    );
    console.log(`Baselined: ${entry.tag}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
