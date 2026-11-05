import type { JobAPI } from "@databricks/appkit";
import type express from "express";
import type { AppConfig } from "../shared/joblist/types";

/**
 * Where the Watchdog tables are. The watchdog_scan job (the app's `job`
 * resource) is the only source: its parameter defaults hold the catalog, schema
 * and region. WATCHDOG_CATALOG, WATCHDOG_SCHEMA and WATCHDOG_REGION override
 * them for local development.
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

/** Env overrides win, then the scan job's parameter defaults, then the built-in defaults. */
export function buildAppConfig(env: NodeJS.ProcessEnv, jobParameters: Record<string, string>): AppConfig {
  return {
    catalog: firstValue(env.WATCHDOG_CATALOG, jobParameters.catalog),
    schema: firstValue(env.WATCHDOG_SCHEMA, jobParameters.schema, "watchdog"),
    region: firstValue(env.WATCHDOG_REGION, jobParameters.region),
    appName: firstValue(env.DATABRICKS_APP_NAME, "watchdog-app"),
    lakebaseProject: firstValue(jobParameters.lakebase_project_id, "jobs-watchdog"),
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

const cache = new WeakMap<ScanJobSource, { value: AppConfig; expiresAt: number }>();

/** The app config, cached for 10 minutes. When the scan job cannot be read, the defaults apply and nothing is cached. */
export async function getAppConfig(appkit: ScanJobSource): Promise<AppConfig> {
  const hit = cache.get(appkit);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const parameters = await readScanJobParameters(appkit);
  const value = buildAppConfig(process.env, parameters ?? {});
  if (parameters) cache.set(appkit, { value, expiresAt: Date.now() + CACHE_MS });
  return value;
}

/** GET /api/app-config returns the AppConfig. */
export function registerAppConfigRoute(app: express.Application, appkit: ScanJobSource): void {
  app.get("/api/app-config", async (_req, res) => {
    try {
      res.json(await getAppConfig(appkit));
    } catch (error) {
      res.status(500).json({ error: "app_config", message: error instanceof Error ? error.message : "Could not read the app config" });
    }
  });
}
