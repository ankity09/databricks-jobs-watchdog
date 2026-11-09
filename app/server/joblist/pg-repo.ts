import type { LakebasePool } from "@databricks/appkit";
import { z } from "zod";
import type { ChangeKind, JobListDocument } from "../../shared/joblist/types";
import { withRetry } from "../db/retry";
import { jobsInTarget } from "../../shared/joblist/changelog";
import { CHANGE_KINDS, type VersionFacets } from "../../shared/joblist/types";
import type { VersionFilter, VersionRepo, VersionRow, VersionTx } from "./store";

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

/** `q` as a LIKE pattern for a plain substring: the backslash, % and _ lose their meaning. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * The WHERE clause for a filter (and `before`). It is built from a fixed set of fragments; every value
 * from the caller goes in as a bound parameter, and job names are compared with starts_with, strpos and
 * equality, never LIKE (a job name holds `_`).
 */
function whereOf(filter: VersionFilter, before?: number): { where: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  if (before !== undefined) parts.push(`version < ${bind(before)}::bigint`);
  if (filter.person !== undefined) parts.push(`saved_by = ${bind(filter.person)}::text`);
  if (filter.kinds !== undefined) parts.push(`change_kind = ANY(${bind(filter.kinds)}::text[])`);
  if (filter.job !== undefined) {
    const job = bind(filter.job);
    // Its own changes; the left end of any link; the right end of a job or child_job link (not a service).
    parts.push(`(change_target = 'job:' || ${job}::text
      OR starts_with(change_target, 'dependency:' || ${job}::text || '->')
      OR (starts_with(change_target, 'dependency:')
        AND substr(change_target, strpos(change_target, '->') + 2) IN (${job}::text || ':job', ${job}::text || ':child_job')))`);
  }
  if (filter.from !== undefined) parts.push(`saved_at >= ${bind(filter.from)}::timestamptz`);
  if (filter.until !== undefined) parts.push(`saved_at < ${bind(filter.until)}::timestamptz`);
  if (filter.q !== undefined) parts.push(`summary ILIKE ${bind(likePattern(filter.q))}::text ESCAPE '\\'`);
  return { where: parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "", values };
}

const TABLE = "watchdog_app.job_list_versions";

const N = z.union([z.string(), z.number()]).transform(Number);
const CountRow = z.object({ n: N });
const PersonRow = z.object({ saved_by: z.string(), n: N });
const KindRow = z.object({ change_kind: z.string(), n: N });
const TargetRow = z.object({ change_target: z.string(), n: N });
const RangeRow = z.object({ first: z.date().nullable(), last: z.date().nullable() });

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function createPgVersionRepo(pool: LakebasePool): VersionRepo {
  return {
    latest: () => withRetry(() => selectOne(pool, "ORDER BY version DESC", [])),
    get: (version) => withRetry(() => selectOne(pool, "WHERE version = $1", [version])),
    list: async (limit, before, filter = {}) => {
      const { where, values } = whereOf(filter, before);
      const result = await withRetry(() =>
        pool.query(`SELECT ${COLUMNS} FROM ${TABLE} ${where} ORDER BY version DESC LIMIT $${values.length + 1}`, [...values, limit]));
      return result.rows.map(toRow);
    },
    count: async (filter = {}) => {
      const { where, values } = whereOf(filter);
      const result = await withRetry(() => pool.query(`SELECT count(*) AS n FROM ${TABLE} ${where}`, values));
      return CountRow.parse(result.rows[0]).n;
    },
    facets: async (): Promise<VersionFacets> => {
      const [people, kinds, targets, range] = await withRetry(() => Promise.all([
        pool.query(`SELECT saved_by, count(*) AS n FROM ${TABLE} GROUP BY saved_by`),
        pool.query(`SELECT change_kind, count(*) AS n FROM ${TABLE} GROUP BY change_kind`),
        pool.query(`SELECT change_target, count(*) AS n FROM ${TABLE} WHERE change_target IS NOT NULL GROUP BY change_target`),
        pool.query(`SELECT min(saved_at) AS first, max(saved_at) AS last FROM ${TABLE}`),
      ]));
      // The job names come from the same reader the in-memory repo uses, so a service is never a job.
      const jobCounts = new Map<string, number>();
      for (const raw of targets.rows) {
        const row = TargetRow.parse(raw);
        for (const name of jobsInTarget(row.change_target)) jobCounts.set(name, (jobCounts.get(name) ?? 0) + row.n);
      }
      const kindCounts = new Map(kinds.rows.map((raw) => {
        const row = KindRow.parse(raw);
        return [row.change_kind, row.n] as const;
      }));
      const { first, last } = RangeRow.parse(range.rows[0]);
      return {
        people: people.rows.map((raw) => PersonRow.parse(raw)).map((r) => ({ email: r.saved_by, count: r.n }))
          .sort((a, b) => b.count - a.count || byText(a.email, b.email)),
        jobs: [...jobCounts].map(([name, count]) => ({ name, count })).sort((a, b) => byText(a.name, b.name)),
        kinds: CHANGE_KINDS.flatMap((kind) => {
          const count = kindCounts.get(kind) ?? 0;
          return count > 0 ? [{ kind, count }] : [];
        }),
        firstSavedAt: first?.toISOString() ?? null,
        lastSavedAt: last?.toISOString() ?? null,
      };
    },
    transaction: async <T>(fn: (tx: VersionTx) => Promise<T>): Promise<T> => {
      const client = await withRetry(() => pool.connect());
      // Set when COMMIT or ROLLBACK fails: the connection may be broken, so the pool must drop it, not reuse it.
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        await client.query(LOCK_SQL);
        const result = await fn(txFor(client));
        try {
          await client.query("COMMIT");
        } catch (error) {
          broken = error instanceof Error ? error : new Error("COMMIT failed");
          throw error;
        }
        return result;
      } catch (error) {
        if (!broken) {
          await client.query("ROLLBACK").catch((rollbackError: unknown) => {
            broken = rollbackError instanceof Error ? rollbackError : new Error("ROLLBACK failed");
          });
        }
        throw error;
      } finally {
        if (broken) client.release(broken);
        else client.release();
      }
    },
  };
}
