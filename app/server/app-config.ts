import type { JobAPI } from "@databricks/appkit";
import type express from "express";
import type { AppConfig } from "../shared/joblist/types";

/**
 * Where the Watchdog tables are. The watchdog_scan job (the app's `job`
 * resource) is the only source: its parameter defaults hold the catalog, schema
 * and region. WATCHDOG_CATALOG, WATCHDOG_SCHEMA and WATCHDOG_REGION override
 * them for local development (so does WATCHDOG_CONFIG_SOURCE).
 */

/** The part of AppKit that getAppConfig reads: the jobs plugin's handle for the scan job. */
export interface ScanJobSource {
  jobs(key: string): Pick<JobAPI, "getJob">;
}

const CACHE_MS = 10 * 60 * 1000;

function firstValue(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** The app config plus where the scan reads the job list from (the scan job's config_source parameter). */
export type AppConfigResponse = AppConfig & { configSource: "yaml" | "lakebase" | null };

function configSourceOf(value: string): "yaml" | "lakebase" | null {
  const source = value.trim().toLowerCase();
  return source === "yaml" || source === "lakebase" ? source : null;
}

/** Env overrides win, then the scan job's parameter defaults, then the built-in defaults. */
export function buildAppConfig(env: NodeJS.ProcessEnv, jobParameters: Record<string, string>): AppConfigResponse {
  return {
    catalog: firstValue(env.WATCHDOG_CATALOG, jobParameters.catalog),
    schema: firstValue(env.WATCHDOG_SCHEMA, jobParameters.schema, "watchdog"),
    region: firstValue(env.WATCHDOG_REGION, jobParameters.region),
    appName: firstValue(env.DATABRICKS_APP_NAME, "watchdog-app"),
    lakebaseProject: firstValue(jobParameters.lakebase_project_id, "jobs-watchdog"),
    configSource: configSourceOf(firstValue(env.WATCHDOG_CONFIG_SOURCE, jobParameters.config_source)),
  };
}

/** The scan job's parameter defaults by name, or null when the job cannot be read. */
async function readScanJobParameters(source: ScanJobSource): Promise<Record<string, string> | null> {
  try {
    const result = await source.jobs("default").getJob();
    if (!result.ok) {
      console.warn(`[app-config] Could not read the scan job (${result.status}): ${result.message}`);
      return null;
    }
    const parameters = result.data.settings?.parameters ?? [];
    return Object.fromEntries(parameters.map((p) => [p.name, p.default]));
  } catch (error) {
    console.warn("[app-config] Could not read the scan job:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** The scan job's settings could not be read, and no environment variable names the catalog. */
export class AppConfigError extends Error {
  constructor() {
    super("The app could not read the scan job's settings. Check that the app can view the scan job, then try again.");
    this.name = "AppConfigError";
  }
}

const cache = new WeakMap<ScanJobSource, { value: AppConfigResponse; expiresAt: number }>();

/**
 * The app config, cached for 10 minutes. When the scan job cannot be read,
 * nothing is cached. The defaults apply if WATCHDOG_CATALOG names the catalog;
 * otherwise it throws an AppConfigError, since an empty catalog would only
 * look like a missing setting.
 */
export async function getAppConfig(appkit: ScanJobSource): Promise<AppConfigResponse> {
  const hit = cache.get(appkit);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const parameters = await readScanJobParameters(appkit);
  const value = buildAppConfig(process.env, parameters ?? {});
  if (!parameters && value.catalog === "") throw new AppConfigError();
  // A config with no catalog is not kept: the person fixes the job, and the next request should see it.
  if (parameters && value.catalog !== "") cache.set(appkit, { value, expiresAt: Date.now() + CACHE_MS });
  return value;
}

/** GET /api/app-config returns the AppConfig. */
export function registerAppConfigRoute(app: express.Application, appkit: ScanJobSource): void {
  app.get("/api/app-config", async (_req, res) => {
    try {
      res.json(await getAppConfig(appkit));
    } catch (error) {
      if (error instanceof AppConfigError) {
        res.status(503).json({ error: "app_config", message: error.message });
        return;
      }
      console.error("[app-config] Could not read the app config:", error);
      res.status(500).json({ error: "app_config", message: "The app could not read its settings. Try again." });
    }
  });
}
