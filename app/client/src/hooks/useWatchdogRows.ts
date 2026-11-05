import { sql, type SQLNumberMarker, type SQLStringMarker } from "@databricks/appkit-ui/js";
import { useMemo } from "react";
import type { z } from "zod";
import type { QueryProblem } from "../lib/queryProblem";
import { parseRows } from "../lib/rows";
import { useAppConfig } from "./useAppConfig";
import { useLastGood } from "./useLastGood";
import { useRefreshKey } from "./useRefreshKey";

/** Where the Watchdog tables are, and the parameters every Watchdog query takes. */
export interface WatchdogLocation {
  /** "catalog.schema", once the config names a catalog. */
  location: string | null;
  /** True once the config names a catalog, so queries may start. */
  ready: boolean;
  /** Why no query can run: the config did not load, or names no catalog. */
  problem: QueryProblem | null;
  params: { catalog: SQLStringMarker; schema: SQLStringMarker; refresh: SQLNumberMarker };
}

export function useWatchdogLocation(): WatchdogLocation {
  const { refresh } = useRefreshKey();
  // The refresh key as the retry key: Retry (bump()) loads a failed config again.
  const { config, error } = useAppConfig(refresh);
  const ready = config !== null && config.catalog !== "";
  const params = useMemo(
    () => ({ catalog: sql.string(config?.catalog ?? ""), schema: sql.string(config?.schema ?? ""), refresh: sql.int(refresh) }),
    [config, refresh],
  );
  let problem: QueryProblem | null = null;
  if (error) problem = { kind: "config", message: error.message };
  else if (config !== null && !ready) problem = { kind: "no-catalog" };
  const location = config !== null && config.catalog !== "" ? `${config.catalog}.${config.schema}` : null;
  return { location, ready, problem, params };
}

/** What a view can show from one query. */
export interface QueryRows<T> {
  /** The newest answer's rows; while a newer query for the same view loads, the last answer's. Null until there is one. */
  rows: T[] | null;
  /** Rows of that answer that did not match the schema. */
  bad: number;
  /** The current query has not answered yet. */
  loading: boolean;
  /** Why the current query has no answer. `rows` may still hold an older one. */
  problem: QueryProblem | null;
}

/** The parts of a useAnalyticsQuery result that QueryRows reads. */
export interface AnalyticsResult {
  data: unknown;
  error: string | null;
  errorCode: string | null;
}

/**
 * Parses a query's rows with `schema`, and keeps the last good answer while a
 * refresh loads (see useLastGood for AppKit's idle first render). `view` names
 * what the rows are for, such as one job's checks: an answer for another view
 * is never shown, so opening a second job never shows the first job's rows.
 */
export function useQueryRows<T>(query: AnalyticsResult, schema: z.ZodType<T>, where: WatchdogLocation, view: string): QueryRows<T> {
  const parsed = useMemo(() => (query.data === null ? null : parseRows(schema, query.data)), [query.data, schema]);
  const tagged = useMemo(() => (parsed === null ? null : { view, parsed }), [view, parsed]);
  const kept = useLastGood(tagged);
  const last = kept !== null && kept.view === view ? kept.parsed : null;

  if (where.problem) return { rows: null, bad: 0, loading: false, problem: where.problem };
  if (!where.ready) return { rows: null, bad: 0, loading: true, problem: null };
  if (query.error !== null) {
    return { rows: last?.rows ?? null, bad: last?.bad ?? 0, loading: false, problem: { kind: "query", message: query.error, code: query.errorCode } };
  }
  if (parsed === null) return { rows: last?.rows ?? null, bad: last?.bad ?? 0, loading: true, problem: null };
  if (parsed.rows.length === 0 && parsed.bad > 0) return { rows: null, bad: parsed.bad, loading: false, problem: { kind: "shape", bad: parsed.bad } };
  return { rows: parsed.rows, bad: parsed.bad, loading: false, problem: null };
}
