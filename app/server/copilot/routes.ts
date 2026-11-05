import type { LakebasePool } from "@databricks/appkit";
import type express from "express";

/**
 * The copilot's own routes under /api/copilot. Task 8 registers them; nothing is
 * registered yet. The chat itself goes through the AppKit genie plugin, at
 * /api/genie/default/messages and /api/genie/default/conversations/:id.
 */
export function registerCopilotRoutes(_app: express.Application, _ctx: { pool: LakebasePool }): void {
  // Task 8 adds the routes here.
}
