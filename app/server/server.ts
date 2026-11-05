import { analytics, createApp, genie, jobs, lakebase, server } from "@databricks/appkit";
import { registerAppConfigRoute } from "./app-config";
import { genieConversations, registerCopilotRoutes } from "./copilot/routes";
import { ensureSchema } from "./db/schema";
import { registerIdentityRoutes } from "./identity";
import { registerJobListRoutes } from "./joblist/routes";
import { registerScanRoutes } from "./scan/routes";

await createApp({
  plugins: [
    server({}),
    // A query's rows go to the browser as one SSE event, capped at 5 MiB by default. The history strip asks for
    // fixed windows (job_history.obo.sql), at most 43 per job and about 190 bytes per row: 8 KB per job, so the
    // default holds about 600 jobs. Allow 16 MiB for headroom over the 200 jobs this app is sized for.
    analytics({ streamConfig: { maxEventSize: 16 * 1024 * 1024 } }),
    lakebase({ pool: { max: 10 } }),
    jobs({}),
    // The copilot's Genie space (the app's genie-space resource), under the alias "default".
    genie({ spaces: { default: process.env.DATABRICKS_GENIE_SPACE_ID } }),
  ],
  async onPluginsReady(appkit) {
    try {
      await ensureSchema(appkit.lakebase.pool);
    } catch (error) {
      // Keep serving: Monitoring and the copilot work without Lakebase, and the job list routes report the error.
      console.error("[lakebase] Could not create the watchdog_app schema:", error instanceof Error ? error.message : error);
    }
    appkit.server.extend((app) => {
      registerIdentityRoutes(app);
      registerAppConfigRoute(app, appkit);
      registerJobListRoutes(app, { pool: appkit.lakebase.pool });
      registerCopilotRoutes(app, { conversations: genieConversations(appkit) });
      registerScanRoutes(app);
    });
  },
});
