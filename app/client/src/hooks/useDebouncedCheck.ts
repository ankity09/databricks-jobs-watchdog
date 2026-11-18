import { useEffect, useState } from "react";
import type { RuleIssue } from "../../../shared/joblist/types";

/** A value and the issues the rules found in it. */
export interface Checked<T> {
  value: T;
  issues: RuleIssue[];
}

/**
 * Checks `value` with `check` 200 ms after it last changed, so a form can show
 * rule issues as you type without checking on every key. The first check runs
 * at once. `check` must be stable (useCallback), or every render restarts the
 * wait. The setter records a check made right away, for example before a save.
 */
export function useDebouncedCheck<T>(
  value: T,
  check: (value: T) => RuleIssue[],
  delayMs = 200,
): [Checked<T>, (checked: Checked<T>) => void] {
  const [checked, setChecked] = useState<Checked<T>>(() => ({ value, issues: check(value) }));
  useEffect(() => {
    const timer = window.setTimeout(() => setChecked({ value, issues: check(value) }), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, check, delayMs]);
  return [checked, setChecked];
}
