import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { apiFetch, toApiError } from "../lib/api";

/** Where Scan now is: checking for a running scan, waiting for one, or finished. */
export type ScanState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "running"; runId: number; url: string | null; alreadyRunning: boolean }
  | { kind: "done"; result: string; url: string | null }
  | { kind: "error"; message: string };

export interface ScanNow {
  state: ScanState;
  /** Starts watchdog_scan, unless a run of it is already going. `this: void`: safe to destructure. */
  start(this: void): Promise<void>;
}

/** Life cycle states of a run that has not ended (Jobs API). WAITING_FOR_RETRY is one too. */
const ACTIVE = new Set(["PENDING", "QUEUED", "RUNNING", "BLOCKED", "TERMINATING", "WAITING_FOR_RETRY"]);
/** Life cycle states of a run that has ended. */
const ENDED = new Set(["TERMINATED", "SKIPPED", "INTERNAL_ERROR"]);
const POLL_MS = 5_000;
/** One failed poll is a blip; three in a row stop the watch. */
const MAX_FAILED_POLLS = 3;

/** The fields of an SDK Run that Scan now reads. */
const Run = z.object({
  run_id: z.number(),
  run_page_url: z.string().nullish(),
  state: z.object({ life_cycle_state: z.string().nullish(), result_state: z.string().nullish() }).nullish(),
});
type Run = z.infer<typeof Run>;

/** GET /api/jobs/default/status: the newest run of the scan job, or null when it has never run. */
const LatestRun = z.object({ status: z.string().nullable(), run: Run.nullable() });
/** POST /api/jobs/default/run. */
const Started = z.object({ runId: z.number() });

function lifeCycleOf(run: Run): string | null {
  return run.state?.life_cycle_state ?? null;
}

/**
 * Scan now, through the AppKit jobs plugin (the job runs as the app's service
 * principal). It first reads the scan job's newest run: if that run has not
 * ended, it shows that run instead of starting another. Otherwise it starts a
 * run. Either way it polls the run every 5 s until it ends, then calls onDone
 * once. The plugin caches run reads for up to 60 s, so a state change can
 * show up to a minute late.
 */
export function useScanNow(onDone: () => void): ScanNow {
  const [state, setState] = useState<ScanState>({ kind: "idle" });
  const onDoneRef = useRef(onDone);
  const alive = useRef(true);
  const busy = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  /** Polls one run until it ends. */
  const watch = useCallback((runId: number, firstUrl: string | null, alreadyRunning: boolean) => {
    let url = firstUrl;
    let failedPolls = 0;
    const poll = async () => {
      timer.current = null;
      try {
        const run = await apiFetch(`/api/jobs/default/runs/${runId}`, Run);
        if (!alive.current) return;
        failedPolls = 0;
        url = run.run_page_url ?? url;
        const lifeCycle = lifeCycleOf(run);
        if (lifeCycle !== null && ENDED.has(lifeCycle)) {
          busy.current = false;
          setState({ kind: "done", result: run.state?.result_state ?? lifeCycle, url });
          onDoneRef.current();
          return;
        }
        setState({ kind: "running", runId, url, alreadyRunning });
      } catch (error) {
        if (!alive.current) return;
        failedPolls += 1;
        if (failedPolls >= MAX_FAILED_POLLS) {
          busy.current = false;
          setState({ kind: "error", message: `Could not read the scan's progress: ${toApiError(error).message}` });
          return;
        }
      }
      timer.current = window.setTimeout(() => void poll(), POLL_MS);
    };
    timer.current = window.setTimeout(() => void poll(), POLL_MS);
  }, []);

  const start = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setState({ kind: "checking" });

    let latest: z.infer<typeof LatestRun>;
    try {
      latest = await apiFetch("/api/jobs/default/status", LatestRun);
    } catch (error) {
      if (!alive.current) return;
      busy.current = false;
      setState({ kind: "error", message: `Could not check for a running scan: ${toApiError(error).message}` });
      return;
    }
    if (!alive.current) return;

    const newest = latest.run;
    const newestState = newest === null ? latest.status : (lifeCycleOf(newest) ?? latest.status);
    if (newest !== null && newestState !== null && ACTIVE.has(newestState)) {
      const url = newest.run_page_url ?? null;
      setState({ kind: "running", runId: newest.run_id, url, alreadyRunning: true });
      watch(newest.run_id, url, true);
      return;
    }

    let runId: number;
    try {
      ({ runId } = await apiFetch("/api/jobs/default/run", Started, { method: "POST", body: JSON.stringify({}) }));
    } catch (error) {
      if (!alive.current) return;
      busy.current = false;
      setState({ kind: "error", message: `Could not start the scan: ${toApiError(error).message}` });
      return;
    }
    if (!alive.current) return;
    setState({ kind: "running", runId, url: null, alreadyRunning: false });
    watch(runId, null, false);
  }, [watch]);

  return { state, start };
}

const RESULTS: Record<string, string> = {
  SUCCESS: "Succeeded",
  SUCCESS_WITH_FAILURES: "Succeeded with failures",
  FAILED: "Failed",
  TIMEDOUT: "Timed out",
  CANCELED: "Canceled",
  CANCELLED: "Canceled",
  SKIPPED: "Skipped",
  MAXIMUM_CONCURRENT_RUNS_REACHED: "Skipped, a run was already going",
  EXCLUDED: "Excluded",
  UPSTREAM_FAILED: "Upstream failed",
  UPSTREAM_CANCELED: "Upstream canceled",
  INTERNAL_ERROR: "Internal error",
};

/** A run's result_state (or life cycle state) in words. */
export function scanResultLabel(result: string): string {
  return RESULTS[result] ?? result.charAt(0) + result.slice(1).toLowerCase().replaceAll("_", " ");
}
