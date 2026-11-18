import { z } from "zod";
import type { AppConfig } from "../../../shared/joblist/types";
import { type ApiError, apiFetch } from "../lib/api";
import { cachedRequest, useCachedRequest } from "./useCachedRequest";

/** The app config, plus where the scan reads the job list from (null when the scan job does not say). */
export type WatchdogConfig = AppConfig & { configSource?: "yaml" | "lakebase" | null };

const AppConfigSchema = z.object({
  catalog: z.string(),
  schema: z.string(),
  region: z.string(),
  appName: z.string(),
  lakebaseProject: z.string(),
  configSource: z.enum(["yaml", "lakebase"]).nullable().optional(),
}) satisfies z.ZodType<WatchdogConfig>;

/** GET /api/app-config, fetched once per page. */
export const appConfigRequest = cachedRequest(
  () => apiFetch("/api/app-config", AppConfigSchema),
  // A config with no catalog is fixed in the scan job, not here: Retry asks again.
  (config) => config.catalog !== "",
);

export interface AppConfigState {
  config: WatchdogConfig | null;
  loading: boolean;
  error: ApiError | null;
}

/**
 * Where the Watchdog tables are (catalog, schema, region), and the app's names.
 * When `retryKey` changes after a failed load, it loads again (see useCachedRequest).
 */
export function useAppConfig(retryKey?: unknown): AppConfigState {
  const { value, loading, error } = useCachedRequest(appConfigRequest, retryKey);
  return { config: value, loading, error };
}
