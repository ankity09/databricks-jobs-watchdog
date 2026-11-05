import { useCallback, useEffect, useRef, useState } from "react";
import type { Change, JobListState, RuleIssue, SaveResult } from "../../../shared/joblist/types";
import { type ApiError, toApiError } from "../lib/api";
import { ConflictBodySchema, InvalidBodySchema, getJobList, saveChange } from "../lib/joblist-api";

export type SaveOutcome =
  | { ok: true; result: SaveResult }
  | { ok: false; conflict: true; latestVersion: number | null }
  | { ok: false; conflict: false; issues: RuleIssue[]; message: string };

/** Reloads the job list: resolves with the error when that failed, else null. */
export type ReloadJobList = () => Promise<ApiError | null>;

export interface UseJobListResult {
  state: JobListState | null;
  loading: boolean;
  error: ApiError | null;
  // `this: void`: safe to destructure, as in `const { save } = useJobList()`.
  /** Loads the newest version. Resolves with the error when that failed (the last good state stays), else null. */
  reload(this: void): Promise<ApiError | null>;
  save(this: void, change: Change): Promise<SaveOutcome>;
}

function failedSave(error: ApiError): SaveOutcome {
  if (error.status === 409) {
    const body = ConflictBodySchema.safeParse(error.body);
    return { ok: false, conflict: true, latestVersion: body.success ? body.data.latestVersion : null };
  }
  if (error.status === 422) {
    const body = InvalidBodySchema.safeParse(error.body);
    if (body.success) return { ok: false, conflict: false, issues: body.data.issues, message: body.data.message };
  }
  return { ok: false, conflict: false, issues: [], message: error.message };
}

/**
 * The saved job list, and saving one change at a time. Each save sends the
 * version it started from, so the server can refuse it (409) when someone saved
 * a newer one. After a successful save, `state` holds the saved document and
 * version; savedAt is this browser's time and savedBy is null until the next load.
 */
export function useJobList(): UseJobListResult {
  const [state, setState] = useState<JobListState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const latest = useRef<JobListState | null>(null);
  // Bumped by every load and save, so an older load never overwrites a newer state.
  const generation = useRef(0);

  const apply = useCallback((next: JobListState) => {
    latest.current = next;
    setState(next);
  }, []);

  /** Resolves with the error of a failed load. A load overtaken by a newer load or save resolves with null: newer data is coming. */
  const load = useCallback(async (): Promise<ApiError | null> => {
    const started = ++generation.current;
    try {
      const next = await getJobList();
      if (started !== generation.current) return null;
      apply(next);
      setError(null);
      return null;
    } catch (e) {
      if (started !== generation.current) return null;
      const failure = toApiError(e);
      setError(failure);
      return failure;
    } finally {
      if (started === generation.current) setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const reload = useCallback(async () => {
    setLoading(true);
    return load();
  }, [load]);

  const save = useCallback(
    async (change: Change): Promise<SaveOutcome> => {
      try {
        const result = await saveChange(latest.current?.version ?? null, change);
        generation.current++;
        apply({ version: result.version, savedAt: new Date().toISOString(), savedBy: null, document: result.document });
        setError(null);
        setLoading(false);
        return { ok: true, result };
      } catch (e) {
        return failedSave(toApiError(e));
      }
    },
    [apply],
  );

  return { state, loading, error, reload, save };
}
