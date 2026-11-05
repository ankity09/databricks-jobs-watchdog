import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

const FIVE_MINUTES = 5 * 60 * 1000;

/**
 * The key starts at the current minute and only grows. AppKit caches query
 * results for an hour, in Lakebase when it can, so a key that started at 0 on
 * every page load would show old results after a reload.
 */
function currentMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

function advance(previous: number): number {
  return Math.max(previous + 1, currentMinute());
}

interface RefreshContextValue {
  refresh: number;
  /** `this: void`: safe to destructure and pass around. */
  bump(this: void): void;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

export interface RefreshProviderProps {
  children: ReactNode;
}

/** Holds the refresh key that every analytics query takes as its `refresh` parameter. */
export function RefreshProvider({ children }: RefreshProviderProps) {
  const [refresh, setRefresh] = useState(currentMinute);
  const bump = useCallback(() => setRefresh(advance), []);
  useEffect(() => {
    const timer = window.setInterval(bump, FIVE_MINUTES);
    return () => window.clearInterval(timer);
  }, [bump]);
  const value = useMemo(() => ({ refresh, bump }), [refresh, bump]);
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

/** `refresh` changes on bump() and every 5 minutes; pass it to a query to skip AppKit's cache. */
export function useRefreshKey(): RefreshContextValue {
  const value = useContext(RefreshContext);
  if (!value) throw new Error("useRefreshKey needs a RefreshProvider above it.");
  return value;
}
