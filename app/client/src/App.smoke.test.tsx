// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { routes } from "./routes";
import { installRadixPolyfills } from "./test/mockApi";

const PAGES = [
  ["/monitoring", "Monitoring"],
  ["/jobs", "Job list"],
  ["/jobs/map", "Dependency map"],
  ["/jobs/changes", "Change log"],
  ["/jobs/settings", "Defaults and workspace labels"],
  ["/copilot", "Copilot"],
  ["/copilot/example-thread", "Copilot"],
] as const;

/** Each page's empty state, with no scans, no chats, no jobs and no versions saved. */
const EMPTY_STATES = [
  ["/monitoring", "No scans yet"],
  ["/copilot", "Ask about your monitored jobs"],
  ["/copilot/example-thread", "Ask about your monitored jobs"],
  ["/jobs", "The job list is empty"],
  ["/jobs/map", "Nothing on the map yet"],
  ["/jobs/changes", "Nothing is saved yet"],
  ["/jobs/settings", "Add jobs first"],
] as const;

const NAV_LINKS = [
  "Monitoring",
  "Jobs and dependencies",
  "Job list",
  "Dependency map",
  "Change log",
  "Defaults and workspace labels",
  "Copilot",
];

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Empty data for every route the shell calls. Analytics queries answer over SSE with no rows. */
function respond(url: string): Response {
  if (url.startsWith("/api/app-config")) {
    return json({ catalog: "main", schema: "watchdog", region: "us-east-2", appName: "watchdog-app", lakebaseProject: "jobs-watchdog" });
  }
  if (url.startsWith("/api/whoami")) return json({ user: "4321@1234", email: "dana@example.com" });
  if (url === "/api/job-list") return json({ version: null, savedAt: null, savedBy: null, document: { jobs: [] } });
  if (url.startsWith("/api/job-list/versions?")) return json({ versions: [] });
  if (url.startsWith("/api/copilot/conversations")) return json({ conversations: [] });
  if (url.startsWith("/api/genie/")) {
    // A saved chat with no messages: Genie's history info and nothing else.
    const info = { type: "history_info", conversationId: "example-thread", spaceId: "space-1", nextPageToken: null, loadedCount: 0 };
    return new Response(`data: ${JSON.stringify(info)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }
  if (url.startsWith("/api/analytics/query/")) {
    return new Response('data: {"type":"result","data":[]}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  }
  return json({ error: "not_found", message: `No route for ${url}` }, 404);
}

/** Waits until the page has its data: the signed-in email shows and no skeleton is left, so every update lands inside the test. */
async function settled() {
  // On a narrow window the email is in the nav sheet, which is closed.
  if (window.innerWidth < 768) await screen.findByRole("button", { name: "Open navigation" });
  else await screen.findByText("dana@example.com");
  await waitFor(() => expect(document.querySelector('[data-slot="skeleton"]')).toBeNull());
}

async function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} />);
  await settled();
  return router;
}

describe("the app shell", () => {
  // Radix's tooltips (the collapsed nav, the sheet) measure with a ResizeObserver, which jsdom lacks.
  beforeAll(installRadixPolyfills);
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Promise.resolve(respond(urlOf(input)))));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(PAGES)("renders %s with the heading %s, inside the nav", async (path, heading) => {
    await renderAt(path);
    expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const name of NAV_LINKS) expect(within(nav).getByRole("link", { name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });

  it.each(EMPTY_STATES)("settles %s into its empty state: %s", async (path, title) => {
    await renderAt(path);
    // "No scans yet" is also the nav's text for the last scan.
    expect(screen.getAllByText(title).length).toBeGreaterThan(0);
  });

  it("sends / to Monitoring", async () => {
    const router = await renderAt("/");
    expect(screen.getByRole("heading", { level: 1, name: "Monitoring" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/monitoring");
  });

  it("marks the current page in the nav", async () => {
    await renderAt("/jobs/map");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Dependency map" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Job list" })).not.toHaveAttribute("aria-current");
  });

  it("collapses the nav and remembers it", async () => {
    await renderAt("/monitoring");
    await userEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(window.localStorage.getItem("watchdog.sidebar.open")).toBe("false");
  });

  it("opens collapsed when the nav was collapsed before", async () => {
    window.localStorage.setItem("watchdog.sidebar.open", "false");
    const router = createMemoryRouter(routes, { initialEntries: ["/monitoring"] });
    render(<App router={router} />);
    expect(await screen.findByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    await settled();
  });

  it("shows the region from the app config", async () => {
    await renderAt("/monitoring");
    expect(screen.getByText("us-east-2")).toBeInTheDocument();
  });

  describe("on a window narrower than 768 px", () => {
    const wide = window.innerWidth;
    beforeEach(() => {
      Object.defineProperty(window, "innerWidth", { value: 720, configurable: true, writable: true });
    });
    afterEach(() => {
      Object.defineProperty(window, "innerWidth", { value: wide, configurable: true, writable: true });
    });

    it("has a menu button outside the nav that opens it, with the page links and Scan now", async () => {
      await renderAt("/monitoring");
      expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Open navigation" }));
      const nav = await screen.findByRole("navigation", { name: "Main" });
      for (const name of NAV_LINKS) expect(within(nav).getByRole("link", { name })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Scan now" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    });

    it("shows the full nav in the sheet even when the desktop nav was left collapsed", async () => {
      window.localStorage.setItem("watchdog.sidebar.open", "false");
      await renderAt("/monitoring");
      await userEvent.click(screen.getByRole("button", { name: "Open navigation" }));
      await screen.findByRole("navigation", { name: "Main" });
      expect(screen.getByRole("button", { name: "Scan now" })).toHaveTextContent("Scan now");
    });

    it("closes the sheet when a page link is chosen", async () => {
      await renderAt("/monitoring");
      await userEvent.click(screen.getByRole("button", { name: "Open navigation" }));
      const nav = await screen.findByRole("navigation", { name: "Main" });
      await userEvent.click(within(nav).getByRole("link", { name: "Copilot" }));
      await waitFor(() => expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull());
      expect(screen.getByRole("heading", { level: 1, name: "Copilot" })).toBeInTheDocument();
    });
  });

  it("shows a page-not-found page for an unknown address", async () => {
    await renderAt("/no-such-page");
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });
});
