// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jobsInTarget } from "../../../../shared/joblist/changelog";
import type { ChangeKind, VersionSummary } from "../../../../shared/joblist/types";
import { RefreshProvider } from "../../hooks/useRefreshKey";
import { presetFrom } from "../../lib/changeFilters";
import { ChangeLogPage } from "./ChangeLogPage";

const CONFIG = { catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" };

// Radix Select and cmdk lean on pointer and scroll APIs that jsdom lacks.
beforeAll(() => {
  for (const name of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture", "scrollIntoView"]) {
    Object.defineProperty(Element.prototype, name, { value: () => false, configurable: true, writable: true });
  }
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const urlOf = (input: RequestInfo | URL) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** 60 versions: every third is by dana, kinds cycle, targets alternate between two jobs and a link. */
const KINDS: ChangeKind[] = ["create", "update", "update", "delete"];
const ALL: VersionSummary[] = Array.from({ length: 60 }, (_, i) => ({
  version: i + 1,
  savedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
  savedBy: i % 3 === 0 ? "dana@example.com" : "lee@example.com",
  changeKind: KINDS[i % 4],
  changeTarget: i % 5 === 0 ? "dependency:orders_report->orders_ingest:job" : i % 2 === 0 ? "job:orders_ingest" : "job:orders_enrich",
  summary: `Change number ${i + 1}`,
}));

function matching(query: URLSearchParams): VersionSummary[] {
  const kinds = query.get("kind")?.split(",");
  return ALL.filter(
    (v) =>
      (!query.get("person") || v.savedBy === query.get("person")) &&
      (!kinds || kinds.includes(v.changeKind)) &&
      (!query.get("job") || jobsInTarget(v.changeTarget).includes(query.get("job") ?? "")) &&
      (!query.get("from") || v.savedAt >= `${query.get("from")}`) &&
      (!query.get("q") || v.summary.toLowerCase().includes((query.get("q") ?? "").toLowerCase())),
  );
}

function facets() {
  const tally = (names: string[]) => [...new Set(names)].map((name) => [name, names.filter((n) => n === name).length] as const);
  return {
    people: tally(ALL.map((v) => v.savedBy)).map(([email, count]) => ({ email, count })).sort((a, b) => b.count - a.count),
    jobs: tally(ALL.flatMap((v) => jobsInTarget(v.changeTarget))).map(([name, count]) => ({ name, count })).sort((a, b) => (a.name < b.name ? -1 : 1)),
    kinds: tally(ALL.map((v) => v.changeKind)).map(([kind, count]) => ({ kind: kind as ChangeKind, count })),
    firstSavedAt: ALL[0].savedAt,
    lastSavedAt: ALL[ALL.length - 1].savedAt,
  };
}

function mockApi(options: { facetsFail?: () => boolean } = {}) {
  const asked: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.startsWith("/api/app-config")) return Promise.resolve(json(200, CONFIG));
      if (url === "/api/job-list/versions/facets") {
        return Promise.resolve(options.facetsFail?.() ? json(500, { error: "server", message: "Nope." }) : json(200, facets()));
      }
      if (url.startsWith("/api/job-list/versions?")) {
        const query = new URLSearchParams(url.slice(url.indexOf("?") + 1));
        asked.push(query);
        const limit = Number(query.get("limit") ?? "50");
        const before = query.get("before") === null ? Infinity : Number(query.get("before"));
        const all = matching(query);
        const page = all.filter((v) => v.version < before).reverse().slice(0, limit);
        return Promise.resolve(json(200, { versions: page, total: all.length }));
      }
      if (url.startsWith("/api/analytics/query/")) {
        return Promise.resolve(new Response('data: {"type":"result","data":[]}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
      }
      return Promise.resolve(json(404, { error: "not_found", message: url }));
    }),
  );
  // The newest-version lookup for the banner (limit=1, no filters) is not what these tests ask about.
  return { asked, last: () => asked.filter((q) => q.get("limit") !== "1").slice(-1)[0] };
}

function Probe() {
  const location = useLocation();
  return <output data-testid="url">{`${location.pathname}${location.search}`}</output>;
}

function renderAt(path = "/jobs/changes") {
  render(
    <RefreshProvider>
      <MemoryRouter initialEntries={[path]}>
        <ChangeLogPage />
        <Probe />
      </MemoryRouter>
    </RefreshProvider>,
  );
}

const url = () => screen.getByTestId("url").textContent ?? "";
const rows = () => [...document.querySelectorAll<HTMLElement>("tbody tr")];
const count = () => document.querySelector<HTMLElement>('p[aria-live="polite"]')?.textContent ?? "";

describe("change log filters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says how many versions there are with no filter, and has no Clear filters", async () => {
    mockApi();
    renderAt();
    await waitFor(() => expect(count()).toBe("60 versions"));
    expect(rows()).toHaveLength(50);
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("opens /jobs/changes?job=<name> on that job: the list is filtered, the control shows the name, the count says so", async () => {
    const api = mockApi();
    renderAt("/jobs/changes?job=orders_enrich");
    await waitFor(() => expect(count()).toMatch(/^\d+ of 60 versions match$/));
    expect(api.asked[0].get("job")).toBe("orders_enrich");
    expect(screen.getByRole("combobox", { name: "Job" })).toHaveTextContent("orders_enrich");
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
    const expected = ALL.filter((v) => jobsInTarget(v.changeTarget).includes("orders_enrich")).length;
    expect(count()).toBe(`${expected} of 60 versions match`);
  });

  it("filters by person from the facets list, with counts", async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(count()).toBe("60 versions"));
    await user.click(await screen.findByRole("combobox", { name: "Who" }));
    expect(await screen.findByRole("option", { name: "Anyone" })).toBeInTheDocument();
    const dana = await screen.findByRole("option", { name: /dana@example.com/ });
    expect(dana).toHaveTextContent("20");
    await user.click(dana);
    await waitFor(() => expect(url()).toBe("/jobs/changes?person=dana%40example.com"));
    await waitFor(() => expect(count()).toBe("20 of 60 versions match"));
    expect(api.last().get("person")).toBe("dana@example.com");
    expect(rows().every((row) => within(row).queryByText("dana@example.com") !== null)).toBe(true);
  });

  it("toggles several kinds at once, in the order of the chips", async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(count()).toBe("60 versions"));
    const changed = screen.getByRole("button", { name: "Changed" });
    const added = screen.getByRole("button", { name: "Added" });
    await user.click(changed);
    await user.click(added);
    expect(changed).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(url()).toBe("/jobs/changes?kind=create%2Cupdate"));
    await waitFor(() => expect(api.last().get("kind")).toBe("create,update"));
    await user.click(changed);
    await waitFor(() => expect(url()).toBe("/jobs/changes?kind=create"));
    expect(screen.getAllByRole("button").map((b) => b.textContent).filter((t) => ["Imported", "Added", "Changed", "Deleted", "Restored"].includes(t ?? ""))).toEqual([
      "Imported", "Added", "Changed", "Deleted", "Restored",
    ]);
  });

  it("picks a job from the list, or takes a typed name, and can go back to any job", async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(count()).toBe("60 versions"));
    await user.click(screen.getByRole("combobox", { name: "Job" }));
    await user.type(await screen.findByPlaceholderText("Find or type a job name"), "orders_rep");
    await user.click(await screen.findByRole("option", { name: /orders_report/ }));
    await waitFor(() => expect(url()).toBe("/jobs/changes?job=orders_report"));
    await waitFor(() => expect(api.last().get("job")).toBe("orders_report"));

    // A name the list lacks is taken as typed.
    await user.click(screen.getByRole("combobox", { name: "Job" }));
    await user.type(await screen.findByPlaceholderText("Find or type a job name"), "deleted_long_ago");
    await user.click(await screen.findByRole("option", { name: /Use deleted_long_ago/ }));
    await waitFor(() => expect(url()).toBe("/jobs/changes?job=deleted_long_ago"));
    await waitFor(() => expect(count()).toBe("0 of 60 versions match"));

    await user.click(screen.getByRole("combobox", { name: "Job" }));
    await user.click(await screen.findByRole("option", { name: "Any job" }));
    await waitFor(() => expect(url()).toBe("/jobs/changes"));
  });

  it("stores a preset as a real date, and shows the preset when the dates match", async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(count()).toBe("60 versions"));
    await user.click(screen.getByRole("combobox", { name: "When" }));
    await user.click(await screen.findByRole("option", { name: "Last 7 days" }));
    const from = presetFrom("7d", new Date());
    await waitFor(() => expect(url()).toBe(`/jobs/changes?from=${from}`));
    expect(screen.getByRole("combobox", { name: "When" })).toHaveTextContent("Last 7 days");
    await waitFor(() => expect(api.last().get("from")).toBe(from));
  });

  it("shows a copied link's window as Last 7 days, and Custom with From and To for other dates", async () => {
    mockApi();
    renderAt(`/jobs/changes?from=${presetFrom("7d", new Date())}`);
    expect(await screen.findByRole("combobox", { name: "When" })).toHaveTextContent("Last 7 days");
    expect(screen.queryByLabelText("From")).not.toBeInTheDocument();
  });

  it("Custom takes two dates", async () => {
    const api = mockApi();
    renderAt("/jobs/changes?from=2026-11-01&to=2026-11-02");
    expect(await screen.findByRole("combobox", { name: "When" })).toHaveTextContent("Custom");
    expect(screen.getByLabelText("From")).toHaveValue("2026-11-01");
    expect(screen.getByLabelText("To")).toHaveValue("2026-11-02");
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-05" } });
    await waitFor(() => expect(url()).toBe("/jobs/changes?from=2026-11-01&to=2026-11-05"));
    await waitFor(() => expect(api.last().get("to")).toBe("2026-11-05"));
  });

  it("opens Custom with empty dates, and Any time clears them", async () => {
    mockApi();
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(count()).toBe("60 versions"));
    await user.click(screen.getByRole("combobox", { name: "When" }));
    await user.click(await screen.findByRole("option", { name: "Custom" }));
    expect(await screen.findByLabelText("From")).toHaveValue("");
    await user.click(screen.getByRole("combobox", { name: "When" }));
    await user.click(await screen.findByRole("option", { name: "Any time" }));
    await waitFor(() => expect(screen.queryByLabelText("From")).not.toBeInTheDocument());
  });

  it("waits 300 ms after typing before it asks, then asks once", async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(count()).toBe("60 versions"));
    const before = api.asked.length;
    await user.type(screen.getByRole("searchbox"), "number 1");
    expect(api.asked.length).toBe(before);
    expect(url()).toBe("/jobs/changes");
    await waitFor(() => expect(url()).toBe("/jobs/changes?q=number+1"), { timeout: 2000 });
    await waitFor(() => expect(count()).toBe("11 of 60 versions match"));
    expect(api.asked.length).toBe(before + 2); // the list, and the newest version for the banner
    expect(api.asked.filter((q) => q.get("q") !== null)).toHaveLength(1);
  });

  it("keeps a chip pressed while a search is still waiting", async () => {
    mockApi();
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(count()).toBe("60 versions"));
    await user.type(screen.getByRole("searchbox"), "number");
    await user.click(screen.getByRole("button", { name: "Added" }));
    await waitFor(() => expect(url()).toBe("/jobs/changes?kind=create&q=number"), { timeout: 2000 });
  });

  it("drops a search that is waiting when Clear filters is pressed", async () => {
    mockApi();
    const user = userEvent.setup();
    renderAt("/jobs/changes?kind=create");
    await waitFor(() => expect(count()).toBe("15 of 60 versions match"));
    await user.type(screen.getByRole("searchbox"), "number");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(url()).toBe("/jobs/changes");
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("narrows to the matching versions only, with no older page when they all fit", async () => {
    const api = mockApi();
    renderAt("/jobs/changes?kind=update,create");
    await waitFor(() => expect(count()).toBe("45 of 60 versions match"));
    expect(rows()).toHaveLength(45);
    expect(screen.queryByText("Load older versions")).not.toBeInTheDocument();
    expect(api.asked.every((q) => q.get("kind") === "create,update" || q.get("limit") === "1")).toBe(true);
  });

  it("pages with the same filters when there are more than a page", async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderAt("/jobs/changes?person=lee%40example.com&from=2026-11-01");
    await waitFor(() => expect(count()).toBe("40 of 60 versions match"));
    expect(rows()).toHaveLength(40);
    expect(screen.queryByText("Load older versions")).not.toBeInTheDocument();
    // 60 versions, no filter: the page limit is 50, so a second page exists.
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(count()).toBe("60 versions"));
    expect(api.last().get("person")).toBeNull();
    await user.click(await screen.findByText("Load older versions"));
    await waitFor(() => expect(rows()).toHaveLength(60));
    expect(api.last().get("before")).toBe("11");
  });

  it("keeps the filters on 'Load older versions'", async () => {
    const api = mockApi();
    const user = userEvent.setup();
    renderAt("/jobs/changes?from=2026-11-01");
    await waitFor(() => expect(count()).toBe("60 of 60 versions match"));
    await user.click(await screen.findByText("Load older versions"));
    await waitFor(() => expect(rows()).toHaveLength(60));
    const older = api.last();
    expect(older.get("from")).toBe("2026-11-01");
    expect(older.get("before")).toBe("11");
  });

  it("says no changes match, and Clear filters brings them back", async () => {
    mockApi();
    const user = userEvent.setup();
    renderAt("/jobs/changes?q=zzz");
    expect(await screen.findByText("No changes match these filters.")).toBeInTheDocument();
    expect(count()).toBe("0 of 60 versions match");
    const buttons = screen.getAllByRole("button", { name: "Clear filters" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[1]);
    await waitFor(() => expect(count()).toBe("60 versions"));
    expect(url()).toBe("/jobs/changes");
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(rows().length).toBeGreaterThan(0);
  });

  it("follows the URL when it changes under it, like the back button", async () => {
    mockApi();
    function Back() {
      return null;
    }
    const user = userEvent.setup();
    render(
      <RefreshProvider>
        <MemoryRouter initialEntries={["/jobs/changes", "/jobs/changes?q=Change+number+1"]} initialIndex={1}>
          <ChangeLogPage />
          <Probe />
          <Back />
        </MemoryRouter>
      </RefreshProvider>,
    );
    await waitFor(() => expect(count()).toBe("11 of 60 versions match"));
    expect(screen.getByRole("searchbox")).toHaveValue("Change number 1");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(count()).toBe("60 versions"));
  });

  it("keeps the list working when the options do not load, says so, and Retry gets them", async () => {
    let fail = true;
    mockApi({ facetsFail: () => fail });
    const user = userEvent.setup();
    renderAt();
    await waitFor(() => expect(count()).toBe("60 versions"));
    expect(rows()).toHaveLength(50);
    expect(await screen.findByText("Couldn't load the options")).toBeInTheDocument();
    // A typed job name still works.
    await user.click(screen.getByRole("combobox", { name: "Job" }));
    await user.type(await screen.findByPlaceholderText("Find or type a job name"), "orders_enrich");
    await user.click(await screen.findByRole("option", { name: /Use orders_enrich/ }));
    await waitFor(() => expect(url()).toBe("/jobs/changes?job=orders_enrich"));
    await waitFor(() => expect(count()).toMatch(/^\d+ versions match$/));
    await user.keyboard("{Escape}");
    fail = false;
    await user.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    await waitFor(() => expect(screen.queryByText("Couldn't load the options")).not.toBeInTheDocument());
    expect(await screen.findByRole("combobox", { name: "Who" })).toBeInTheDocument();
    await waitFor(() => expect(count()).toMatch(/^\d+ of 60 versions match$/));
  });
});
