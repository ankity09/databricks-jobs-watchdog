import { type IAppRouter, jobs } from "@databricks/appkit";

/**
 * AppKit's jobs plugin, with only the route the app uses: POST
 * /api/jobs/:jobKey/run, which Scan now calls. The plugin also mounts routes
 * that list and read the scan job's runs (parameters, who they run as, state
 * messages) and one that cancels a run, all as the app's service principal, so
 * anyone with access to the app could use them. The server still uses the
 * plugin's own API (getJob for app-config, the run route above).
 */

const RUN_PATH = "/:jobKey/run";
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "head", "options"]);

/** The router, except that only a POST to the run path is registered on it; other routes are dropped. */
export function onlyTheRunRoute(router: IAppRouter): IAppRouter {
  return new Proxy(router, {
    get(target, prop, receiver): unknown {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !ROUTE_METHODS.has(prop) || typeof value !== "function") return value;
      return (path: unknown, ...handlers: unknown[]): unknown =>
        prop === "post" && path === RUN_PATH ? (Reflect.apply(value, target, [path, ...handlers]) as unknown) : receiver;
    },
  });
}

const base = jobs({});

class ScanNowJobsPlugin extends base.plugin {
  injectRoutes(router: IAppRouter): void {
    super.injectRoutes(onlyTheRunRoute(router));
  }
}

/** jobs(config), with Scan now's route only. */
export function scanNowJobs(config: Parameters<typeof jobs>[0] = {}): Omit<ReturnType<typeof jobs>, "plugin"> & { plugin: typeof ScanNowJobsPlugin } {
  return { ...jobs(config), plugin: ScanNowJobsPlugin };
}
