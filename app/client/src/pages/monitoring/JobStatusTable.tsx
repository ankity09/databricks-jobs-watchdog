import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@databricks/appkit-ui/react";
import { ArrowUpRight, Flag } from "lucide-react";
import { memo, type MouseEvent } from "react";
import type { JobStatusRow } from "../../lib/rows";
import { formatAgo, formatUtc } from "../../lib/time";
import { cn } from "../../lib/utils";
import { SEVERITY_LABEL } from "./format";
import { jobKey, jobLabel, workspaceLabel } from "./jobs";
import { StatusBadge } from "./StatusBadge";

export interface JobStatusTableProps {
  rows: JobStatusRow[];
  /** The job whose detail panel is open. */
  selectedKey: string | null;
  /** Opens a job's detail panel. `focusBack` is the control to focus when the panel closes. */
  onOpen(this: void, row: JobStatusRow, focusBack: HTMLElement | null): void;
  now: Date;
}

/** Links inside a row open their own target, not the panel. */
function stopRowClick(event: MouseEvent) {
  event.stopPropagation();
}

const MAX_CHECKS = 2;

function FailingChecks({ checks }: { checks: string[] }) {
  if (checks.length === 0) return <span className="text-muted-foreground">None</span>;
  const shown = checks.slice(0, MAX_CHECKS);
  const more = checks.length - shown.length;
  // Rows are two lines tall, so the chips may wrap onto the second line.
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1" title={checks.join(", ")}>
      {shown.map((check) => (
        <span key={check} className="max-w-full truncate rounded-[4px] border border-border bg-muted px-1.5 py-px font-mono text-[11px] leading-4 text-foreground">
          {check}
        </span>
      ))}
      {more > 0 ? (
        <span className="shrink-0 font-mono text-[11px] leading-4 text-muted-foreground">
          +{more}
          <span className="sr-only"> more</span>
        </span>
      ) : null}
    </span>
  );
}

function Severity({ severity }: { severity: JobStatusRow["severity"] }) {
  if (severity === null) return <span className="sr-only">None</span>;
  return (
    <span className={cn("inline-flex items-center gap-1 text-[13px]", severity === "CRITICAL" ? "font-medium text-foreground" : "text-muted-foreground")}>
      <Flag className={cn("size-3", severity === "CRITICAL" ? "fill-destructive text-destructive" : "text-warning")} aria-hidden="true" />
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

function LastRun({ row, now }: { row: JobStatusRow; now: Date }) {
  if (row.last_run_start === null) return <span className="text-muted-foreground">No run</span>;
  const ago = formatAgo(row.last_run_start, now);
  if (row.last_run_url === null) {
    return (
      <span className="font-mono text-xs tabular-nums" title={formatUtc(row.last_run_start)}>
        {ago}
      </span>
    );
  }
  return (
    <a
      href={row.last_run_url}
      target="_blank"
      rel="noreferrer"
      onClick={stopRowClick}
      title={`${formatUtc(row.last_run_start)}. Opens the run in a new tab.`}
      className="inline-flex items-center gap-0.5 rounded-sm font-mono text-xs text-foreground tabular-nums underline-offset-2 outline-none hover:text-primary hover:underline focus-visible:ring-[3px] focus-visible:ring-ring"
    >
      {ago}
      <ArrowUpRight className="size-3 text-muted-foreground" aria-hidden="true" />
      <span className="sr-only">, open the run in a new tab</span>
    </a>
  );
}

interface JobRowProps {
  row: JobStatusRow;
  selected: boolean;
  onOpen: JobStatusTableProps["onOpen"];
  now: Date;
}

const JobRow = memo(function JobRow({ row, selected, onOpen, now }: JobRowProps) {
  const notFound = row.workspace_id === null && row.workspace_name === null;
  const healthy = row.status === "HEALTHY";
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      className="group h-[52px] cursor-pointer"
      onClick={(event) => onOpen(row, event.currentTarget.querySelector("button"))}
    >
      <TableCell className="pl-4">
        <StatusBadge status={row.status} />
      </TableCell>
      <TableCell className="min-w-0">
        <span className="flex min-w-0 items-baseline gap-2">
          <button
            type="button"
            aria-label={jobLabel(row)}
            onClick={(event) => {
              event.stopPropagation();
              onOpen(row, event.currentTarget);
            }}
            className="max-w-full truncate rounded-sm text-left font-mono text-[13px] font-medium text-foreground outline-none group-hover:underline group-hover:decoration-border group-hover:underline-offset-4 focus-visible:ring-[3px] focus-visible:ring-ring"
          >
            {row.job_name}
          </button>
          {row.parent_job ? (
            <span className="shrink-0 truncate text-xs text-muted-foreground">
              started by <span className="font-mono">{row.parent_job}</span>
            </span>
          ) : null}
        </span>
        {healthy ? (
          <span className="block truncate text-xs text-muted-foreground">All checks pass</span>
        ) : (
          <span className="block truncate text-xs text-foreground/85" title={row.top_error ?? undefined}>
            {row.top_error ?? "No details"}
          </span>
        )}
      </TableCell>
      <TableCell className="min-w-0">
        {notFound ? (
          <span className="text-[13px] text-muted-foreground">Not found</span>
        ) : (
          <>
            <span className="block truncate text-[13px]" title={row.workspace_id ?? undefined}>
              {workspaceLabel(row)}
            </span>
            {row.environment ? <span className="block truncate text-xs text-muted-foreground">{row.environment}</span> : null}
          </>
        )}
      </TableCell>
      <TableCell className="min-w-0">
        <span className="block truncate text-[13px]">{row.owner ?? <span className="text-muted-foreground">Not set</span>}</span>
      </TableCell>
      <TableCell>
        <Severity severity={row.severity} />
      </TableCell>
      <TableCell className="min-w-0">
        <FailingChecks checks={row.failing_checks} />
      </TableCell>
      <TableCell className="pr-4 text-right">
        <LastRun row={row} now={now} />
      </TableCell>
    </TableRow>
  );
});

/** One row per job and workspace, worst first. Clicking a row, or its job name, opens the job's detail panel. */
export function JobStatusTable({ rows, selectedKey, onOpen, now }: JobStatusTableProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-xs">
      <Table aria-label="Monitored jobs" className="min-w-[900px] table-fixed">
        <TableHeader className="bg-muted/60">
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-9 w-[104px] pl-4 text-xs font-medium text-muted-foreground">Status</TableHead>
            <TableHead className="h-9 text-xs font-medium text-muted-foreground">Job and reason</TableHead>
            <TableHead className="h-9 w-[14%] text-xs font-medium text-muted-foreground">Workspace</TableHead>
            <TableHead className="h-9 w-[12%] text-xs font-medium text-muted-foreground">Owner</TableHead>
            <TableHead className="h-9 w-[84px] text-xs font-medium text-muted-foreground">Severity</TableHead>
            <TableHead className="h-9 w-[15%] text-xs font-medium text-muted-foreground">Failing checks</TableHead>
            <TableHead className="h-9 w-[96px] pr-4 text-right text-xs font-medium text-muted-foreground">Last run</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const key = jobKey(row);
            return <JobRow key={key} row={row} selected={key === selectedKey} onOpen={onOpen} now={now} />;
          })}
        </TableBody>
      </Table>
    </div>
  );
}
