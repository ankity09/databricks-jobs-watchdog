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
  status: () => Response;
  run?: () => Response;
  /** Each poll of GET /runs/:runId takes the next answer; the last one repeats. */
  polls?: Array<() => Response>;
}

/** fetch for the jobs plugin routes. Returns the calls made, as "METHOD path". */
function mockJobs(routes: Routes): string[] {
  const calls: string[] = [];
  let poll = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url === "/api/jobs/default/status") return Promise.resolve(routes.status());
      if (url === "/api/jobs/default/run" && method === "POST") return Promise.resolve(routes.run?.() ?? json({ error: "No run route" }, 500));
      if (url.startsWith("/api/jobs/default/runs/")) {
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

function run(lifeCycle: string, resultState?: string, url: string | null = RUN_URL) {
  return () => json({ run_id: 77, job_id: 1, run_page_url: url, state: { life_cycle_state: lifeCycle, ...(resultState ? { result_state: resultState } : {}) } });
}

const idleStatus = () => json({ status: "TERMINATED", run: { run_id: 70, run_page_url: "https://workspace.example.com/jobs/1/runs/70", state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" } } });

/** Runs the timers that are due within `ms`, and lets the fetches they start settle. */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const polls = (calls: string[]) => calls.filter((call) => call.startsWith("GET /api/jobs/default/runs/"));

describe("useScanNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["PENDING", "QUEUED", "RUNNING", "BLOCKED", "TERMINATING"])(
    "shows the scan that is already %s, and starts no other",
    async (lifeCycle) => {
      const calls = mockJobs({
        status: () => json({ status: lifeCycle, run: { run_id: 55, run_page_url: "https://workspace.example.com/jobs/1/runs/55", state: { life_cycle_state: lifeCycle } } }),
      });
      const { result } = renderHook(() => useScanNow(vi.fn()));
      await act(() => result.current.start());
      expect(result.current.state).toEqual({ kind: "running", runId: 55, url: "https://workspace.example.com/jobs/1/runs/55", alreadyRunning: true });
      expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    },
  );

  it("starts a scan, polls its run every 5 s until it ends, then calls onDone once", async () => {
    const calls = mockJobs({
      status: idleStatus,
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
    expect(polls(calls)).toEqual(["GET /api/jobs/default/runs/77"]);
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
    mockJobs({ status: idleStatus, run: () => json({ runId: 77 }), polls: [run(lifeCycle, resultState)] });
    const onDone = vi.fn();
    const { result } = renderHook(() => useScanNow(onDone));
    await act(() => result.current.start());
    await wait(5_000);
    expect(result.current.state).toEqual({ kind: "done", result: shown, url: RUN_URL });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("waits for a scan that was already running, then calls onDone", async () => {
    mockJobs({
      status: () => json({ status: "RUNNING", run: { run_id: 77, run_page_url: RUN_URL, state: { life_cycle_state: "RUNNING" } } }),
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
    mockJobs({ status: idleStatus, run: () => json({ error: "Run failed", plugin: "jobs" }, 500) });
    const onDone = vi.fn();
    const { result } = renderHook(() => useScanNow(onDone));
    await act(() => result.current.start());
    expect(result.current.state.kind).toBe("error");
    expect(result.current.state.kind === "error" ? result.current.state.message : "").toContain("Run failed");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("starts nothing when it cannot check for a running scan", async () => {
    const calls = mockJobs({ status: () => json({ error: "Forbidden", plugin: "jobs" }, 403) });
    const { result } = renderHook(() => useScanNow(vi.fn()));
    await act(() => result.current.start());
    expect(result.current.state.kind).toBe("error");
    expect(result.current.state.kind === "error" ? result.current.state.message : "").toContain("Forbidden");
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });

  it("keeps polling through one failed poll, and gives up after three in a row", async () => {
    const failed = () => json({ error: "Get run failed", plugin: "jobs" }, 500);
    mockJobs({ status: idleStatus, run: () => json({ runId: 77 }), polls: [failed, run("RUNNING"), failed, failed, failed] });
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

  it("ignores a second start while one is going", async () => {
    const calls = mockJobs({ status: idleStatus, run: () => json({ runId: 77 }), polls: [run("RUNNING")] });
    const { result } = renderHook(() => useScanNow(vi.fn()));
    await act(async () => {
      await Promise.all([result.current.start(), result.current.start()]);
    });
    await act(() => result.current.start());
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
    expect(calls.filter((call) => call.endsWith("/status"))).toHaveLength(1);
  });

  it("can start again once a scan is done", async () => {
    const calls = mockJobs({ status: idleStatus, run: () => json({ runId: 77 }), polls: [run("TERMINATED", "SUCCESS")] });
    const { result } = renderHook(() => useScanNow(vi.fn()));
    await act(() => result.current.start());
    await wait(5_000);
    expect(result.current.state.kind).toBe("done");
    await act(() => result.current.start());
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(2);
  });

  it("stops polling when the component goes away", async () => {
    const calls = mockJobs({ status: idleStatus, run: () => json({ runId: 77 }), polls: [run("RUNNING")] });
    const { result, unmount } = renderHook(() => useScanNow(vi.fn()));
    await act(() => result.current.start());
    unmount();
    await wait(20_000);
    expect(polls(calls)).toEqual([]);
  });
});
