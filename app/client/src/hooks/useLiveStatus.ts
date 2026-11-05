import { sql } from "@databricks/appkit-ui/js";
import { useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { useMemo } from "react";
import { z } from "zod";
import { type Status, toStatus } from "../lib/status";
import { useAppConfig } from "./useAppConfig";
import { useRefreshKey } from "./useRefreshKey";

const LiveStatusRows = z.array(z.object({ job_name: z.string(), status: z.string().nullable() }));

export interface LiveStatus {
  byJob: Map<string, Status>;
  loading: boolean;
  error: string | null;
}

/** Each job's worst status in the newest scans (job_live_status.obo.sql, run as the signed-in person). */
export function useLiveStatus(): LiveStatus {
  const { config, loading: configLoading, error: configError } = useAppConfig();
  const { refresh } = useRefreshKey();
  const ready = config !== null && config.catalog !== "";
  const parameters = useMemo(
    () => ({ catalog: sql.string(config?.catalog ?? ""), schema: sql.string(config?.schema ?? ""), refresh: sql.int(refresh) }),
    [config, refresh],
  );
  const query = useAnalyticsQuery("job_live_status", parameters, { autoStart: ready });
  const rows = useMemo(() => LiveStatusRows.safeParse(query.data ?? []), [query.data]);
  const byJob = useMemo(
    () => new Map(rows.success ? rows.data.map((row) => [row.job_name, toStatus(row.status)] as const) : []),
    [rows],
  );

  if (configError) return { byJob, loading: false, error: configError.message };
  if (config !== null && !ready) {
    return { byJob, loading: false, error: "The scan job has no catalog, so the app cannot find the Watchdog tables." };
  }
  if (query.error) return { byJob, loading: false, error: query.error };
  if (!rows.success) return { byJob, loading: false, error: "The live status rows had an unexpected shape." };
  return { byJob, loading: configLoading || (ready && query.loading), error: null };
}
