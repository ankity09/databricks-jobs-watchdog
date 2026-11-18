import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { AppConfigError, buildAppConfig, getAppConfig, registerAppConfigRoute } from "./app-config";

const jobDefaults = { catalog: "main", schema: "watchdog_prod", region: "us-east-2", lakebase_project_id: "jobs-watchdog-east" };

describe("buildAppConfig", () => {
  it("uses the scan job's parameter defaults", () => {
    expect(buildAppConfig({}, jobDefaults)).toEqual({
      catalog: "main", schema: "watchdog_prod", region: "us-east-2",
      appName: "watchdog-app", lakebaseProject: "jobs-watchdog-east", configSource: null,
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
      catalog: "", schema: "watchdog", region: "", appName: "watchdog-app", lakebaseProject: "jobs-watchdog", configSource: null,
    });
  });
  it("exposes where the scan reads the job list from, as the scan job's config_source parameter", () => {
    expect(buildAppConfig({}, { ...jobDefaults, config_source: "lakebase" }).configSource).toBe("lakebase");
    expect(buildAppConfig({}, { ...jobDefaults, config_source: " YAML " }).configSource).toBe("yaml");
  });
  it("leaves the config source unset when the parameter is missing or not a known source", () => {
    expect(buildAppConfig({}, jobDefaults).configSource).toBeNull();
    expect(buildAppConfig({}, { ...jobDefaults, config_source: "s3" }).configSource).toBeNull();
  });
  it("lets WATCHDOG_CONFIG_SOURCE override the job for local development", () => {
    expect(buildAppConfig({ WATCHDOG_CONFIG_SOURCE: "lakebase" }, { config_source: "yaml" }).configSource).toBe("lakebase");
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

  it("does not keep a config with no catalog, so fixing the job takes effect on the next request", async () => {
    for (const name of ["WATCHDOG_CATALOG", "WATCHDOG_SCHEMA", "WATCHDOG_REGION"]) vi.stubEnv(name, "");
    const { getJob, appkit } = scanJob({ ok: true, data: { settings: { parameters: [{ name: "region", default: "us-east-2" }] } } });
    expect((await getAppConfig(appkit)).catalog).toBe("");
    getJob.mockResolvedValue({ ok: true, data: { settings: { parameters: [{ name: "catalog", default: "main" }] } } });
    expect((await getAppConfig(appkit)).catalog).toBe("main");
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it("throws, and asks again next time, when the job cannot be read and no variable names the catalog", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("WATCHDOG_CATALOG", "");
    const { getJob, appkit } = scanJob({ ok: false, status: 403, message: "no access" });
    await expect(getAppConfig(appkit)).rejects.toBeInstanceOf(AppConfigError);
    await expect(getAppConfig(appkit)).rejects.toBeInstanceOf(AppConfigError);
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it("uses the defaults, uncached, when the job cannot be read but WATCHDOG_CATALOG names the catalog", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("WATCHDOG_CATALOG", "dev_catalog");
    vi.stubEnv("WATCHDOG_SCHEMA", "");
    const { getJob, appkit } = scanJob({ ok: false, status: 403, message: "no access" });
    expect(await getAppConfig(appkit)).toMatchObject({ catalog: "dev_catalog", schema: "watchdog", lakebaseProject: "jobs-watchdog" });
    await getAppConfig(appkit);
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
  });

  it("throws when reading the job throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("WATCHDOG_CATALOG", "");
    const appkit = { jobs: () => ({ getJob: vi.fn().mockRejectedValue(new Error("socket hang up")) }) };
    await expect(getAppConfig(appkit)).rejects.toBeInstanceOf(AppConfigError);
  });
});

describe("GET /api/app-config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function appWith(getJob: () => Promise<unknown>) {
    const app = express();
    registerAppConfigRoute(app, { jobs: () => ({ getJob }) } as never);
    return app;
  }

  it("answers 503 with the app_config error when the scan job cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("WATCHDOG_CATALOG", "");
    const res = await request(appWith(() => Promise.resolve({ ok: false, status: 403, message: "secret detail" }))).get("/api/app-config");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "app_config",
      message: "The app could not read the scan job's settings. Check that the app can view the scan job, then try again.",
    });
    expect(JSON.stringify(res.body)).not.toContain("secret detail");
  });

  it("answers 200 with the config when the job is read", async () => {
    vi.stubEnv("WATCHDOG_CATALOG", "");
    const res = await request(
      appWith(() => Promise.resolve({ ok: true, data: { settings: { parameters: [{ name: "catalog", default: "route_main" }] } } })),
    ).get("/api/app-config");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ catalog: "route_main" });
  });
});
