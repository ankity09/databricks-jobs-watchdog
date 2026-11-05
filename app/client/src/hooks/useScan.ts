import { createContext, useContext } from "react";
import type { ScanNow } from "./useScanNow";

export const ScanNowContext = createContext<ScanNow | null>(null);

/** Scan now's state and `start`, shared by everything under ScanNowProvider. */
export function useScan(): ScanNow {
  const value = useContext(ScanNowContext);
  if (!value) throw new Error("useScan needs a ScanNowProvider above it.");
  return value;
}
