import { sql } from "@databricks/appkit-ui/js";
import { Button, Skeleton, useAnalyticsQuery } from "@databricks/appkit-ui/react";
import { RotateCw } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { z } from "zod";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useLastGood } from "../../hooks/useLastGood";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { type EntryJobIds, type IdUse, PatternMatchRow, idUse, queryFailure } from "../../lib/picker";

const PatternMatchRows = z.array(PatternMatchRow);
const DELAY_MS = 300;
const NAMES_SHOWN = 10;
const NO_ACCESS = "You don't have access to system.lakeflow.jobs, so the app can't show which jobs match.";
const NO_JOB_IDS: EntryJobIds = { jobIds: [], environments: {} };

export interface PatternMatchesProps {
  /** job_name_regex as typed. Empty shows a hint and runs no query. */
  pattern: string;
  /** job_name_exclude_regex as typed, or empty for none. */
  exclude: string;
  /**
   * The entry's job IDs. Where they apply, the scan finds the job by its ID:
   * the preview says so, the match count is only information, and there is no
   * not-found warning for those workspaces.
   */
  jobIds?: EntryJobIds;
}

/** "lower", "lower and production", "a, b and c". */
function listOf(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** Where the scan finds the job by its job ID, or null when it uses the name everywhere. */
function idNote({ byId, except }: IdUse): string | null {
  if (byId && except.length === 0) return "The scan finds this job by its job ID.";
  if (byId) return `The scan finds this job by its job ID, except in ${listOf(except)}, where it uses the pattern.`;
  if (except.length > 0) return `In ${listOf(except)}, the scan finds this job by its job ID. Elsewhere it uses the pattern.`;
  return null;
}

/** The warning for a pattern that matches nothing, only for the workspaces where the scan uses the pattern. */
function notFoundNote({ byId, except }: IdUse): string | null {
  if (!byId && except.length === 0) return "The scan would report this job as not found.";
  if (byId && except.length === 0) return null;
  return byId ? `In ${listOf(except)}, the scan would report this job as not found.` : "Elsewhere, the scan would report this job as not found.";
}

interface NameGroup {
  name: string;
  jobs: number;
}

/** Matches in name order, one entry per name with how many workspaces have it. */
function byName(rows: PatternMatchRow[]): NameGroup[] {
  const groups: NameGroup[] = [];
  for (const row of rows) {
    const name = row.name ?? "";
    const last = groups.at(-1);
    if (last && last.name === name) last.jobs += 1;
    else groups.push({ name, jobs: 1 });
  }
  return groups;
}

interface FrameProps {
  children: ReactNode;
  /** True while a query runs, so screen readers wait for the answer. */
  busy?: boolean;
  /** Where the scan finds the job by its job ID, above whatever the pattern shows. */
  note?: string | null;
}

function Frame({ children, busy = false, note = null }: FrameProps) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs" role="status" aria-live="polite" aria-busy={busy}>
      {note ? <p className="mb-1 font-medium text-foreground">{note}</p> : null}
      {children}
    </div>
  );
}

/**
 * Which real jobs a name pattern matches (pattern_matches.obo.sql, as the
 * signed-in person), the way the system table scan matches them: "Matches N
 * jobs" and the first 10 names. When the query fails with the code the
 * warehouse uses for both a bad pattern and a missing grant, pattern_check
 * tells the two apart. Where the entry's job IDs apply, the scan finds the job
 * by ID instead, so the preview says that first and keeps the count as
 * information (a picked job's name in a development-mode workspace has a
 * "[dev user] " prefix, so its ^name$ pattern matches nothing).
 */
