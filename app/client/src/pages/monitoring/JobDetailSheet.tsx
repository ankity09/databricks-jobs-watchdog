import {
  Button,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from "@databricks/appkit-ui/react";
import { ArrowUpRight, MessageSquareText } from "lucide-react";
import { type ReactNode, useMemo, useRef } from "react";
import { Link } from "react-router";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { useWatchdogLocation } from "../../hooks/useWatchdogRows";
import type { CheckRow } from "../../lib/rows";
import { type Status, worstStatus } from "../../lib/status";
import { formatUtc, formatUtcAfter, parseTime } from "../../lib/time";
import { cn } from "../../lib/utils";
import { categoryLabel, formatDuration, SEVERITY_LABEL, shortCodeVersion, sourceLabel, triggerLabel } from "./format";
import { compareText, highestSeverity, newestScan, sameJob } from "./jobs";
import { ProblemAlert } from "./ProblemAlert";
import { useJobChecks } from "./queries";
import { StatusBadge } from "./StatusBadge";

export interface JobDetailSheetProps {
  /** The job name. */
  job: string | null;
  workspaceId: string | null;
  jobId: string | null;
  open: boolean;
  onOpenChange(this: void, open: boolean): void;
  /** The control to focus when the panel closes (the row's job button). */
  focusBack?: () => HTMLElement | null;
  /** The job's status from its table row, shown (and sent to the copilot) until the checks load, or when they fail. */
  rowStatus?: Status | null;
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex max-w-full items-center gap-0.5 rounded-sm font-mono text-xs text-foreground underline decoration-border underline-offset-4 outline-none hover:text-primary hover:decoration-primary focus-visible:ring-[3px] focus-visible:ring-ring"
    >
      <span className="truncate">{children}</span>
      <ArrowUpRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="sr-only">, opens in a new tab</span>
    </a>
  );
}

/** A label and a value, in a definition list. */
function Fact({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "truncate font-mono text-[13px] tabular-nums" : "truncate text-[13px]"}>{children}</dd>
    </div>
  );
}

const NOT_SET = <span className="text-muted-foreground">Not set</span>;

/** The newest run among the checks, by start time, for "Open run". */
function newestRunUrl(checks: CheckRow[]): string | null {
  let url: string | null = null;
  let newest = -Infinity;
  for (const check of checks) {
    const started = check.run_start_time === null ? null : parseTime(check.run_start_time);
    if (check.run_page_url !== null && (url === null || (started !== null && started > newest))) {
      url = check.run_page_url;
      if (started !== null) newest = started;
    }
  }
  return url;
}

/** One check that is not healthy: what it found, and the run it is about. */
function CheckCard({ check }: { check: CheckRow }) {
  const category = categoryLabel(check.failure_category);
  return (
    <li className="rounded-lg border border-border bg-card p-3 shadow-xs">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={check.status} />
        <h3 className="font-mono text-[13px] font-medium">{check.check_id}</h3>
        <span className="text-xs text-muted-foreground">{sourceLabel(check.source)}</span>
        {category ? <span className="ml-auto rounded-[4px] bg-muted px-1.5 py-px text-[11px] text-muted-foreground">{category}</span> : null}
      </div>
      {check.error_summary ? (
        <p data-slot="check-error" className="mt-2.5 max-h-40 overflow-y-auto rounded-md border border-border bg-muted/60 px-2.5 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-foreground">
          {check.error_summary}
        </p>
      ) : null}
      {check.failed_task_keys.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Failed tasks</span>
          {check.failed_task_keys.map((task) => (
            <span key={task} className="rounded-[4px] border border-destructive/25 bg-destructive/[0.06] px-1.5 py-px font-mono text-[11px] text-destructive">
              {task}
            </span>
          ))}
        </div>
      ) : null}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        <Fact label="Run">{check.run_page_url ? <ExternalLink href={check.run_page_url}>{check.run_id ?? "Open"}</ExternalLink> : NOT_SET}</Fact>
        <Fact label="Pipeline">{check.pipeline_url ? <ExternalLink href={check.pipeline_url}>Open</ExternalLink> : NOT_SET}</Fact>
        <Fact label="Code version" mono>
          <span title={check.code_version ?? undefined}>{check.code_version ? shortCodeVersion(check.code_version) : NOT_SET}</span>
        </Fact>
        <Fact label="Trigger">{check.trigger_type ? triggerLabel(check.trigger_type, check.triggered_by) : NOT_SET}</Fact>
        <Fact label="Started" mono>
          {check.run_start_time ? formatUtc(check.run_start_time) : NOT_SET}
        </Fact>
        <Fact label="Ended" mono>
          {check.run_end_time ? formatUtc(check.run_end_time) : check.run_start_time ? "Still going" : NOT_SET}
        </Fact>
        <Fact label="Duration" mono>
          {check.run_duration_seconds === null ? NOT_SET : formatDuration(check.run_duration_seconds)}
        </Fact>
      </dl>
    </li>
  );
}

