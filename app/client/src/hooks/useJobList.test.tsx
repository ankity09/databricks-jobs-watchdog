// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Change, JobListState } from "../../../shared/joblist/types";
import { useJobList } from "./useJobList";

/** The base version in a POST /api/job-list/changes body. */
const BaseOf = z.object({ baseVersion: z.number().nullable() });

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const saved: JobListState = {
  version: 3,
  savedAt: "2026-11-05T10:05:00Z",
  savedBy: "dana@example.com",
  document: { jobs: [{ job_name: "orders_ingest", owner: "platform-team" }] },
};

const change: Change = {
  kind: "upsert",
  target: { type: "job", name: "daily_revenue_report" },
  value: { job_name: "daily_revenue_report", severity: "CRITICAL" },
};

/** fetch answers GET /api/job-list with `state`, and POST /api/job-list/changes with `post`. */
function mockApi(state: JobListState, post?: Response) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (url === "/api/job-list" && (init?.method ?? "GET") === "GET") return Promise.resolve(json(200, state));
    if (url === "/api/job-list/changes" && init?.method === "POST" && post) return Promise.resolve(post);
    return Promise.resolve(json(404, { error: "not_found", message: `No route for ${url}` }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function loaded() {
  const hook = renderHook(() => useJobList());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

describe("useJobList", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads a job list that has never been saved", async () => {
    mockApi({ version: null, savedAt: null, savedBy: null, document: { jobs: [] } });
    const { result } = await loaded();
    expect(result.current.error).toBeNull();
    expect(result.current.state).toEqual({ version: null, savedAt: null, savedBy: null, document: { jobs: [] } });
  });

  it("replaces the state with the saved document and version", async () => {
    const document = { jobs: [...saved.document.jobs, { job_name: "daily_revenue_report", severity: "CRITICAL" }] };
    const fetchMock = mockApi(saved, json(201, { version: 4, summary: "Added daily_revenue_report", document }));
    const { result } = await loaded();
    let outcome: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      outcome = await result.current.save(change, 3);
    });
    expect(outcome).toEqual({ ok: true, result: { version: 4, summary: "Added daily_revenue_report", document } });
    expect(result.current.state?.version).toBe(4);
    expect(result.current.state?.document).toEqual(document);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    const body = post?.[1]?.body;
    expect(JSON.parse(typeof body === "string" ? body : "null")).toEqual({ baseVersion: 3, change });
  });

  it("sends the base version the caller gives, not the newest version it holds", async () => {
    // A form opened at version 3 saves after this browser saved version 4: the server must compare with 3.
    const document = { jobs: [...saved.document.jobs, { job_name: "daily_revenue_report", severity: "CRITICAL" }] };
    const fetchMock = mockApi(saved, json(201, { version: 4, summary: "Added daily_revenue_report", document }));
    const { result } = await loaded();
    await act(async () => {
      await result.current.save(change, 3);
    });
    expect(result.current.state?.version).toBe(4);
    await act(async () => {
      await result.current.save(change, 3);
    });
    const bases = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => BaseOf.parse(JSON.parse(typeof init?.body === "string" ? init.body : "null")).baseVersion);
    expect(bases).toEqual([3, 3]);
  });

  it("keeps the newer version when two saves answer out of order", async () => {
    const v4 = { jobs: [{ job_name: "orders_ingest", owner: "platform-team", enabled: false }] };
    const v5 = { jobs: [...v4.jobs, { job_name: "daily_revenue_report" }] };
    const answers: Array<(response: Response) => void> = [];
    const fetchMock = mockApi(saved);
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input) === "/api/job-list/changes" && init?.method === "POST") {
        return new Promise<Response>((resolve) => answers.push(resolve));
      }
      return Promise.resolve(json(200, saved));
    });
    const { result } = await loaded();
    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      first = result.current.save(change, 3);
      second = result.current.save(change, 3);
    });
    await waitFor(() => expect(answers).toHaveLength(2));
    // The server saved the first change as version 4 and the second as 5, but the answer for 5 arrives first.
    await act(async () => {
      answers[1]?.(json(201, { version: 5, summary: "Added daily_revenue_report", document: v5 }));
      await second;
    });
    await act(async () => {
      answers[0]?.(json(201, { version: 4, summary: "Changed enabled on orders_ingest from unset to false", document: v4 }));
      await first;
    });
    expect(result.current.state?.version).toBe(5);
    expect(result.current.state?.document).toEqual(v5);
  });

  it("reports a conflict when someone saved a newer version", async () => {
    mockApi(saved, json(409, { error: "conflict", message: "Version 5 was saved after version 3.", latestVersion: 5 }));
    const { result } = await loaded();
    let outcome: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      outcome = await result.current.save(change, 3);
    });
    expect(outcome).toEqual({ ok: false, conflict: true, latestVersion: 5 });
    expect(result.current.state).toEqual(saved);
  });

  it("resolves a reload with its error and keeps the list, then with null once a load works", async () => {
    const fetchMock = mockApi(saved);
    const { result } = await loaded();
    fetchMock.mockImplementationOnce(() =>
      Promise.resolve(json(500, { error: "server", message: "The job list could not be read or saved. Try again." })),
    );
    let failure: unknown;
    await act(async () => {
      failure = await result.current.reload();
    });
    expect(failure).toMatchObject({ status: 500, message: "The job list could not be read or saved. Try again." });
    expect(result.current.error?.message).toBe("The job list could not be read or saved. Try again.");
    expect(result.current.state).toEqual(saved);
    await act(async () => {
      failure = await result.current.reload();
    });
    expect(failure).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("clears a load error once a save goes through", async () => {
    const document = { jobs: [...saved.document.jobs, { job_name: "daily_revenue_report", severity: "CRITICAL" }] };
    const fetchMock = mockApi(saved, json(201, { version: 4, summary: "Added daily_revenue_report", document }));
    const { result } = await loaded();
    fetchMock.mockImplementationOnce(() => Promise.resolve(json(500, { error: "server", message: "Try again." })));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.error).not.toBeNull();
    await act(async () => {
      await result.current.save(change, 3);
    });
    expect(result.current.error).toBeNull();
  });

  it("returns the rule issues of an invalid change", async () => {
    const issues = [{ path: "jobs[1].max_gap_minutes", message: "must be a whole number above 0" }];
    mockApi(saved, json(422, { error: "invalid", message: "The change breaks 1 rule.", issues }));
    const { result } = await loaded();
    let outcome: Awaited<ReturnType<typeof result.current.save>> | undefined;
    await act(async () => {
      outcome = await result.current.save(change, 3);
    });
    expect(outcome).toEqual({ ok: false, conflict: false, issues, message: "The change breaks 1 rule." });
    expect(result.current.state).toEqual(saved);
  });
});
