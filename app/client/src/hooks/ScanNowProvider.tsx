import type { ReactNode } from "react";
import { ScanNowContext } from "./useScan";
import { useRefreshKey } from "./useRefreshKey";
import { useScanNow } from "./useScanNow";

export interface ScanNowProviderProps {
  children: ReactNode;
}

/**
 * Holds Scan now above the nav. On a narrow window the nav is a sheet that
 * unmounts when it closes; the scan it started must keep being watched, and
 * every query must still refresh when the scan ends.
 */
export function ScanNowProvider({ children }: ScanNowProviderProps) {
  const { bump } = useRefreshKey();
  const scan = useScanNow(bump);
  return <ScanNowContext.Provider value={scan}>{children}</ScanNowContext.Provider>;
}
