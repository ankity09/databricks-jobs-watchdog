import { useEffect, useState } from "react";
import { type ApiError, toApiError } from "../lib/api";

/** A GET that runs once per page and is shared by every caller. A failure is not kept, so the next caller asks again. */
export interface CachedRequest<T> {
  load(): Promise<T>;
  peek(): T | null;
}

export function cachedRequest<T>(fetcher: () => Promise<T>): CachedRequest<T> {
  let pending: Promise<T> | null = null;
  let value: T | null = null;
  return {
    load() {
      pending ??= fetcher().then(
        (result) => {
          value = result;
          return result;
        },
        (error: unknown) => {
          pending = null;
          throw error;
        },
      );
      return pending;
    },
    peek: () => value,
  };
}

export interface CachedRequestState<T> {
  value: T | null;
  loading: boolean;
  error: ApiError | null;
}

export function useCachedRequest<T>(request: CachedRequest<T>): CachedRequestState<T> {
  const [state, setState] = useState<CachedRequestState<T>>(() => {
    const value = request.peek();
    return { value, loading: value === null, error: null };
  });
  useEffect(() => {
    let active = true;
    request.load().then(
      (value) => {
        if (active) setState((prev) => (prev.value === value && !prev.loading ? prev : { value, loading: false, error: null }));
      },
      (error: unknown) => {
        if (active) setState({ value: null, loading: false, error: toApiError(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [request]);
  return state;
}
