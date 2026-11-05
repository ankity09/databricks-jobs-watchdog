import type { LakebasePool } from "@databricks/appkit";
import { withRetry } from "./retry";

/**
 * The app's own Postgres schema. The deployed app's service principal creates
 * it on first start, so it owns it. Genie keeps the copilot's conversations, so
 * the only table is the job list's version history.
 */
const SCHEMA_DDL = `
CREATE SCHEMA IF NOT EXISTS watchdog_app;
CREATE TABLE IF NOT EXISTS watchdog_app.job_list_versions (
  version        BIGINT PRIMARY KEY,
  document       JSONB NOT NULL,
  saved_by       TEXT NOT NULL,
  saved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  change_kind    TEXT NOT NULL CHECK (change_kind IN ('import','create','update','delete','restore')),
  change_target  TEXT,
  summary        TEXT NOT NULL
);
`;

/** Any fixed number: two app instances starting at once create the schema one after the other. */
const SCHEMA_LOCK_KEY = 707_200_001;

/** Creates the schema and its tables if they are missing, in one transaction. A waking compute gets one retry. */
export async function ensureSchema(pool: LakebasePool): Promise<void> {
  await withRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_KEY})`);
      await client.query(SCHEMA_DDL);
      await client.query("COMMIT");
      client.release();
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      // Drop the connection rather than return a broken one to the pool.
      client.release(error instanceof Error ? error : true);
      throw error;
    }
  });
}
