import type { LakebasePool } from "@databricks/appkit";
import { z } from "zod";
import type { ChangeKind, JobListDocument } from "../../shared/joblist/types";
import { withRetry } from "../db/retry";
import type { VersionRepo, VersionRow, VersionTx } from "./store";

/** One lock for every save: a transaction holds it until it commits, so saves run one at a time. */
const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('watchdog_app.job_list_versions'))";

const COLUMNS = "version, document, saved_by, saved_at, change_kind, change_target, summary";

const RowSchema = z.object({
  version: z.union([z.string(), z.number()]).transform(Number),
  document: z.custom<JobListDocument>((value) => typeof value === "object" && value !== null),
  saved_by: z.string(),
  saved_at: z.date(),
  change_kind: z.custom<ChangeKind>((value) => typeof value === "string"),
  change_target: z.string().nullable(),
  summary: z.string(),
});

function toRow(raw: unknown): VersionRow {
  const r = RowSchema.parse(raw);
  return {
    version: r.version, document: r.document, savedBy: r.saved_by, savedAt: r.saved_at,
    changeKind: r.change_kind, changeTarget: r.change_target, summary: r.summary,
  };
}

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

async function selectOne(db: Queryable, where: string, values: unknown[]): Promise<VersionRow | null> {
  const result = await db.query(`SELECT ${COLUMNS} FROM watchdog_app.job_list_versions ${where} LIMIT 1`, values);
  return result.rows.length > 0 ? toRow(result.rows[0]) : null;
}

function txFor(db: Queryable): VersionTx {
  return {
    latest: () => selectOne(db, "ORDER BY version DESC", []),
    get: (version) => selectOne(db, "WHERE version = $1", [version]),
    insert: async (row) => {
      const result = await db.query(
        `INSERT INTO watchdog_app.job_list_versions (version, document, saved_by, change_kind, change_target, summary)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [row.version, JSON.stringify(row.document), row.savedBy, row.changeKind, row.changeTarget, row.summary],
      );
      return toRow(result.rows[0]);
    },
  };
}

export function createPgVersionRepo(pool: LakebasePool): VersionRepo {
  return {
    latest: () => withRetry(() => selectOne(pool, "ORDER BY version DESC", [])),
    get: (version) => withRetry(() => selectOne(pool, "WHERE version = $1", [version])),
    list: async (limit, before) => {
      const result = await withRetry(() =>
        before === undefined
          ? pool.query(`SELECT ${COLUMNS} FROM watchdog_app.job_list_versions ORDER BY version DESC LIMIT $1`, [limit])
          : pool.query(
            `SELECT ${COLUMNS} FROM watchdog_app.job_list_versions WHERE version < $2 ORDER BY version DESC LIMIT $1`,
            [limit, before],
          ));
      return result.rows.map(toRow);
    },
    transaction: async <T>(fn: (tx: VersionTx) => Promise<T>): Promise<T> => {
      const client = await withRetry(() => pool.connect());
      try {
        await client.query("BEGIN");
        await client.query(LOCK_SQL);
        const result = await fn(txFor(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
