import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type JobsRun, registerScanRoutes, type ScanJobsApi, type ScanRun } from "./routes";

const JOB_ID = 1;

/** The fields the tests read from a response body; the routes' contract fixes their types. */
interface Body {
  run: ScanRun | null;
  runId: number;
  error: string;
  message: string;
}
const body = (res: { body: unknown }): Body => res.body as Body;
const ENDED = new Set(["TERMINATED", "SKIPPED", "INTERNAL_ERROR"]);
const T = (iso: string) => Date.parse(iso);

function scanRun(runId: number, lifeCycle: string, extra: Partial<JobsRun> = {}): JobsRun {
  return {
    run_id: runId,
    job_id: JOB_ID,
    run_page_url: `https://workspace.example.com/jobs/${JOB_ID}/runs/${runId}`,
    trigger: "PERIODIC",
    start_time: T("2026-11-05T05:05:02Z"),
    end_time: 0,
    state: { life_cycle_state: lifeCycle },
    ...extra,
  };
}

/**
 * A Jobs API with one job's runs, newest first, as runs/list returns them.
 * `runNow` adds a PENDING run, as the jobs plugin's POST /api/jobs/default/run
 * does through the same API. Nothing is cached: each call sees the runs as they are.
 */
function fakeJobs(initial: JobsRun[] = []) {
  const runs = [...initial];
  let nextId = 101;
  const api = {
    listRuns: vi.fn(async function* (req: { job_id: number; active_only?: boolean; limit?: number }) {
      await Promise.resolve();
      for (const run of runs) {
        if (run.job_id !== req.job_id) continue;
        if (req.active_only && ENDED.has(run.state?.life_cycle_state ?? "")) continue;
        yield run;
      }
    }),
    getRun: vi.fn((req: { run_id: number }) => {
      const run = runs.find((candidate) => candidate.run_id === req.run_id);
      if (run) return Promise.resolve(run);
      return Promise.reject(Object.assign(new Error(`Run ${req.run_id} does not exist.`), { statusCode: 400 }));
    }),
  } satisfies ScanJobsApi;
  return {
    api,
    runs,
    runNow(): number {
      const runId = nextId++;
      runs.unshift(scanRun(runId, "PENDING", { trigger: "ONE_TIME", start_time: T("2026-11-05T05:20:00Z") }));
      return runId;
    },
  };
}

function appWith(api: ScanJobsApi, jobId: number | null = JOB_ID) {
  const app = express();
  registerScanRoutes(app, { jobsApi: () => api, jobId: () => jobId });
  return app;
}

describe("GET /api/scan/latest-run", () => {
  it("returns the scan job's newest run: its state, trigger, times and link, never cached", async () => {
    const jobs = fakeJobs([
      scanRun(70, "TERMINATED", {
        trigger: "ONE_TIME",
        start_time: T("2026-11-05T04:37:15Z"),
        end_time: T("2026-11-05T04:40:28Z"),
        state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      }),
    ]);
    const res = await request(appWith(jobs.api)).get("/api/scan/latest-run");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      run: {
        run_id: 70,
        life_cycle_state: "TERMINATED",
        result_state: "SUCCESS",
        trigger: "ONE_TIME",
        start_time: "2026-11-05T04:37:15.000Z",
        end_time: "2026-11-05T04:40:28.000Z",
        run_page_url: "https://workspace.example.com/jobs/1/runs/70",
      },
    });
    expect(jobs.api.listRuns).toHaveBeenCalledWith({ job_id: JOB_ID, active_only: true, limit: 1 });
  });

  it("returns run: null when the scan job has never run", async () => {
    const res = await request(appWith(fakeJobs().api)).get("/api/scan/latest-run");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ run: null });
  });

  it("puts a run that has not ended ahead of a newer one that was skipped", async () => {
    const jobs = fakeJobs([
      scanRun(72, "TERMINATED", { state: { life_cycle_state: "TERMINATED", result_state: "SKIPPED" }, start_time: T("2026-11-05T06:05:02Z") }),
      scanRun(71, "RUNNING"),
    ]);
    const res = await request(appWith(jobs.api)).get("/api/scan/latest-run");
    expect(body(res).run).toMatchObject({ run_id: 71, life_cycle_state: "RUNNING", end_time: null });
  });

  it("returns a run that waits for a retry as a run that has not ended", async () => {
    const jobs = fakeJobs([scanRun(73, "WAITING_FOR_RETRY")]);
    const res = await request(appWith(jobs.api)).get("/api/scan/latest-run");
    expect(body(res).run).toMatchObject({ run_id: 73, life_cycle_state: "WAITING_FOR_RETRY" });
  });

  it("reads the life cycle from the Jobs API 2.2 status when the run has no state", async () => {
    const jobs = fakeJobs([scanRun(74, "QUEUED", { state: undefined, status: { state: "WAITING" } })]);
    const res = await request(appWith(jobs.api)).get("/api/scan/latest-run");
    expect(body(res).run).toMatchObject({ run_id: 74, life_cycle_state: "WAITING_FOR_RETRY", result_state: null });
  });

  it("asks the Jobs API on every request, so a change shows at once", async () => {
    const jobs = fakeJobs([scanRun(75, "RUNNING")]);
    const app = appWith(jobs.api);
    expect(body(await request(app).get("/api/scan/latest-run")).run).toMatchObject({ life_cycle_state: "RUNNING" });
    jobs.runs[0] = scanRun(75, "TERMINATED", { state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" }, end_time: T("2026-11-05T05:08:10Z") });
    expect(body(await request(app).get("/api/scan/latest-run")).run).toMatchObject({ life_cycle_state: "TERMINATED", result_state: "SUCCESS", end_time: "2026-11-05T05:08:10.000Z" });
  });

  describe("the race between two clicks on Scan now", () => {
    /** A click, as useScanNow makes one: read the latest run; start a run only when none is going. */
    async function click(app: express.Express): Promise<string> {
      const { run } = body(await request(app).get("/api/scan/latest-run"));
      if (run?.life_cycle_state && !ENDED.has(run.life_cycle_state)) return `already running ${run.run_id}`;
      const started = await request(app).post("/api/jobs/default/run").send({});
      return `started ${body(started).runId}`;
    }

    it("a second click right after the POST sees the new run, and makes no POST", async () => {
      const jobs = fakeJobs([scanRun(70, "TERMINATED", { state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" } })]);
      const app = appWith(jobs.api);
      // A stand-in for the jobs plugin's route, which calls runs/run-now through the same Jobs API.
      const posts = vi.fn((_req: express.Request, res: express.Response) => {
        res.json({ runId: jobs.runNow() });
      });
      app.post("/api/jobs/default/run", posts);

      expect(await click(app)).toBe("started 101");
      expect(await click(app)).toBe("already running 101");
      expect(posts).toHaveBeenCalledTimes(1);
      expect(jobs.runs.filter((run) => run.trigger === "ONE_TIME")).toHaveLength(1);
    });
  });

  it("says what is missing when the app has no scan job", async () => {
    const res = await request(appWith(fakeJobs().api, null)).get("/api/scan/latest-run");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "no_scan_job" });
    expect(body(res).message).toContain("DATABRICKS_JOB_ID");
  });

  it("names the service principal when the Jobs API refuses it", async () => {
    const api: ScanJobsApi = {
      listRuns: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(Object.assign(new Error("PERMISSION_DENIED: no view permission"), { statusCode: 403 })) }),
      }),
      getRun: vi.fn(),
    };
    const res = await request(appWith(api)).get("/api/scan/latest-run");
    expect(res.status).toBe(403);
    expect(body(res).error).toBe("forbidden");
    expect(body(res).message).toContain("service principal");
    expect(body(res).message).toContain("PERMISSION_DENIED");
  });

  it("answers 502 with the reason when the Jobs API fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api: ScanJobsApi = {
      listRuns: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("socket hang up")) }) }),
      getRun: vi.fn(),
    };
    const res = await request(appWith(api)).get("/api/scan/latest-run");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "jobs_api", message: "The Jobs API did not answer: socket hang up" });
    error.mockRestore();
  });

  it("stops reading pages once it has the first run", async () => {
    let pulled = 0;
    const api: ScanJobsApi = {
      listRuns: async function* () {
        for (const runId of [80, 79, 78]) {
          pulled += 1;
          await Promise.resolve();
          yield scanRun(runId, "RUNNING");
        }
      },
      getRun: vi.fn(),
    };
    const res = await request(appWith(api)).get("/api/scan/latest-run");
    expect(body(res).run).toMatchObject({ run_id: 80 });
    expect(pulled).toBe(1);
  });
});

