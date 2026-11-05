// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScanNow } from "./useScanNow";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const RUN_URL = "https://workspace.example.com/jobs/1/runs/77";

interface Routes {
  /** GET /api/scan/latest-run. */
  latest: () => Response;
  /** POST /api/jobs/default/run (the jobs plugin). */
  run?: () => Response;
  /** Each poll of GET /api/scan/runs/:runId takes the next answer; the last one repeats. */
  polls?: Array<() => Response>;
}

/** fetch for Scan now's routes. Returns the calls made, as "METHOD path". */
function mockJobs(routes: Routes): string[] {
  const calls: string[] = [];
  let poll = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url === "/api/scan/latest-run") return Promise.resolve(routes.latest());
      if (url === "/api/jobs/default/run" && method === "POST") return Promise.resolve(routes.run?.() ?? json({ error: "No run route" }, 500));
      if (url.startsWith("/api/scan/runs/")) {
        const answers = routes.polls ?? [];
        const answer = answers[Math.min(poll, answers.length - 1)];
        poll += 1;
        return Promise.resolve(answer ? answer() : json({ error: "No poll route" }, 500));
      }
      return Promise.resolve(json({ error: "not_found" }, 404));
    }),
  );
  return calls;
}

/** A run as server/scan/routes.ts sends it. */
function scanRun(runId: number, lifeCycle: string, resultState: string | null = null, url: string | null = `https://workspace.example.com/jobs/1/runs/${runId}`) {
  return {
    run_id: runId,
    life_cycle_state: lifeCycle,
    result_state: resultState,
    trigger: "ONE_TIME",
    start_time: "2026-11-05T05:20:00.000Z",
    end_time: lifeCycle === "TERMINATED" ? "2026-11-05T05:23:10.000Z" : null,
    run_page_url: url,
  };
}

/** A poll of run 77. */
function run(lifeCycle: string, resultState?: string, url: string | null = RUN_URL) {
  return () => json({ run: scanRun(77, lifeCycle, resultState ?? null, url) });
}

const idleLatest = () => json({ run: scanRun(70, "TERMINATED", "SUCCESS") });

/** Runs the timers that are due within `ms`, and lets the fetches they start settle. */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const polls = (calls: string[]) => calls.filter((call) => call.startsWith("GET /api/scan/runs/"));

