// @vitest-environment jsdom
import { SidebarProvider } from "@databricks/appkit-ui/react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationsChanged } from "../lib/copilot-api";
import { RecentChats } from "./RecentChats";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function chats(count: number) {
  return {
    conversations: Array.from({ length: count }, (_, i) => ({ id: `conv-${i}`, title: `Question ${i}`, updatedAt: "2026-11-05T10:00:00Z" })),
  };
}

function renderChats(path = "/copilot") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarProvider>
        <RecentChats />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe("RecentChats", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("links the 8 newest chats to their pages, and marks the open one", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json(chats(12)))));
    renderChats("/copilot/conv-1");
    const list = await screen.findByRole("list", { name: "Recent chats" });
    const links = await within(list).findAllByRole("link");
    expect(links).toHaveLength(8);
    expect(links[0]).toHaveAttribute("href", "/copilot/conv-0");
    expect(links[0]).toHaveTextContent("Question 0");
    expect(links[1]).toHaveAttribute("aria-current", "page");
  });

  it("says when there are no chats yet", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(json(chats(0)))));
    renderChats();
    expect(await screen.findByText("No chats yet")).toBeInTheDocument();
  });

  it("offers Retry when the chats could not be loaded", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ error: "genie", message: "Recent chats could not be loaded from Genie." }, 502));
    fetchMock.mockResolvedValueOnce(json(chats(1)));
    vi.stubGlobal("fetch", fetchMock);
    renderChats();

    await user.click(await screen.findByRole("button", { name: "Retry loading chats" }));
    expect(await screen.findByRole("link", { name: "Question 0" })).toBeInTheDocument();
  });

  it("reloads when the copilot starts a new chat", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(chats(0)));
    fetchMock.mockResolvedValueOnce(json(chats(1)));
    vi.stubGlobal("fetch", fetchMock);
    renderChats();
    await screen.findByText("No chats yet");

    act(() => conversationsChanged());
    expect(await screen.findByRole("link", { name: "Question 0" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
