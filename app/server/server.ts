import { analytics, createApp, genie, lakebase, server } from "@databricks/appkit";
import { registerAppConfigRoute } from "./app-config";
import { genieConversations, genieFeedback, registerCopilotNotSetUp, registerCopilotRoutes } from "./copilot/routes";
import { schemaErrorLog, schemaGate } from "./db/schema";
import { registerIdentityRoutes } from "./identity";
import { registerJobListRoutes } from "./joblist/routes";
import { scanNowJobs } from "./scan/jobs-plugin";
import { registerScanRoutes } from "./scan/routes";

/** The copilot's Genie space (the app's genie-space resource). Without it the app starts with the copilot off. */
const genieSpaceId = process.env.DATABRICKS_GENIE_SPACE_ID?.trim() || undefined;

await createApp({
  plugins: [
    server({}),
    // A query's rows go to the browser as one SSE event, capped at 5 MiB by default. The history strip asks for
    // fixed windows (job_history.obo.sql), at most 43 per job and about 190 bytes per row: 8 KB per job, so the
    // default holds about 600 jobs. Allow 16 MiB for headroom over the 200 jobs this app is sized for.
    analytics({ streamConfig: { maxEventSize: 16 * 1024 * 1024 } }),
    lakebase({ pool: { max: 10 } }),
    // AppKit's jobs plugin with Scan now's route only: its routes that read or cancel runs would run as the service principal.
    scanNowJobs({}),
    // The copilot's Genie space, under the alias "default". The plugin refuses to load without one.
    ...(genieSpaceId ? [genie({ spaces: { default: genieSpaceId } })] : []),
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
      if (genieSpaceId) registerCopilotRoutes(app, { conversations: genieConversations(appkit, genieSpaceId), feedback: genieFeedback(appkit, genieSpaceId) });
      else registerCopilotNotSetUp(app);
      registerScanRoutes(app);
    });
  },
});
