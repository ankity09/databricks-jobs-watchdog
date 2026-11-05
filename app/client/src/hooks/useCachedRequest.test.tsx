// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { cachedRequest, useCachedRequest } from "./useCachedRequest";

/** A fetcher whose answers the test hands out one call at a time. */
function scripted<T>() {
  const calls: Array<{ resolve: (value: T) => void; reject: (error: unknown) => void }> = [];
  const fetcher = vi.fn(
    () =>
      new Promise<T>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  return {
    fetcher,
    async answer(index: number, value: T) {
      await act(async () => {
        calls[index]?.resolve(value);
        await Promise.resolve();
      });
    },
    async fail(index: number, message: string) {
      await act(async () => {
        calls[index]?.reject(new ApiError(500, "app_config", message, null));
        await Promise.resolve();
      });
    },
  };
}

describe("useCachedRequest", () => {
  it("asks once for every caller, and gives each the answer", async () => {
    const script = scripted<string>();
    const request = cachedRequest(script.fetcher);
    const first = renderHook(() => useCachedRequest(request));
    const second = renderHook(() => useCachedRequest(request));
    expect(first.result.current).toEqual({ value: null, loading: true, error: null });
    await script.answer(0, "us-east-2");
    expect(first.result.current).toEqual({ value: "us-east-2", loading: false, error: null });
    expect(second.result.current).toEqual({ value: "us-east-2", loading: false, error: null });
    expect(script.fetcher).toHaveBeenCalledTimes(1);
  });

  it("shows loading during a retry, and every caller gets the retry's answer, even one without the retry key", async () => {
    const script = scripted<string>();
    const request = cachedRequest(script.fetcher);
    // The page passes the refresh key; the sidebar's region badge passes none.
    const page = renderHook(({ retryKey }) => useCachedRequest(request, retryKey), { initialProps: { retryKey: 0 } });
    const badge = renderHook(() => useCachedRequest(request));
    await script.fail(0, "The app server did not answer.");
    expect(page.result.current).toMatchObject({ value: null, loading: false, error: { message: "The app server did not answer." } });
    expect(badge.result.current.error?.message).toBe("The app server did not answer.");

    page.rerender({ retryKey: 1 });
    await waitFor(() => expect(script.fetcher).toHaveBeenCalledTimes(2));
    expect(page.result.current).toEqual({ value: null, loading: true, error: null });
    expect(badge.result.current).toEqual({ value: null, loading: true, error: null });

    await script.answer(1, "us-east-2");
    expect(page.result.current).toEqual({ value: "us-east-2", loading: false, error: null });
    expect(badge.result.current).toEqual({ value: "us-east-2", loading: false, error: null });
  });

  it("does not ask again on a new retry key once it has an answer", async () => {
    const script = scripted<string>();
    const request = cachedRequest(script.fetcher);
    const page = renderHook(({ retryKey }) => useCachedRequest(request, retryKey), { initialProps: { retryKey: 0 } });
    await script.answer(0, "us-east-2");
    page.rerender({ retryKey: 1 });
    page.rerender({ retryKey: 2 });
    expect(script.fetcher).toHaveBeenCalledTimes(1);
    expect(page.result.current.value).toBe("us-east-2");
  });

  it("gives a caller that mounts later the answer at once, without asking", async () => {
    const script = scripted<string>();
    const request = cachedRequest(script.fetcher);
    renderHook(() => useCachedRequest(request));
    await script.answer(0, "us-east-2");
    const later = renderHook(() => useCachedRequest(request));
    expect(later.result.current).toEqual({ value: "us-east-2", loading: false, error: null });
    expect(script.fetcher).toHaveBeenCalledTimes(1);
  });
});
