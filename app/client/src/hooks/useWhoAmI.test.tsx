// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json } from "../test/mockApi";
import { RefreshProvider, useRefreshKey } from "./useRefreshKey";
import { useWhoAmI, whoAmIRequest } from "./useWhoAmI";

function Show() {
  const { whoami, error } = useWhoAmI();
  const { bump } = useRefreshKey();
  return (
    <>
      <output aria-label="who">{whoami?.email ?? (error ? "failed" : "loading")}</output>
      <button type="button" onClick={bump}>
        Refresh
      </button>
    </>
  );
}

describe("useWhoAmI", () => {
  beforeEach(() => whoAmIRequest.reset());
  afterEach(() => vi.unstubAllGlobals());

  it("asks again when the page refreshes after a failed load", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(fail ? json({ error: "boom" }, 500) : json({ user: "4321@1234", email: "dana@example.com" }))),
    );
    render(
      <RefreshProvider>
        <Show />
      </RefreshProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("who")).toHaveTextContent("failed"));
    fail = false;
    act(() => screen.getByRole("button", { name: "Refresh" }).click());
    await waitFor(() => expect(screen.getByLabelText("who")).toHaveTextContent("dana@example.com"));
  });
});
