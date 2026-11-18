import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { onlyTheRunRoute } from "./jobs-plugin";

/** Registers routes the way AppKit's jobs plugin does: router[method](path, handler). */
function mountLikeTheJobsPlugin(): express.Application {
  const router = express.Router();
  const routes = onlyTheRunRoute(router);
  const ok = (name: string): express.RequestHandler => (_req, res) => {
    res.json({ route: name });
  };
  routes.post("/:jobKey/run", ok("run"));
  routes.get("/:jobKey/runs", ok("runs"));
  routes.get("/:jobKey/runs/:runId", ok("run-detail"));
  routes.get("/:jobKey/status", ok("status"));
  routes.delete("/:jobKey/runs/:runId", ok("cancel-run"));
  const app = express();
  app.use("/api/jobs", router);
  return app;
}

describe("onlyTheRunRoute", () => {
  it("keeps Scan now's POST .../run and drops the routes that read or cancel runs", async () => {
    const app = mountLikeTheJobsPlugin();
    expect((await request(app).post("/api/jobs/default/run")).body).toEqual({ route: "run" });
    for (const call of [request(app).get("/api/jobs/default/runs"), request(app).get("/api/jobs/default/runs/7"),
      request(app).get("/api/jobs/default/status"), request(app).delete("/api/jobs/default/runs/7")]) {
      expect((await call).status).toBe(404);
    }
  });
});
