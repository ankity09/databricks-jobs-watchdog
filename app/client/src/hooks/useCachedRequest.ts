import { useEffect, useSyncExternalStore } from "react";
import { type ApiError, toApiError } from "../lib/api";

export interface CachedRequestState<T> {
  value: T | null;
  loading: boolean;
  error: ApiError | null;
}

/**
 * A GET made once per page and shared by every caller. All callers see one
 * state: loading, the answer, or the error. After an error the next load()
 * asks again, and every caller sees that retry load, then its answer.
 */
export interface CachedRequest<T> {
  /** Asks, unless there is an answer or a request under way. Resolves with the answer. */
  load(): Promise<T>;
  /** The answer, once there is one. */
  peek(): T | null;
  /** The shared state (for useSyncExternalStore). */
  getState: () => CachedRequestState<T>;
  subscribe: (listener: () => void) => () => void;
  /** Forgets the answer and any error, so the next load() asks again. For tests: each test mocks its own answers. */
  reset(): void;
}

/**
 * `keep` says whether an answer is final. An answer that is not (such as a config that names no catalog,
 * which the person fixes elsewhere) is asked for again by the next load(), so Retry can work.
 */
export function cachedRequest<T>(fetcher: () => Promise<T>, keep: (value: T) => boolean = () => true): CachedRequest<T> {
  let pending: Promise<T> | null = null;
  // Loading until the first answer: the first caller asks as it mounts.
  let state: CachedRequestState<T> = { value: null, loading: true, error: null };
  const listeners = new Set<() => void>();
  const update = (next: CachedRequestState<T>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    load() {
      if (state.value !== null && keep(state.value)) return Promise.resolve(state.value);
      if (pending === null) {
        if (state.error !== null) update({ value: null, loading: true, error: null });
        pending = fetcher().then(
          (value) => {
            pending = null;
            update({ value, loading: false, error: null });
            return value;
          },
          (error: unknown) => {
            pending = null;
            update({ value: null, loading: false, error: toApiError(error) });
            throw error;
          },
        );
      }
      return pending;
    },
    reset() {
      pending = null;
      update({ value: null, loading: true, error: null });
    },
    peek: () => state.value,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The shared state of `request`, which loads when the first caller mounts.
 * `retryKey`: when it changes after a failure, the request is made again (an
 * answer is kept, so then nothing happens). Every caller sees the retry load
 * and its answer, also callers that pass no key, such as the region badge.
 */
export function useCachedRequest<T>(request: CachedRequest<T>, retryKey?: unknown): CachedRequestState<T> {
  const state = useSyncExternalStore(request.subscribe, request.getState);
  useEffect(() => {
    // A failure is in the shared state, which every caller shows.
    request.load().catch(() => undefined);
  }, [request, retryKey]);
  return state;
}