interface RunFact {
  label: string;
  value: ReactNode;
  mono?: boolean;
}

/** The run facts a check has a value for, in the card's order. */
function presentRunFacts(check: CheckRow): RunFact[] {
  const facts: RunFact[] = [];
  if (check.run_page_url) facts.push({ label: "Run", value: <ExternalLink href={check.run_page_url}>{check.run_id ?? "Open"}</ExternalLink> });
  if (check.pipeline_url) facts.push({ label: "Pipeline", value: <ExternalLink href={check.pipeline_url}>Open</ExternalLink> });
  if (check.code_version) facts.push({ label: "Code version", value: <span title={check.code_version}>{shortCodeVersion(check.code_version)}</span>, mono: true });
  if (check.trigger_type) facts.push({ label: "Trigger", value: triggerLabel(check.trigger_type, check.triggered_by) });
  if (check.run_start_time) facts.push({ label: "Started", value: formatUtc(check.run_start_time), mono: true });
  if (check.run_end_time) {
    const ended = check.run_start_time ? formatUtcAfter(check.run_end_time, check.run_start_time) : formatUtc(check.run_end_time);
    facts.push({ label: "Ended", value: ended, mono: true });
  }
  if (check.run_duration_seconds !== null) facts.push({ label: "Duration", value: formatDuration(check.run_duration_seconds), mono: true });
  return facts;
}

