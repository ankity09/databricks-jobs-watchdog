import { z } from "zod";
import type { AppConfig } from "../../../shared/joblist/types";
import { type ApiError, apiFetch } from "../lib/api";
import { cachedRequest, useCachedRequest } from "./useCachedRequest";

const AppConfigSchema = z.object({
  catalog: z.string(),
  schema: z.string(),
  region: z.string(),
  appName: z.string(),
  lakebaseProject: z.string(),
}) satisfies z.ZodType<AppConfig>;

/** GET /api/app-config, fetched once per page. */
export const appConfigRequest = cachedRequest(() => apiFetch("/api/app-config", AppConfigSchema));

export interface AppConfigState {
  config: AppConfig | null;
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