describe("GET /api/scan/runs/:runId", () => {
  it("returns one run of the scan job, as it is now", async () => {
    const jobs = fakeJobs([scanRun(77, "RUNNING")]);
    const app = appWith(jobs.api);
    const first = await request(app).get("/api/scan/runs/77");
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(body(first).run).toMatchObject({ run_id: 77, life_cycle_state: "RUNNING", result_state: null, end_time: null });

    jobs.runs[0] = scanRun(77, "TERMINATED", { state: { life_cycle_state: "TERMINATED", result_state: "FAILED" }, end_time: T("2026-11-05T05:09:00Z") });
    const second = await request(app).get("/api/scan/runs/77");
    expect(body(second).run).toMatchObject({ life_cycle_state: "TERMINATED", result_state: "FAILED", end_time: "2026-11-05T05:09:00.000Z" });
    expect(jobs.api.getRun).toHaveBeenCalledTimes(2);
  });

  it("answers 404 for a run of another job, and for a run that does not exist", async () => {
    const jobs = fakeJobs([scanRun(90, "RUNNING", { job_id: 999 })]);
    const app = appWith(jobs.api);
    const other = await request(app).get("/api/scan/runs/90");
    expect(other.status).toBe(404);
    expect(body(other).error).toBe("not_found");
    const missing = await request(app).get("/api/scan/runs/91");
    expect(missing.status).toBe(404);
    expect(body(missing).error).toBe("not_found");
  });

  it.each(["abc", "0", "1.5", "-3", "99999999999999999999"])("answers 400 for the run ID %s, without asking the Jobs API", async (runId) => {
    const jobs = fakeJobs();
    const res = await request(appWith(jobs.api)).get(`/api/scan/runs/${runId}`);
    expect(res.status).toBe(400);
    expect(body(res).error).toBe("bad_run_id");
    expect(jobs.api.getRun).not.toHaveBeenCalled();
  });
});

describe("the scan job's ID", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("comes from DATABRICKS_JOB_ID, as the jobs plugin reads it", async () => {
    vi.stubEnv("DATABRICKS_JOB_ID", "123456789012345");
    const jobs = fakeJobs();
    const app = express();
    registerScanRoutes(app, { jobsApi: () => jobs.api });
    await request(app).get("/api/scan/latest-run");
    expect(jobs.api.listRuns).toHaveBeenCalledWith({ job_id: 123456789012345, active_only: true, limit: 1 });

    vi.stubEnv("DATABRICKS_JOB_ID", "");
    expect((await request(app).get("/api/scan/latest-run")).status).toBe(503);
  });
});