/** A healthy check: one line with what it found, and a compact line with the run facts it has. */
function HealthyCheck({ check }: { check: CheckRow }) {
  const facts = presentRunFacts(check);
  return (
    <li className="flex min-w-0 flex-col gap-1 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <StatusBadge status={check.status} />
        <h3 className="shrink-0 font-mono text-[13px] font-medium">{check.check_id}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">{sourceLabel(check.source)}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={check.error_summary ?? undefined}>
          {check.error_summary}
        </span>
      </div>
      {facts.length > 0 ? (
        <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
          {facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 items-baseline gap-1.5">
              <dt className="shrink-0 text-muted-foreground">{fact.label}</dt>
              <dd className={cn("min-w-0 truncate", fact.mono && "font-mono tabular-nums")}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

function SheetSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <div className="grid grid-cols-3 gap-3">
        {["a", "b", "c", "d", "e", "f"].map((id) => (
          <Skeleton key={id} className="h-9 motion-reduce:animate-none" />
        ))}
      </div>
      <Skeleton className="motion-reduce:animate-none h-36 rounded-lg" />
      <Skeleton className="motion-reduce:animate-none h-28 rounded-lg" />
    </div>
  );
}

/**
 * The side panel for one job in one workspace: the job's facts, each check's
 * newest result with its run and pipeline links, the jobs a failure affects,
 * and Open run and Ask the copilot. Rows come from job_checks, kept to this
 * workspace and job ID (a job name can run in several workspaces).
 */
export function JobDetailSheet({ job, workspaceId, jobId, open, onOpenChange, focusBack, rowStatus = null }: JobDetailSheetProps) {
  const { bump } = useRefreshKey();
  const where = useWatchdogLocation();
  const checks = useJobChecks(where, job, open);
  const panelRef = useRef<HTMLDivElement>(null);

  const mine = useMemo(() => {
    if (job === null || checks.rows === null) return null;
    const ref = { job_name: job, workspace_id: workspaceId, job_id: jobId };
    return checks.rows.filter((check) => sameJob(check, ref));
  }, [checks.rows, job, workspaceId, jobId]);

  const facts = mine?.[0] ?? null;
  // The checks' worst status once they load; until then, or when they fail to load, the table row's.
  const status = mine && mine.length > 0 ? worstStatus(mine.map((check) => check.status)) : rowStatus;
  const failing = mine?.filter((check) => check.status !== "HEALTHY") ?? [];
  const healthy = mine?.filter((check) => check.status === "HEALTHY") ?? [];
  const severity = highestSeverity(failing.map((check) => check.severity));
  // Both scans fill affected_jobs on FAILED rows only, so the section is for a job with a failed check.
  const failed = useMemo(() => (mine ?? []).filter((check) => check.status === "FAILED"), [mine]);
  const affected = useMemo(() => [...new Set(failed.flatMap((check) => check.affected_jobs))].sort(compareText), [failed]);
  const runUrl = mine ? newestRunUrl(mine) : null;
  const newestObserved = mine ? newestScan(mine) : null;

  const copilotHref = useMemo(() => {
    const params = new URLSearchParams();
    if (job !== null) params.set("job", job);
    if (workspaceId !== null) params.set("workspace", workspaceId);
    if (status !== null) params.set("status", status);
    return `/copilot?${params.toString()}`;
  }, [job, workspaceId, status]);

  const workspaceName = facts?.workspace_name ?? null;
  // Skeletons only while the checks load: after an error, or with no checks, the facts say "Not set".
  const loadingChecks = mine === null && checks.problem === null;
  const pending = (width: string) => (loadingChecks ? <Skeleton className={`motion-reduce:animate-none mt-1 h-4 ${width}`} /> : NOT_SET);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={panelRef}
        side="right"
        className="w-full gap-0 outline-none sm:max-w-[600px]"
        // Focus the panel itself: Radix would focus the close button, whose ring then shows for a mouse click too.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          panelRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const target = focusBack?.();
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <SheetHeader className="gap-2 border-b border-border px-5 pt-5 pb-4">
          <div className="flex flex-wrap items-center gap-2 pr-8">
            {status ? <StatusBadge status={status} /> : loadingChecks ? <Skeleton className="motion-reduce:animate-none h-[22px] w-16" /> : null}
            {severity ? <span className="text-xs text-muted-foreground">{SEVERITY_LABEL[severity]} severity</span> : null}
          </div>
          <SheetTitle className="font-mono text-lg leading-6 font-medium break-all">{job ?? ""}</SheetTitle>
          <SheetDescription className="text-[13px]">
            {workspaceId === null ? "Not found in any workspace" : `${workspaceName ?? "Workspace"}, job ${jobId ?? "unknown"}`}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Fact label="Workspace">{workspaceName ?? (workspaceId === null ? "Not found" : NOT_SET)}</Fact>
            <Fact label="Workspace ID" mono>
              {workspaceId ?? NOT_SET}
            </Fact>
            <Fact label="Job ID" mono>
              {jobId ?? NOT_SET}
            </Fact>
            <Fact label="Environment">{facts ? (facts.environment ?? NOT_SET) : pending("w-20")}</Fact>
            <Fact label="Owner">{facts ? (facts.owner ?? NOT_SET) : pending("w-24")}</Fact>
            <Fact label="Schedule">{facts ? (facts.schedule_type ?? NOT_SET) : pending("w-20")}</Fact>
            {facts?.parent_job ? (
              <Fact label="Started by" mono>
                {facts.parent_job}
              </Fact>
            ) : null}
            <Fact label="Scanned" mono>
              {newestObserved ? formatUtc(newestObserved) : pending("w-32")}
            </Fact>
          </dl>

          <section aria-labelledby="checks-heading" className="mt-6">
            <h2 id="checks-heading" className="text-sm font-semibold">
              Checks
            </h2>
            {checks.problem && mine === null ? (
              <ProblemAlert className="mt-2" problem={checks.problem} location={where.location} title="Could not load the checks" onRetry={bump} />
            ) : mine === null ? (
              <div className="mt-2">
                <SheetSkeleton />
              </div>
            ) : mine.length === 0 ? (
              <p className="mt-2 text-[13px] text-muted-foreground">The newest scan has no checks for this job in this workspace. It may have been removed from the job list.</p>
            ) : (
              <>
                {checks.problem ? (
                  <ProblemAlert className="mt-2" problem={checks.problem} location={where.location} title="Could not refresh the checks" detail="Showing the checks from the last answer." onRetry={bump} />
                ) : null}
                {failing.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-2.5">
                    {failing.map((check) => (
                      <CheckCard key={`${check.check_id}:${check.source}`} check={check} />
                    ))}
                  </ul>
                ) : null}
                {healthy.length > 0 ? (
                  <ul className="mt-2 divide-y divide-border rounded-lg border border-border px-3" aria-label="Healthy checks">
                    {healthy.map((check) => (
                      <HealthyCheck key={`${check.check_id}:${check.source}`} check={check} />
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </section>

          {failed.length > 0 ? (
            <section aria-labelledby="affected-heading" className="mt-6">
              <h2 id="affected-heading" className="text-sm font-semibold">
                Affected jobs
              </h2>
              {affected.length === 0 ? (
                <p className="mt-1.5 text-[13px] text-muted-foreground">No other jobs depend on this one.</p>
              ) : (
                <>
                  <p className="mt-0.5 text-xs text-muted-foreground">These jobs depend on this one, so a failure here can hold them up.</p>
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {affected.map((name) => (
                      <li key={name} className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs">
                        {name}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          ) : null}
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-border px-5 py-3">
          {runUrl ? (
            <Button asChild variant="outline" size="sm">
              <a href={runUrl} target="_blank" rel="noreferrer">
                Open run
                <ArrowUpRight aria-hidden="true" />
                <span className="sr-only">, opens in a new tab</span>
              </a>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled title="No run to open yet.">
              Open run
            </Button>
          )}
          <Button asChild size="sm">
            <Link to={copilotHref}>
              <MessageSquareText aria-hidden="true" />
              Ask the copilot
            </Link>
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
