// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { routes } from "./routes";

const PAGES = [
  ["/monitoring", "Monitoring"],
  ["/jobs", "Job list"],
  ["/jobs/map", "Dependency map"],
  ["/jobs/changes", "Change log"],
  ["/jobs/settings", "Defaults and workspace labels"],
  ["/copilot", "Copilot"],
  ["/copilot/example-thread", "Copilot"],
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
  if (url.startsWith("/api/analytics/query/")) {
    return new Response('data: {"type":"result","data":[]}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  }
  return json({ error: "not_found", message: `No route for ${url}` }, 404);
}

async function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} />);
  // Wait for the shell's own data (the scan time and the signed-in email), so every update lands inside the test.
  await screen.findByText("No scans yet");
  await screen.findByText("dana@example.com");
  return router;
}

describe("the app shell", () => {
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
    await screen.findByText("dana@example.com");
  });

  it("shows the region from the app config", async () => {
    await renderAt("/monitoring");
    expect(screen.getByText("us-east-2")).toBeInTheDocument();
  });

  it("shows a page-not-found page for an unknown address", async () => {
    await renderAt("/no-such-page");
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });
});
