// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, mockApi } from "../test/mockApi";
import { ScanNowProvider } from "./ScanNowProvider";
import { useScan } from "./useScan";
import { RefreshProvider, useRefreshKey } from "./useRefreshKey";

function run(lifeCycle: string, resultState: string | null) {
  return json({ run: { run_id: 77, life_cycle_state: lifeCycle, result_state: resultState, run_page_url: "https://workspace.example.com/jobs/1/runs/77" } });
}

function Starter() {
  const scan = useScan();
  return (
    <button type="button" onClick={() => void scan.start()}>
      Start {scan.state.kind}
    </button>
  );
}

function Harness() {
  const [shown, setShown] = useState(true);
  const { refresh } = useRefreshKey();
  return (
    <>
      <button type="button" onClick={() => setShown((value) => !value)}>
        Toggle nav
      </button>
      <output aria-label="refresh">{refresh}</output>
      {shown ? <Starter /> : null}
    </>
  );
}

describe("ScanNowProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps watching a scan after the nav that started it closes, and refreshes when it ends", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-11-05T15:00:00Z"));
    let polls = 0;
    mockApi({
      routes: (url, init) => {
        if (url === "/api/scan/latest-run") return json({ run: null });
        if (url === "/api/jobs/default/run" && init?.method === "POST") return json({ runId: 77 });
        if (url === "/api/scan/runs/77") {
          polls += 1;
          return polls < 2 ? run("RUNNING", null) : run("TERMINATED", "SUCCESS");
        }
        return undefined;
      },
    });
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    render(
      <RefreshProvider>
        <ScanNowProvider>
          <Harness />
        </ScanNowProvider>
      </RefreshProvider>,
    );
    const before = Number(screen.getByLabelText("refresh").textContent);
    await user.click(screen.getByRole("button", { name: /^Start/ }));
    await screen.findByRole("button", { name: "Start running" });
    // The nav closes: the component that started the scan unmounts.
    await user.click(screen.getByRole("button", { name: "Toggle nav" }));
    expect(screen.queryByRole("button", { name: /^Start/ })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(Number(screen.getByLabelText("refresh").textContent)).toBeGreaterThan(before);
    await user.click(screen.getByRole("button", { name: "Toggle nav" }));
    expect(await screen.findByRole("button", { name: "Start done" })).toBeInTheDocument();
  });
});