export function PatternMatches({ pattern, exclude, jobIds = NO_JOB_IDS }: PatternMatchesProps) {
  const use = useMemo(() => idUse(jobIds), [jobIds]);
  const note = idNote(use);
  const settledPattern = useDebouncedValue(pattern, DELAY_MS);
  const settledExclude = useDebouncedValue(exclude, DELAY_MS);
  const settledWorkspaceId = useDebouncedValue(jobIds.workspaceId ?? "", DELAY_MS);
  const { refresh, bump } = useRefreshKey();
  const ready = settledPattern !== "";
  const parameters = useMemo(
    () => ({ pattern: sql.string(settledPattern), exclude: sql.string(settledExclude), workspace_id: sql.string(settledWorkspaceId), refresh: sql.int(refresh) }),
    [settledPattern, settledExclude, settledWorkspaceId, refresh],
  );
  const matches = useAnalyticsQuery("pattern_matches", parameters, { autoStart: ready });
  const failure = ready && matches.error !== null ? queryFailure(matches.error, matches.errorCode) : null;
  const check = useAnalyticsQuery("pattern_check", parameters, { autoStart: failure === "rejected" });
  // Only the warehouse refusing pattern_check too says the pattern is bad; another failure of it says nothing about the pattern.
  const checkFailure = failure === "rejected" && check.error !== null ? queryFailure(check.error, check.errorCode) : null;

  const parsed = useMemo(() => (matches.data === null ? null : PatternMatchRows.safeParse(matches.data)), [matches.data]);
  const answer = useMemo(
    () => (parsed?.success ? { pattern: settledPattern, exclude: settledExclude, workspaceId: settledWorkspaceId, rows: parsed.data } : null),
    [parsed, settledPattern, settledExclude, settledWorkspaceId],
  );
  // A refresh keeps the last answer for the same pattern on screen.
  const kept = useLastGood(answer);
  const shown = kept !== null && kept.pattern === settledPattern && kept.exclude === settledExclude && kept.workspaceId === settledWorkspaceId ? kept : null;

  if (pattern === "") {
    return (
      <Frame note={note}>
        <p className="text-muted-foreground">Type a name pattern to see which jobs in this region it matches.</p>
      </Frame>
    );
  }

  if (failure === "no_access" || (failure === "rejected" && check.data !== null && check.error === null)) {
    return (
      <Frame note={note}>
        <p className="text-muted-foreground">{NO_ACCESS}</p>
      </Frame>
    );
  }

  if (checkFailure === "rejected") {
    return (
      <Frame note={note}>
        <p className="font-medium text-destructive">This pattern has an error.</p>
        <p className="mt-0.5 text-muted-foreground">
          {settledExclude ? "Check the name pattern and the exclusion." : "Check it for an unclosed bracket or parenthesis."}
        </p>
      </Frame>
    );
  }

  if (failure === "other" || checkFailure !== null || parsed?.success === false) {
    let detail = matches.error;
    if (parsed?.success === false) detail = "The matches had an unexpected shape.";
    else if (checkFailure !== null) detail = check.error;
    return (
      <Frame note={note}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-foreground">Could not check the pattern.</span>
          <Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={() => bump()}>
            <RotateCw className="size-3" aria-hidden="true" />
            Retry
          </Button>
        </div>
        <p className="mt-0.5 text-muted-foreground">{detail}</p>
      </Frame>
    );
  }

  // Still loading, or waiting for pattern_check to say what the failure means.
  if (shown === null || failure === "rejected") {
    return (
      <Frame busy note={note}>
        <Skeleton className="h-3.5 w-32" />
        <div className="mt-2 flex flex-col gap-1.5">
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-52" />
        </div>
      </Frame>
    );
  }

  const total = shown.rows[0]?.match_count ?? 0;
  const groups = byName(shown.rows).slice(0, NAMES_SHOWN);
  const more = total - groups.reduce((sum, group) => sum + group.jobs, 0);
  const count = total === 1 ? "1 job" : `${total} jobs`;
  const warning = total === 0 ? notFoundNote(use) : null;

  return (
    <Frame note={note}>
      {/* Under a job ID line the count is only information; without one it is the answer. */}
      {note ? <p className="text-muted-foreground">The pattern matches {count}.</p> : <p className="font-medium text-foreground">Matches {count}</p>}
      {total === 0 ? (
        warning ? <p className="mt-0.5 text-muted-foreground">{warning}</p> : null
      ) : (
        <>
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {groups.map((group) => (
              <li key={group.name} className="truncate font-mono text-[11px] leading-4 text-foreground" title={group.name}>
                {group.name}
                {group.jobs > 1 ? <span className="font-sans text-muted-foreground"> in {group.jobs} workspaces</span> : null}
              </li>
            ))}
          </ul>
          {more > 0 ? <p className="mt-1 text-muted-foreground">and {more} more</p> : null}
        </>
      )}
    </Frame>
  );
}
