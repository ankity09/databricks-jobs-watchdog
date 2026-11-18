import { useAppConfig } from "./useAppConfig";
import { useJobList } from "./useJobList";
import { useRefreshKey } from "./useRefreshKey";

/**
 * What to tell a person when there are no scan results yet:
 * - "loading": still finding out;
 * - "add-jobs": the scan reads the job list from Lakebase and that list has no jobs, so a scan can only fail;
 * - "scan": the list is not the problem (or cannot be read), so Scan now or the schedule will fill the page.
 *
 * Only mount a component that calls this when there are no results: it reads the job list.
 */
export type NoScansAdvice = "loading" | "add-jobs" | "scan";

export function useNoScansAdvice(): NoScansAdvice {
  const { refresh } = useRefreshKey();
  const { config, loading: configLoading } = useAppConfig(refresh);
  const list = useJobList();
  if (configLoading) return "loading";
  if (config?.configSource !== "lakebase") return "scan";
  if (list.state === null) return list.error ? "scan" : "loading";
  return list.state.document.jobs.length === 0 ? "add-jobs" : "scan";
}
