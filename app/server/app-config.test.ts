import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAppConfig, getAppConfig } from "./app-config";

const jobDefaults = { catalog: "main", schema: "watchdog_prod", region: "us-east-2", lakebase_project_id: "jobs-watchdog-east" };

describe("buildAppConfig", () => {
  it("uses the scan job's parameter defaults", () => {
    expect(buildAppConfig({}, jobDefaults)).toEqual({
      catalog: "main", schema: "watchdog_prod", region: "us-east-2",
      appName: "watchdog-app", lakebaseProject: "jobs-watchdog-east",
    });
  });
  it("lets the WATCHDOG_ variables override the job for local development", () => {
    const env = { WATCHDOG_CATALOG: "dev_catalog", WATCHDOG_SCHEMA: "watchdog_dev", WATCHDOG_REGION: "eu-west-1" };
    expect(buildAppConfig(env, jobDefaults)).toMatchObject({ catalog: "dev_catalog", schema: "watchdog_dev", region: "eu-west-1" });
  });
  it("takes the app name from DATABRICKS_APP_NAME", () => {
    expect(buildAppConfig({ DATABRICKS_APP_NAME: "watchdog-app-east" }, jobDefaults).appName).toBe("watchdog-app-east");
  });
  it("falls back to the built-in defaults", () => {
    expect(buildAppConfig({}, {})).toEqual({
      catalog: "", schema: "watchdog", region: "", appName: "watchdog-app", lakebaseProject: "jobs-watchdog",
    });
  });
  it("skips empty values", () => {
    expect(buildAppConfig({ WATCHDOG_SCHEMA: "" }, { schema: "  " }).schema).toBe("watchdog");
  });
});

describe("getAppConfig", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function scanJob(result: unknown) {
    const getJob = vi.fn().mockResolvedValue(result);
    return { getJob, appkit: { jobs: () => ({ getJob }) } };
  }

  it("reads the scan job's parameters once, then caches them for 10 minutes", async () => {
    vi.useFakeTimers();
    for (const name of ["WATCHDOG_CATALOG", "WATCHDOG_SCHEMA", "WATCHDOG_REGION"]) vi.stubEnv(name, "");
    const { getJob, appkit } = scanJob({
      ok: true,
      data: { settings: { parameters: [{ name: "catalog", default: "main" }, { name: "region", default: "us-east-2" }] } },
    });
    expect(await getAppConfig(appkit)).toMatchObject({ catalog: "main", region: "us-east-2", schema: "watchdog" });
    await getAppConfig(appkit);
    expect(getJob).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await getAppConfig(appkit);
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it("falls back to the defaults, and asks again next time, when the job cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getJob, appkit } = scanJob({ ok: false, status: 403, message: "no access" });
    expect(await getAppConfig(appkit)).toMatchObject({ schema: "watchdog", lakebaseProject: "jobs-watchdog" });
    await getAppConfig(appkit);
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });
});
