import type express from "express";

/**
 * Scan now's reads of the scan job's runs, from the Jobs API as the app's
 * service principal, fresh on every request. The jobs plugin caches its run
 * reads (getRun, lastRun, listRuns) for 60 s, server-wide, and AppKit 0.84 has
 * no setting for that. So a run started a moment ago could look absent for a
 * minute, and a second click would start a second scan; and "Done" showed up to
 * a minute after the run ended. Starting a run stays on the plugin
 * (POST /api/jobs/default/run).
 *
 * GET /api/scan/latest-run   { run }: the scan job's run that has not ended, if
 *                            there is one, else its newest run; null when the
 *                            job has never run.
 * GET /api/scan/runs/:runId  { run }: one run of the scan job, for polling it
 *                            (404 for a run of another job).
 */

/** A run as these routes send it. Times are ISO 8601 in UTC; end_time is null until the run ends. */
export interface ScanRun {
  run_id: number;
  life_cycle_state: string | null;
  result_state: string | null;
  trigger: string | null;
  start_time: string | null;
  end_time: string | null;
  run_page_url: string | null;
}

/** The fields of a Jobs API run that these routes read. */
export interface JobsRun {
  run_id?: number;
  job_id?: number;
  run_page_url?: string;
  trigger?: string;
  start_time?: number;
  end_time?: number;
  state?: { life_cycle_state?: string; result_state?: string };
  /** The Jobs API 2.2 status. Its state stands in when `state` is missing. */
  status?: { state?: string };
}

/** The part of the Jobs API these routes call. A WorkspaceClient's `jobs` fits. */
export interface ScanJobsApi {
  listRuns(request: { job_id: number; active_only?: boolean; limit?: number }): AsyncIterable<JobsRun>;
  getRun(request: { run_id: number }): Promise<JobsRun>;
}

export interface ScanRouteOptions {
  /** The Jobs API as the app's service principal. Defaults to AppKit's service client, the one its plugins use. */
  jobsApi?: () => ScanJobsApi | Promise<ScanJobsApi>;
  /** The scan job's ID. Defaults to DATABRICKS_JOB_ID (the app's `job` resource), as the jobs plugin reads it. */
  jobId?: () => number | null;
}

/**
 * AppKit's service principal client. (AppKit 0.84 exports `getWorkspaceClient`
 * from @databricks/lakebase, which builds a new client each call, so this reads
 * the service context instead.) Imported on first use, so tests that pass their
 * own Jobs API never load AppKit.
 */
async function servicePrincipalJobs(): Promise<ScanJobsApi> {
  const { ServiceContext } = await import("@databricks/appkit");
  return ServiceContext.get().client.jobs;
}

function jobIdFromEnv(): number | null {
  const parsed = Number.parseInt(process.env.DATABRICKS_JOB_ID ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseRunId(value: string): number | null {
  if (!/^\d{1,16}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** The status.state names that differ from the life cycle state they stand for. */
const LIFE_CYCLE_OF_STATUS: Record<string, string> = { WAITING: "WAITING_FOR_RETRY" };

function isoTime(ms: number | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

function toScanRun(run: JobsRun, runId: number): ScanRun {
  const statusState = run.status?.state;
  return {
    run_id: runId,
    life_cycle_state: run.state?.life_cycle_state ?? (statusState ? (LIFE_CYCLE_OF_STATUS[statusState] ?? statusState) : null),
    result_state: run.state?.result_state ?? null,
    trigger: run.trigger ?? null,
    start_time: isoTime(run.start_time),
    end_time: isoTime(run.end_time),
    run_page_url: run.run_page_url ?? null,
  };
}

/** The first run of a list, without reading further pages. */
async function firstRun(runs: AsyncIterable<JobsRun>): Promise<JobsRun | null> {
  const iterator = runs[Symbol.asyncIterator]();
  try {
    const next = await iterator.next();
    return next.done ? null : next.value;
  } finally {
    await iterator.return?.();
  }
}

function statusCodeOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return null;
  return typeof error.statusCode === "number" ? error.statusCode : null;
}

function sendJobsError(res: express.Response, error: unknown, notFoundMessage?: string): void {
  const code = statusCodeOf(error);
  const message = error instanceof Error ? error.message : String(error);
  if (notFoundMessage && (code === 400 || code === 404)) {
    res.status(404).json({ error: "not_found", message: notFoundMessage });
    return;
  }
  if (code === 401 || code === 403) {
    res.status(403).json({
      error: "forbidden",
      message: `The app's service principal cannot read the scan job's runs. Give it CAN MANAGE RUN on the job (the app's job resource). ${message}`,
    });
    return;
  }
  console.error("[scan] The Jobs API call failed:", message);
  res.status(502).json({ error: "jobs_api", message: `The Jobs API did not answer: ${message}` });
}

function sendNoScanJob(res: express.Response): void {
  res.status(503).json({ error: "no_scan_job", message: "The app has no scan job: DATABRICKS_JOB_ID is not set. Add the watchdog_scan job as the app's job resource." });
}

export function registerScanRoutes(app: express.Application, options: ScanRouteOptions = {}): void {
  const jobsApi = options.jobsApi ?? servicePrincipalJobs;
  const scanJobId = options.jobId ?? jobIdFromEnv;

  app.get("/api/scan/latest-run", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const jobId = scanJobId();
    if (jobId === null) {
      sendNoScanJob(res);
      return;
    }
    try {
      const api = await jobsApi();
      // A run that has not ended first: a newer one may already have ended, skipped because this one was going.
      const run = (await firstRun(api.listRuns({ job_id: jobId, active_only: true, limit: 1 }))) ?? (await firstRun(api.listRuns({ job_id: jobId, limit: 1 })));
      res.json({ run: run?.run_id === undefined ? null : toScanRun(run, run.run_id) });
    } catch (error) {
      sendJobsError(res, error);
    }
  });

  app.get("/api/scan/runs/:runId", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const jobId = scanJobId();
    if (jobId === null) {
      sendNoScanJob(res);
      return;
    }
    const runId = parseRunId(req.params.runId);
    if (runId === null) {
      res.status(400).json({ error: "bad_run_id", message: "A run ID is a positive whole number." });
      return;
    }
    try {
      const api = await jobsApi();
      const run = await api.getRun({ run_id: runId });
      if (run.job_id !== jobId) {
        res.status(404).json({ error: "not_found", message: `Run ${runId} is not a run of the scan job.` });
        return;
      }
      res.json({ run: toScanRun(run, runId) });
    } catch (error) {
      sendJobsError(res, error, `The scan job has no run ${runId}.`);
    }
  });
}
