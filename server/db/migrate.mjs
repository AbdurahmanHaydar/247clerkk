// Applies a .sql file to DATABASE_URL. Every migration here is idempotent, so
// re-running it is safe.
//
//   node --env-file=.env db/migrate.mjs db/002_visits.sql
import { readFileSync } from "node:fs";
import pg from "pg";

const file = process.argv[2];
if (!file) {
  console.error("usage: node --env-file=.env db/migrate.mjs <file.sql>");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(readFileSync(file, "utf8"));
  console.log(`[migrate] applied ${file}`);
} catch (error) {
  console.error(`[migrate] failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
