// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VersionDetail, VersionSummary } from "../../../../shared/joblist/types";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { ChangeLogPage } from "./ChangeLogPage";

const CONFIG = { catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" };

const V1: VersionDetail = {
  version: 1,
  savedAt: "2026-11-05T09:00:00Z",
  savedBy: "dana@example.com",
  changeKind: "import",
  changeTarget: null,
  summary: "Imported 2 jobs, 0 links and 0 workspace labels from YAML",
  document: {
    jobs: [
      { job_name: "orders_ingest", max_gap_minutes: 60 },
      { job_name: "orders_enrich", max_gap_minutes: 90 },
    ],
  },
};

const V2: VersionDetail = {
  version: 2,
  savedAt: "2026-11-05T10:05:00Z",
  savedBy: "lee@example.com",
  changeKind: "update",
  changeTarget: "job:orders_ingest",
  summary: "Changed 2 settings on orders_ingest: max_gap_minutes, owner",
  document: {
    jobs: [
      { job_name: "orders_ingest", max_gap_minutes: 90, owner: "ingestion-team" },
      { job_name: "orders_enrich", max_gap_minutes: 90 },
    ],
  },
};

const summary = ({ document: _document, ...rest }: VersionDetail): VersionSummary => rest;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockApi(versions: VersionDetail[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.startsWith("/api/app-config")) return Promise.resolve(json(200, CONFIG));
      if (url.startsWith("/api/job-list/versions?")) return Promise.resolve(json(200, { versions: [...versions].reverse().map(summary) }));
      const match = /^\/api\/job-list\/versions\/(\d+)$/.exec(url);
      if (match) {
        const found = versions.find((v) => v.version === Number(match[1]));
        return Promise.resolve(found ? json(200, found) : json(404, { error: "not_found", message: "No such version" }));
      }
      if (url.startsWith("/api/analytics/query/")) {
        return Promise.resolve(new Response('data: {"type":"result","data":[]}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
      }
      return Promise.resolve(json(404, { error: "not_found", message: url }));
    }),
  );
}

/** `count` versions behind a paging route: `limit` and `before` work as on the server. The first older page fails once when asked. */
function mockPagedApi(count: number, options: { failOlderOnce?: boolean } = {}) {
  const versions: VersionSummary[] = Array.from({ length: count }, (_, i) => ({
    version: i + 1,
    savedAt: "2026-11-05T10:05:00Z",
    savedBy: "lee@example.com",
    changeKind: "update",
    changeTarget: "job:orders_ingest",
    summary: `Change number ${i + 1}`,
  }));
  const asked: string[] = [];
  let failOlder = options.failOlderOnce === true;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.startsWith("/api/app-config")) return Promise.resolve(json(200, CONFIG));
      if (url.startsWith("/api/job-list/versions?")) {
        asked.push(url);
        const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
        const limit = Number(query.get("limit") ?? "50");
        const before = query.get("before") === null ? Infinity : Number(query.get("before"));
        if (before !== Infinity && failOlder) {
          failOlder = false;
          return Promise.resolve(json(500, { error: "server", message: "The job list could not be read or saved. Try again." }));
        }
        const page = versions
          .filter((v) => v.version < before)
          .reverse()
          .slice(0, limit);
        return Promise.resolve(json(200, { versions: page }));
      }
      if (url.startsWith("/api/analytics/query/")) {
        return Promise.resolve(new Response('data: {"type":"result","data":[]}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
      }
      return Promise.resolve(json(404, { error: "not_found", message: url }));
    }),
  );
  return {
    asked,
    add: () => {
      const n = versions.length + 1;
      versions.push({ ...versions[0], version: n, summary: `Change number ${n}` } as VersionSummary);
    },
  };
}

// Plain DOM and text queries: role queries over a table of 120 rows are slow.
const versionRows = () => [...document.querySelectorAll<HTMLElement>("tbody tr")];
const olderButton = () => screen.queryByText(/^Load(ing)? older versions/);

function renderPage() {
  render(
    <RefreshProvider>
      <MemoryRouter>
        <ChangeLogPage />
      </MemoryRouter>
    </RefreshProvider>,
  );
}