describe("useScanNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["PENDING", "QUEUED", "RUNNING", "BLOCKED", "TERMINATING", "WAITING_FOR_RETRY"])(
    "shows the scan that is already %s, and starts no other",
    async (lifeCycle) => {
      const calls = mockJobs({ latest: () => json({ run: scanRun(55, lifeCycle) }) });
      const { result } = renderHook(() => useScanNow(vi.fn()));
      await act(() => result.current.start());
      expect(result.current.state).toEqual({ kind: "running", runId: 55, url: "https://workspace.example.com/jobs/1/runs/55", alreadyRunning: true });
      expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    },
  );

  it("starts a scan, polls its run every 5 s until it ends, then calls onDone once", async () => {
    const calls = mockJobs({
      latest: idleLatest,
      run: () => json({ runId: 77 }),
      polls: [run("PENDING"), run("RUNNING"), run("TERMINATED", "SUCCESS")],
    });
    const onDone = vi.fn();
    const { result } = renderHook(() => useScanNow(onDone));

    await act(() => result.current.start());
    expect(calls).toContain("POST /api/jobs/default/run");
    expect(result.current.state).toEqual({ kind: "running", runId: 77, url: null, alreadyRunning: false });

    await wait(4_999);
    expect(polls(calls)).toEqual([]);
    await wait(1);
    expect(polls(calls)).toEqual(["GET /api/scan/runs/77"]);
    expect(result.current.state).toEqual({ kind: "running", runId: 77, url: RUN_URL, alreadyRunning: false });

    await wait(5_000);
    expect(polls(calls)).toHaveLength(2);
    expect(result.current.state.kind).toBe("running");
    expect(onDone).not.toHaveBeenCalled();

    await wait(5_000);
    expect(result.current.state).toEqual({ kind: "done", result: "SUCCESS", url: RUN_URL });
    expect(onDone).toHaveBeenCalledTimes(1);

    await wait(30_000);
    expect(polls(calls)).toHaveLength(3);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["SKIPPED", undefined, "SKIPPED"],
    ["INTERNAL_ERROR", "FAILED", "FAILED"],
    ["TERMINATED", "FAILED", "FAILED"],
  ])("stops at %s and reports %s as the result", async (lifeCycle, resultState, shown) => {
    mockJobs({ latest: idleLatest, run: () => json({ runId: 77 }), polls: [run(lifeCycle, resultState)] });
    const onDone = vi.fn();
    const { result } = renderHook(() => useScanNow(onDone));
    await act(() => result.current.start());
    await wait(5_000);
    expect(result.current.state).toEqual({ kind: "done", result: shown, url: RUN_URL });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("waits for a scan that was already running, then calls onDone", async () => {
    mockJobs({
      latest: () => json({ run: scanRun(77, "RUNNING", null, RUN_URL) }),
      polls: [run("RUNNING"), run("TERMINATED", "SUCCESS")],
    });
    const onDone = vi.fn();
    const { result } = renderHook(() => useScanNow(onDone));
    await act(() => result.current.start());
    await wait(5_000);
    expect(result.current.state).toEqual({ kind: "running", runId: 77, url: RUN_URL, alreadyRunning: true });
    await wait(5_000);
    expect(result.current.state).toEqual({ kind: "done", result: "SUCCESS", url: RUN_URL });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("reports a failed start with the server's message", async () => {
    mockJobs({ latest: idleLatest, run: () => json({ error: "Run failed", plugin: "jobs" }, 500) });
    const onDone = vi.fn();
    const { result } = renderHook(() => useScanNow(onDone));
    await act(() => result.current.start());
    expect(result.current.state.kind).toBe("error");
    expect(result.current.state.kind === "error" ? result.current.state.message : "").toContain("Run failed");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("starts nothing when it cannot check for a running scan", async () => {
    const calls = mockJobs({ latest: () => json({ error: "forbidden", message: "The app's service principal cannot read the scan job's runs." }, 403) });
    const { result } = renderHook(() => useScanNow(vi.fn()));
    await act(() => result.current.start());
    expect(result.current.state.kind).toBe("error");
    expect(result.current.state.kind === "error" ? result.current.state.message : "").toBe("Could not check for a running scan: The app's service principal cannot read the scan job's runs.");
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });

  it("keeps polling through one failed poll, and gives up after three in a row", async () => {
    const failed = () => json({ error: "jobs_api", message: "The Jobs API did not answer: Get run failed" }, 502);
    mockJobs({ latest: idleLatest, run: () => json({ runId: 77 }), polls: [failed, run("RUNNING"), failed, failed, failed] });
    const { result } = renderHook(() => useScanNow(vi.fn()));
    await act(() => result.current.start());
    await wait(5_000);
    expect(result.current.state.kind).toBe("running");
    await wait(5_000);
    expect(result.current.state).toEqual({ kind: "running", runId: 77, url: RUN_URL, alreadyRunning: false });
    await wait(15_000);
    expect(result.current.state.kind).toBe("error");
    expect(result.current.state.kind === "error" ? result.current.state.message : "").toContain("Get run failed");
  });

  it("starts a scan when the scan job has never run", async () => {
    const calls = mockJobs({ latest: () => json({ run: null }), run: () => json({ runId: 77 }), polls: [run("RUNNING")] });
    const { result } = renderHook(() => useScanNow(vi.fn()));
    await act(() => result.current.start());
    expect(calls).toEqual(["GET /api/scan/latest-run", "POST /api/jobs/default/run"]);
    expect(result.current.state).toEqual({ kind: "running", runId: 77, url: null, alreadyRunning: false });
  });

  it("a second click right after a POST, in another tab, sees the new run and makes no POST", async () => {
    // One server for both tabs: the POST adds run 77, which the next read of the latest run returns at once.
    let latest = idleLatest;
    const calls = mockJobs({
      latest: () => latest(),
      run: () => {
        latest = () => json({ run: scanRun(77, "PENDING", null, RUN_URL) });
        return json({ runId: 77 });
      },
      polls: [run("RUNNING")],
    });
    const firstTab = renderHook(() => useScanNow(vi.fn()));
    const secondTab = renderHook(() => useScanNow(vi.fn()));
    await act(() => firstTab.result.current.start());
    await act(() => secondTab.result.current.start());
    expect(firstTab.result.current.state).toEqual({ kind: "running", runId: 77, url: null, alreadyRunning: false });
    expect(secondTab.result.current.state).toEqual({ kind: "running", runId: 77, url: RUN_URL, alreadyRunning: true });
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual(["POST /api/jobs/default/run"]);
  });

  it("ignores a second start while one is going", async () => {
    const calls = mockJobs({ latest: idleLatest, run: () => json({ runId: 77 }), polls: [run("RUNNING")] });
    const { result } = renderHook(() => useScanNow(vi.fn()));
    await act(async () => {
      await Promise.all([result.current.start(), result.current.start()]);
    });
    await act(() => result.current.start());
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    expect(calls.filter((call) => call.endsWith("/api/scan/latest-run"))).toHaveLength(1);
  });

  it("can start again once a scan is done", async () => {
    const calls = mockJobs({ latest: idleLatest, run: () => json({ runId: 77 }), polls: [run("TERMINATED", "SUCCESS")] });
    const { result } = renderHook(() => useScanNow(vi.fn()));
    await act(() => result.current.start());
    await wait(5_000);
    expect(result.current.state.kind).toBe("done");
    await act(() => result.current.start());
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(2);
  });

  it("stops polling when the component goes away", async () => {
    const calls = mockJobs({ latest: idleLatest, run: () => json({ runId: 77 }), polls: [run("RUNNING")] });
    const { result, unmount } = renderHook(() => useScanNow(vi.fn()));
    await act(() => result.current.start());
    unmount();
    await wait(20_000);
    expect(polls(calls)).toEqual([]);
  });
});
