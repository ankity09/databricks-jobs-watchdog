import { sql } from "@databricks/appkit-ui/js";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { useMemo } from "react";
import { z } from "zod";
import { type Status, toStatus } from "../lib/status";
import { useAppConfig } from "./useAppConfig";
import { useLastGood } from "./useLastGood";
import { useRefreshKey } from "./useRefreshKey";

const LiveStatusRows = z.array(z.object({ job_name: z.string(), status: z.string().nullable() }));

export interface LiveStatus {
  byJob: Map<string, Status>;
  loading: boolean;
  error: string | null;
}

/**
 * Each job's worst status in the newest scans (job_live_status.obo.sql, run as
 * the signed-in person). While a newer query loads (after a refresh or bump()),
 * `loading` is true and `byJob` keeps the last result.
 */
export function useLiveStatus(): LiveStatus {
  const { config, error: configError } = useAppConfig();
  const { refresh } = useRefreshKey();
  const ready = config !== null && config.catalog !== "";
  const parameters = useMemo(
    () => ({ catalog: sql.string(config?.catalog ?? ""), schema: sql.string(config?.schema ?? ""), refresh: sql.int(refresh) }),
    [config, refresh],
  );
  const query = useAnalyticsQuery("job_live_status", parameters, { autoStart: ready });
  // null until the current query answers (see useLastGood for why that includes an idle first render).
  const parsed = useMemo(() => (query.data === null ? null : LiveStatusRows.safeParse(query.data)), [query.data]);
  const fresh = useMemo(
    () => (parsed?.success ? new Map(parsed.data.map((row) => [row.job_name, toStatus(row.status)] as const)) : null),
    [parsed],
  );
  const empty = useMemo(() => new Map<string, Status>(), []);
  const byJob = useLastGood(fresh) ?? empty;

  if (configError) return { byJob, loading: false, error: configError.message };
  if (config === null) return { byJob, loading: true, error: null };
  if (!ready) return { byJob, loading: false, error: "The scan job has no catalog, so the app cannot find the Watchdog tables." };
  if (query.error) return { byJob, loading: false, error: query.error };
  if (parsed === null) return { byJob, loading: true, error: null };
  if (!parsed.success) return { byJob, loading: false, error: "The live status rows had an unexpected shape." };
  return { byJob, loading: false, error: null };
}
