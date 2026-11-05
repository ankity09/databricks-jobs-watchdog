// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshProvider, useRefreshKey } from "./useRefreshKey";

function Show() {
  const { refresh } = useRefreshKey();
  return <output aria-label="refresh">{refresh}</output>;
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

const MINUTE = 60_000;

describe("the refresh key", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T09:00:00Z"));
    render(
      <RefreshProvider>
        <Show />
      </RefreshProvider>,
    );
  });
  afterEach(() => {
    setHidden(false);
    vi.useRealTimers();
  });

  const value = () => Number(screen.getByLabelText("refresh").textContent);

  it("advances every 5 minutes while the tab is showing", async () => {
    const start = value();
    await act(async () => {
      await Promise.resolve(vi.advanceTimersByTime(5 * MINUTE));
    });
    expect(value()).toBeGreaterThan(start);
  });

  it("does not advance while the tab is hidden, so a forgotten tab does not keep the warehouse awake", async () => {
    const start = value();
    await act(async () => {
      await Promise.resolve(setHidden(true));
    });
    await act(async () => {
      await Promise.resolve(vi.advanceTimersByTime(60 * MINUTE));
    });
    expect(value()).toBe(start);
  });

  it("advances once when the tab comes back after more than 5 minutes", async () => {
    const start = value();
    await act(async () => {
      await Promise.resolve(setHidden(true));
    });
    await act(async () => {
      await Promise.resolve(vi.advanceTimersByTime(30 * MINUTE));
    });
    await act(async () => {
      await Promise.resolve(setHidden(false));
    });
    expect(value()).toBeGreaterThan(start);
  });

  it("does not advance when the tab comes back within 5 minutes", async () => {
    const start = value();
    await act(async () => {
      await Promise.resolve(setHidden(true));
    });
    await act(async () => {
      await Promise.resolve(vi.advanceTimersByTime(2 * MINUTE));
    });
    await act(async () => {
      await Promise.resolve(setHidden(false));
    });
    expect(value()).toBe(start);
  });
});