describe("ChangeLogPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists every version, newest first, with when, who, the summary and the kind", async () => {
    mockApi([V1, V2]);
    renderPage();
    const rows = await screen.findAllByRole("row");
    const [, newest, oldest] = rows;
    if (!newest || !oldest) throw new Error("expected two version rows");
    expect(within(newest).getByText("2")).toBeInTheDocument();
    expect(within(newest).getByText("2026-11-05 10:05 UTC")).toBeInTheDocument();
    expect(within(newest).getByText("lee@example.com")).toBeInTheDocument();
    expect(within(newest).getByRole("button", { name: "Changed 2 settings on orders_ingest: max_gap_minutes, owner" })).toBeInTheDocument();
    expect(within(newest).getByText("update")).toBeInTheDocument();
    expect(within(oldest).getByText("import")).toBeInTheDocument();
  });

  it("opens a version's differences from the version before, field by field", async () => {
    mockApi([V1, V2]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Changed 2 settings on orders_ingest: max_gap_minutes, owner" }));
    const sheet = await screen.findByRole("dialog", { name: "Version 2" });
    const entry = await within(sheet).findByRole("table", { name: "Job orders_ingest" });
    const gap = within(entry).getByRole("row", { name: /max_gap_minutes/ });
    expect(within(gap).getByText("60")).toBeInTheDocument();
    expect(within(gap).getByText("90")).toBeInTheDocument();
    const owner = within(entry).getByRole("row", { name: /owner/ });
    expect(within(owner).getByText("unset")).toBeInTheDocument();
    expect(within(owner).getByText("ingestion-team")).toBeInTheDocument();
    expect(within(sheet).queryByRole("table", { name: "Job orders_enrich" })).not.toBeInTheDocument();
  });

  it("shows the first version as everything added", async () => {
    mockApi([V1, V2]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Imported 2 jobs, 0 links and 0 workspace labels from YAML" }));
    const sheet = await screen.findByRole("dialog", { name: "Version 1" });
    expect(await within(sheet).findByRole("table", { name: "Job orders_ingest" })).toBeInTheDocument();
    expect(within(sheet).getByRole("table", { name: "Job orders_enrich" })).toBeInTheDocument();
    expect(within(sheet).getAllByText("Added")).toHaveLength(2);
  });

  it("loads older versions 50 at a time, until the first version", async () => {
    const api = mockPagedApi(120, { failOlderOnce: true });
    renderPage();
    expect(await screen.findByText("The newest 50 versions.")).toBeInTheDocument();
    expect(versionRows()).toHaveLength(50);
    expect(versionRows()[0]).toHaveTextContent(/^120/);

    // The first try fails: the page says so and keeps the button, which tries again.
    await userEvent.click(screen.getByText("Load older versions"));
    expect(await screen.findByText("Older versions did not load. The job list could not be read or saved. Try again.")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Load older versions"));
    expect(await screen.findByText("The newest 100 versions.")).toBeInTheDocument();
    expect(screen.queryByText(/Older versions did not load/)).not.toBeInTheDocument();
    // Focus moves to the first version that just loaded.
    expect(screen.getByText("Change number 70")).toHaveFocus();

    await userEvent.click(screen.getByText("Load older versions"));
    expect(await screen.findByText("All 120 versions.")).toBeInTheDocument();
    expect(versionRows()).toHaveLength(120);
    expect(olderButton()).not.toBeInTheDocument();
    expect(api.asked).toEqual([
      "/api/job-list/versions?limit=50",
      "/api/job-list/versions?limit=50&before=71",
      "/api/job-list/versions?limit=50&before=71",
      "/api/job-list/versions?limit=50&before=21",
    ]);

    // Refresh adds the new version on top and keeps the older ones already shown.
    api.add();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("All 121 versions.")).toBeInTheDocument();
    expect(versionRows()[0]).toHaveTextContent(/^121/);
  }, 15_000);

  it("offers no older versions when the newest page holds them all", async () => {
    mockPagedApi(50);
    renderPage();
    expect(await screen.findByText("Change number 50")).toBeInTheDocument();
    expect(versionRows()).toHaveLength(50);
    expect(olderButton()).not.toBeInTheDocument();
  });

  it("names the next step when nothing is saved yet", async () => {
    mockApi([]);
    renderPage();
    expect(await screen.findByText("No versions yet. Import your job list or add a job on the Job list page.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the job list" })).toHaveAttribute("href", "/jobs");
  });
});
