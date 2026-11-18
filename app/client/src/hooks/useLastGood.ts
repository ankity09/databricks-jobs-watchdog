import { useState } from "react";

/**
 * The latest non-null value. When the value turns null (a newer query has not
 * answered yet), the last one stays, so a refresh does not blank the screen.
 *
 * Why queries need this: AppKit's query store returns an idle snapshot
 * (`data: null`, `loading: false`) for a parameter set it has not started yet,
 * and useAnalyticsQuery starts it in an effect. So right after the parameters
 * change (the config arriving, a refresh tick, bump()), one render has no data
 * and no loading flag. Treat `data === null` without an error as loading, and
 * show the last good value meanwhile.
 */
export function useLastGood<T>(value: T | null): T | null {
  const [kept, setKept] = useState<T | null>(value);
  // React's pattern for adjusting state while rendering: the guard stops it after one update.
  if (value !== null && value !== kept) setKept(value);
  return value ?? kept;
}
