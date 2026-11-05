import { Skeleton, ToggleGroup, ToggleGroupItem } from "@databricks/appkit-ui/react";
import { memo, type PointerEvent, useCallback, useMemo, useState } from "react";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { useWatchdogLocation } from "../../hooks/useWatchdogRows";
import type { HistoryRow } from "../../lib/rows";
import { type Status, STATUSES, statusTone } from "../../lib/status";
import { formatUtc, parseTime } from "../../lib/time";
import { cn } from "../../lib/utils";
import { STATUS_LABEL, TONE_FILL } from "./format";
import { compareText, jobKey, type JobRef, workspaceLabel } from "./jobs";
import { ProblemAlert } from "./ProblemAlert";
import { useJobHistory } from "./queries";

/** A job the strip draws a line for. */
export interface HistoryJob extends JobRef {
  workspace_name: string | null;
}

export interface HistoryStripProps {
  /** The jobs to show, in the order to show them (the table's order). */
  jobs: readonly HistoryJob[];
}

const RANGES = [
  { hours: 24, label: "24 h", phrase: "24 hours" },
  { hours: 72, label: "3 days", phrase: "3 days" },
  { hours: 168, label: "7 days", phrase: "7 days" },
] as const;
type Range = (typeof RANGES)[number];
const DEFAULT_RANGE: Range = RANGES[1];

/** One scan: a column of the strip. */
interface Column {
  scanId: string;
  at: string;
  ms: number;
}

interface Cell {
  status: Status;
  at: string;
}

/** The scans in time order, and each job's cell per scan (null when that scan did not see the job). */
function buildModel(jobs: readonly HistoryJob[], history: readonly HistoryRow[]) {
  const shown = new Set(jobs.map(jobKey));
  const rows = history.filter((row) => shown.has(jobKey(row)));
  const firstSeen = new Map<string, Column>();
  for (const row of rows) {
    const ms = parseTime(row.observed_at) ?? 0;
    const known = firstSeen.get(row.scan_id);
    if (!known || ms < known.ms) firstSeen.set(row.scan_id, { scanId: row.scan_id, at: row.observed_at, ms });
  }
  const columns = [...firstSeen.values()].sort((a, b) => a.ms - b.ms || compareText(a.scanId, b.scanId));
  const position = new Map(columns.map((column, index) => [column.scanId, index]));
  const cells = new Map<string, Array<Cell | null>>();
  for (const row of rows) {
    const key = jobKey(row);
    const line = cells.get(key) ?? columns.map(() => null);
    const index = position.get(row.scan_id);
    if (index !== undefined) line[index] = { status: row.status, at: row.observed_at };
    cells.set(key, line);
  }
  return { columns, cells };
}

