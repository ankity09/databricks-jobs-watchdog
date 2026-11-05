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

/** The fields of a run (server/scan/routes.ts sends ScanRun) that Scan now reads. */
const ScanRun = z.object({
  run_id: z.number(),
  life_cycle_state: z.string().nullable(),
  result_state: z.string().nullable(),
  run_page_url: z.string().nullable(),
});

/** GET /api/scan/latest-run: the scan job's run that has not ended, else its newest run; null when it has never run. */
const LatestRun = z.object({ run: ScanRun.nullable() });
/** GET /api/scan/runs/:runId. */
const OneRun = z.object({ run: ScanRun });
/** POST /api/jobs/default/run (the AppKit jobs plugin). */
const Started = z.object({ runId: z.number() });

/**
 * Scan now. It first reads the scan job's latest run from the app's own
 * uncached route (the jobs plugin caches run reads for 60 s): if a run has not
 * ended, it shows that run instead of starting another, so a second click, even
 * from another tab right after a start, starts nothing. Otherwise it starts a
 * run through the jobs plugin (as the app's service principal). Either way it
 * polls the run every 5 s, from the same uncached route, until it ends, then
 * calls onDone once.
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
        const { run } = await apiFetch(`/api/scan/runs/${runId}`, OneRun);
        if (!alive.current) return;
        failedPolls = 0;
        url = run.run_page_url ?? url;
        const lifeCycle = run.life_cycle_state;
        if (lifeCycle !== null && ENDED.has(lifeCycle)) {
          busy.current = false;
          setState({ kind: "done", result: run.result_state ?? lifeCycle, url });
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
      latest = await apiFetch("/api/scan/latest-run", LatestRun);
    } catch (error) {
      if (!alive.current) return;
      busy.current = false;
      setState({ kind: "error", message: `Could not check for a running scan: ${toApiError(error).message}` });
      return;
    }
    if (!alive.current) return;

    const newest = latest.run;
    if (newest !== null && newest.life_cycle_state !== null && ACTIVE.has(newest.life_cycle_state)) {
      const url = newest.run_page_url;
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

/** How a finished scan's result reads: success in the usual muted text, a failure in the failed tone, anything else in the warning tone. */
export type ScanResultTone = "muted" | "warning" | "failed";

const FAILED_RESULTS = new Set(["FAILED", "TIMEDOUT", "INTERNAL_ERROR", "UPSTREAM_FAILED"]);

export function scanResultTone(result: string): ScanResultTone {
  if (result === "SUCCESS") return "muted";
  return FAILED_RESULTS.has(result) ? "failed" : "warning";
}
