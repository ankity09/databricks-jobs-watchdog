import { analytics, createApp, genie, jobs, lakebase, server } from "@databricks/appkit";
import { registerAppConfigRoute } from "./app-config";
import { genieConversations, registerCopilotRoutes } from "./copilot/routes";
import { schemaErrorLog, schemaGate } from "./db/schema";
import { registerIdentityRoutes } from "./identity";
import { registerJobListRoutes } from "./joblist/routes";
import { registerScanRoutes } from "./scan/routes";

await createApp({
  plugins: [
    server({}),
    // A query's rows go to the browser as one SSE event, capped at 5 MiB by default. The history strip's
    // 7 days of hourly scans is about 183 bytes per job and scan, over 5 MiB at about 170 jobs, so allow 16 MiB.
    analytics({ streamConfig: { maxEventSize: 16 * 1024 * 1024 } }),
    lakebase({ pool: { max: 10 } }),
    jobs({}),
    // The copilot's Genie space (the app's genie-space resource), under the alias "default".
    genie({ spaces: { default: process.env.DATABRICKS_GENIE_SPACE_ID } }),
  ],
  async onPluginsReady(appkit) {
    const schema = schemaGate(appkit.lakebase.pool);
    try {
      await schema.ready();
    } catch (error) {
      // Keep serving: Monitoring and the copilot work without Lakebase, and the job list tries again on each request.
      console.error(schemaErrorLog(error));
    }
    appkit.server.extend((app) => {
      registerIdentityRoutes(app);
      registerAppConfigRoute(app, appkit);
      registerJobListRoutes(app, { pool: appkit.lakebase.pool, ready: () => schema.ready() });
      registerCopilotRoutes(app, { conversations: genieConversations(appkit) });
      registerScanRoutes(app);
    });
  },
});
