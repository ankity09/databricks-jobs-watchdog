import type { LakebasePool } from "@databricks/appkit";
import { withRetry } from "./retry";

/**
 * The app's own Postgres schema. The deployed app's service principal creates
 * it on first start, so it owns it. Genie keeps the copilot's conversations, so
 * the only table is the job list's version history.
 *
 * After a plain teardown and a new deploy, the app has a new service principal
 * and the kept schema belongs to the identity that ran the teardown, so the
 * check below is refused (42501) until the watchdog_app_access job grants the
 * new service principal access (jobs_watchdog/app_access.py).
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

/** Postgres refused for lack of a privilege, as for the app's new service principal after a teardown and a new deploy. */
export function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "42501";
}

/** What the job list answers while the app cannot use its schema. */
export const NO_ACCESS_MESSAGE =
  "The app has no access to its job list in Lakebase. After a teardown and a new deploy, the person or service " +
  "principal that deployed runs the watchdog_app_access job (databricks bundle run watchdog_app_access). Then try again.";

/** The startup log line for a failed schema check. */
export function schemaErrorLog(error: unknown): string {
  if (isPermissionDenied(error)) {
    return "[lakebase] The app's service principal cannot use the watchdog_app schema (permission denied, 42501). " +
      "After a teardown and a new deploy, the kept job list belongs to the identity that ran the teardown: run the " +
      "watchdog_app_access job as that identity (databricks bundle run watchdog_app_access -t <target>). " +
      "The job list answers 503 until then, and tries again on each request.";
  }
  return `[lakebase] Could not create the watchdog_app schema: ${error instanceof Error ? error.message : String(error)}. ` +
    "The job list tries again on its next request.";
}

export interface SchemaGateOptions {
  /** How long a failure stands before a request tries again. */
  retryAfterMs?: number;
  now?: () => number;
  ensure?: (pool: LakebasePool) => Promise<void>;
}

/**
 * ensureSchema at startup, and again on a later job-list request while it has
 * not worked yet: a compute that was still waking up, or a new deploy whose
 * service principal gets access from the watchdog_app_access job. A failure
 * stands for retryAfterMs, so a burst of requests asks the database once.
 */
export function schemaGate(pool: LakebasePool, options: SchemaGateOptions = {}): { ready(): Promise<void> } {
  const retryAfterMs = options.retryAfterMs ?? 10_000;
  const now = options.now ?? Date.now;
  const ensure = options.ensure ?? ensureSchema;
  let done = false;
  let failure: { at: number; error: Error } | null = null;
  let running: Promise<void> | null = null;
  return {
    ready(): Promise<void> {
      if (done) return Promise.resolve();
      if (running) return running;
      if (failure && now() - failure.at < retryAfterMs) return Promise.reject(failure.error);
      running = ensure(pool).then(
        () => {
          done = true;
          failure = null;
        },
        (error: unknown) => {
          // Postgres and network errors are Errors; keep their code (42501) for the routes.
          failure = { at: now(), error: error instanceof Error ? error : new Error(String(error)) };
          throw failure.error;
        },
      ).finally(() => {
        running = null;
      });
      return running;
    },
  };
}