/** "3 scans: 1 failed, 2 healthy. Newest: Healthy at 2026-11-05 10:05 UTC." */
function summarize(cells: ReadonlyArray<Cell | null>): string {
  const seen = cells.filter((cell): cell is Cell => cell !== null);
  if (seen.length === 0) return "No scans in this range.";
  const counts = STATUSES.map((status) => [status, seen.filter((cell) => cell.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${STATUS_LABEL[status].toLowerCase()}`);
  const newest = seen[seen.length - 1];
  const newestText = newest ? ` Newest: ${STATUS_LABEL[newest.status]} at ${formatUtc(newest.at)}.` : "";
  return `${seen.length} ${seen.length === 1 ? "scan" : "scans"}: ${counts.join(", ")}.${newestText}`;
}

function Tooltip({ cell, index, count }: { cell: Cell; index: number; count: number }) {
  // Keep the tip inside the strip at both ends.
  const align = index < count * 0.15 ? "left-0" : index > count * 0.85 ? "right-0" : "left-1/2 -translate-x-1/2";
  return (
    <span role="tooltip" className={cn("pointer-events-none absolute bottom-full z-50 mb-2 w-max rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md", align)}>
      <span className="block font-mono tabular-nums">{formatUtc(cell.at)}</span>
      <span className="block font-medium">{STATUS_LABEL[cell.status]}</span>
    </span>
  );
}

interface LineProps {
  job: HistoryJob;
  lineKey: string;
  cells: ReadonlyArray<Cell | null>;
  columns: readonly Column[];
  /** The hovered cell of this line, if any. */
  hovered: number | null;
}

const Line = memo(function Line({ job, lineKey, cells, columns, hovered }: LineProps) {
  return (
    <li className="grid grid-cols-[minmax(0,13rem)_minmax(0,8rem)_minmax(0,1fr)] items-center gap-3 py-[3px]">
      <span className="truncate font-mono text-xs text-foreground" title={job.job_name}>
        {job.job_name}
      </span>
      <span className="truncate text-xs text-muted-foreground">{workspaceLabel(job)}</span>
      <span className="flex h-[18px] min-w-0 items-stretch gap-px">
        {columns.map((column, index) => {
          const cell = cells[index] ?? null;
          if (cell === null) return <span key={column.scanId} data-slot="history-gap" className="min-w-0 flex-1 rounded-[2px] bg-muted" />;
          return (
            <span
              key={column.scanId}
              data-slot="history-cell"
              data-status={cell.status}
              data-line={lineKey}
              data-index={index}
              className={cn("relative min-w-0 flex-1 rounded-[2px]", TONE_FILL[statusTone(cell.status)], hovered === index && "ring-2 ring-foreground/70 ring-offset-1")}
            >
              {hovered === index ? <Tooltip cell={cell} index={index} count={columns.length} /> : null}
            </span>
          );
        })}
      </span>
      <span className="sr-only">{summarize(cells)}</span>
    </li>
  );
});

function Legend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Colors">
      {STATUSES.map((status) => (
        <li key={status} className="flex items-center gap-1.5">
          <span className={cn("size-2.5 rounded-[2px]", TONE_FILL[statusTone(status)])} aria-hidden="true" />
          {STATUS_LABEL[status]}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[2px] bg-muted ring-1 ring-border ring-inset" aria-hidden="true" />
        Not in that scan
      </li>
    </ul>
  );
}

const NO_CELLS: ReadonlyArray<Cell | null> = [];

/**
 * Each job's status at every scan in the chosen range (3 days at first; 24 h
 * and 7 days to pick), from findings. The scans line up across jobs. Hovering
 * a cell shows when that scan ran and what it found; each line also has a text
 * summary for screen readers.
 */
export function HistoryStrip({ jobs }: HistoryStripProps) {
  const { bump } = useRefreshKey();
  const where = useWatchdogLocation();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const history = useJobHistory(where, range.hours);
  const [hovered, setHovered] = useState<{ line: string; index: number } | null>(null);

  const model = useMemo(() => (history.rows === null ? null : buildModel(jobs, history.rows)), [jobs, history.rows]);

  const onPointerOver = useCallback((event: PointerEvent<HTMLUListElement>) => {
    const cell = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-line][data-index]") : null;
    const line = cell?.dataset.line;
    const index = Number(cell?.dataset.index);
    if (!line || !Number.isInteger(index)) {
      setHovered(null);
      return;
    }
    setHovered((previous) => (previous?.line === line && previous.index === index ? previous : { line, index }));
  }, []);
  const onPointerLeave = useCallback(() => setHovered(null), []);

  let body;
  if (history.problem && model === null) {
    body = <ProblemAlert problem={history.problem} location={where.location} title="Could not load the scan history" onRetry={bump} />;
  } else if (model === null) {
    body = (
      <div className="flex flex-col gap-2 py-1" aria-hidden="true">
        {jobs.slice(0, 6).map((job) => (
          <Skeleton key={jobKey(job)} className="h-[18px] motion-reduce:animate-none" />
        ))}
      </div>
    );
  } else if (jobs.length === 0) {
    body = <p className="py-2 text-[13px] text-muted-foreground">No history to show for these filters.</p>;
  } else if (model.columns.length === 0) {
    body = <p className="py-2 text-[13px] text-muted-foreground">No scans in the last {range.phrase}.</p>;
  } else {
    const first = model.columns[0];
    const last = model.columns[model.columns.length - 1];
    body = (
      <>
        {history.problem ? (
          <ProblemAlert className="mb-3" problem={history.problem} location={where.location} title="Could not refresh the scan history" detail="Showing the last answer." onRetry={bump} />
        ) : null}
        <ul aria-label="Scan history by job" onPointerOver={onPointerOver} onPointerLeave={onPointerLeave}>
          {jobs.map((job) => {
            const key = jobKey(job);
            return (
              <Line
                key={key}
                job={job}
                lineKey={key}
                cells={model.cells.get(key) ?? NO_CELLS}
                columns={model.columns}
                hovered={hovered?.line === key ? hovered.index : null}
              />
            );
          })}
        </ul>
        <div className="mt-1 grid grid-cols-[minmax(0,13rem)_minmax(0,8rem)_minmax(0,1fr)] gap-3" aria-hidden="true">
          <span />
          <span />
          <span className="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
            <span>{first ? formatUtc(first.at) : ""}</span>
            <span>{last ? formatUtc(last.at) : ""}</span>
          </span>
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="history-heading" className="rounded-lg border border-border bg-card p-4 shadow-xs">
      {/* The range switch sits by the heading, over the job names: a cell's tooltip opens above the cells, so it never covers it. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 id="history-heading" className="text-sm font-semibold">
          Scan history
        </h2>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="History range"
          value={String(range.hours)}
          onValueChange={(value) => {
            const next = RANGES.find((option) => String(option.hours) === value);
            if (next) setRange(next);
          }}
        >
          {RANGES.map((option) => (
            <ToggleGroupItem key={option.hours} value={String(option.hours)} className="h-7 px-2.5 font-mono text-xs">
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="basis-full text-xs text-pretty text-muted-foreground">Each cell is one scan, oldest on the left. Hover a cell to see when it ran and what it found.</p>
      </div>
      {body}
      {model !== null && model.columns.length > 0 && jobs.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3">
          <Legend />
        </div>
      ) : null}
    </section>
  );
}
