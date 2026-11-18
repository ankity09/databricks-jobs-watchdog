import { Skeleton, ToggleGroup, ToggleGroupItem } from "@databricks/appkit-ui/react";
import { memo, type PointerEvent, useCallback, useMemo, useState } from "react";
import { useNow } from "../../hooks/useNow";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { useWatchdogLocation } from "../../hooks/useWatchdogRows";
import type { HistoryRow } from "../../lib/rows";
import { type Status, STATUSES, statusTone } from "../../lib/status";
import { formatUtc, parseTime } from "../../lib/time";
import { cn } from "../../lib/utils";
import { STATUS_LABEL, TONE_FILL } from "./format";
import { jobKey, type JobRef, workspaceLabel } from "./jobs";
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

/**
 * The ranges to pick, each with the length of one window. The strip has one column per window, so it has
 * at most 25, 37 or 43 columns however often the scan runs. Windows start on multiples of their length from
 * the Unix epoch (job_history.obo.sql), so a 2-hour window starts at an even UTC hour.
 */
const RANGES = [
  { hours: 24, label: "24 h", phrase: "24 hours", bucketMinutes: 60, windowPhrase: "1-hour" },
  { hours: 72, label: "3 days", phrase: "3 days", bucketMinutes: 120, windowPhrase: "2-hour" },
  { hours: 168, label: "7 days", phrase: "7 days", bucketMinutes: 240, windowPhrase: "4-hour" },
] as const;
type Range = (typeof RANGES)[number];
const DEFAULT_RANGE: Range = RANGES[1];

/** The label columns: job name, then workspace from 1024 px up (below that the track needs the room). */
const GRID = "grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] lg:grid-cols-[minmax(0,13rem)_minmax(0,8rem)_minmax(0,1fr)]";

/** One window: a column of the strip. */
interface Column {
  at: string;
  ms: number;
}

interface Cell {
  status: Status;
  /** When the window starts. */
  at: string;
  scans: number;
}

/**
 * Every window of the range, oldest first (also the ones in which no scan ran, which show as gaps), and each
 * job's cell per window (null when no scan in that window saw the job). Rows outside the range are dropped.
 */
function buildModel(jobs: readonly HistoryJob[], history: readonly HistoryRow[], range: Range, nowMs: number) {
  const size = range.bucketMinutes * 60_000;
  const first = Math.floor((nowMs - range.hours * 3_600_000) / size);
  const shown = new Set(jobs.map(jobKey));
  const rows = history.filter((row) => shown.has(jobKey(row)));
  // The clock of this browser may run behind the warehouse's: never drop the newest window.
  let last = Math.floor(nowMs / size);
  for (const row of rows) last = Math.max(last, Math.floor((parseTime(row.observed_at) ?? 0) / size));
  const columns: Column[] = [];
  for (let index = first; index <= last; index += 1) columns.push({ at: new Date(index * size).toISOString(), ms: index * size });
  const cells = new Map<string, Array<Cell | null>>();
  let drawn = 0;
  for (const row of rows) {
    const index = Math.floor((parseTime(row.observed_at) ?? 0) / size) - first;
    if (index < 0 || index >= columns.length) continue;
    const key = jobKey(row);
    const line = cells.get(key) ?? columns.map(() => null);
    line[index] = { status: row.status, at: row.observed_at, scans: row.scans };
    cells.set(key, line);
    drawn += 1;
  }
  return { columns, cells, drawn };
}

/** "3 windows with scans: 1 failed, 2 healthy. Newest: Healthy in the window from 2026-11-05 10:00 UTC." */
function summarize(cells: ReadonlyArray<Cell | null>): string {
  const seen = cells.filter((cell): cell is Cell => cell !== null);
  if (seen.length === 0) return "No scans in this range.";
  const counts = STATUSES.map((status) => [status, seen.filter((cell) => cell.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${STATUS_LABEL[status].toLowerCase()}`);
  const newest = seen[seen.length - 1];
  const newestText = newest ? ` Newest: ${STATUS_LABEL[newest.status]} in the window from ${formatUtc(newest.at)}.` : "";
  return `${seen.length} ${seen.length === 1 ? "window" : "windows"} with scans: ${counts.join(", ")}.${newestText}`;
}

function Tooltip({ cell, index, count, windowPhrase }: { cell: Cell; index: number; count: number; windowPhrase: string }) {
  // Keep the tip inside the strip at both ends.
  const align = index < count * 0.15 ? "left-0" : index > count * 0.85 ? "right-0" : "left-1/2 -translate-x-1/2";
  return (
    <span role="tooltip" className={cn("pointer-events-none absolute bottom-full z-50 mb-2 w-max rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md", align)}>
      <span className="block font-mono tabular-nums">{formatUtc(cell.at)}</span>
      <span className="block font-medium">{STATUS_LABEL[cell.status]}</span>
      <span className="block text-background/80">
        {cell.scans} {cell.scans === 1 ? "scan" : "scans"} in this {windowPhrase} window
      </span>
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
  windowPhrase: string;
}

const Line = memo(function Line({ job, lineKey, cells, columns, hovered, windowPhrase }: LineProps) {
  return (
    <li className={cn(GRID, "items-center gap-3 py-[3px]")}>
      <span className="truncate font-mono text-xs text-foreground" title={`${job.job_name} in ${workspaceLabel(job)}`}>
        {job.job_name}
      </span>
      <span className="hidden truncate text-xs text-muted-foreground lg:block">{workspaceLabel(job)}</span>
      <span className="flex h-[18px] min-w-0 items-stretch gap-px overflow-hidden">
        {columns.map((column, index) => {
          const cell = cells[index] ?? null;
          if (cell === null) return <span key={column.ms} data-slot="history-gap" className="min-w-0 flex-1 rounded-[2px] bg-muted" />;
          return (
            <span
              key={column.ms}
              data-slot="history-cell"
              data-status={cell.status}
              data-line={lineKey}
              data-index={index}
              className={cn("relative min-w-0 flex-1 rounded-[2px]", TONE_FILL[statusTone(cell.status)], hovered === index && "ring-2 ring-foreground/70 ring-offset-1")}
            >
              {hovered === index ? <Tooltip cell={cell} index={index} count={columns.length} windowPhrase={windowPhrase} /> : null}
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
        No scan saw the job in that window
      </li>
    </ul>
  );
}

const NO_CELLS: ReadonlyArray<Cell | null> = [];

/**
 * Each job's worst status in every fixed time window of the chosen range (3 days
 * in 2-hour windows at first; 24 h in 1-hour and 7 days in 4-hour windows to
 * pick), from findings. The windows line up across jobs, and the number of
 * columns does not depend on how often the scan runs. Hovering a cell shows
 * the window, what it found and how many scans it holds; each line also has a
 * text summary for screen readers.
 */
export function HistoryStrip({ jobs }: HistoryStripProps) {
  const { bump } = useRefreshKey();
  const where = useWatchdogLocation();
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const history = useJobHistory(where, range.hours, range.bucketMinutes);
  // The start of the current window: the model changes when a new window begins, not every minute.
  const size = range.bucketMinutes * 60_000;
  const windowStart = Math.floor(useNow().getTime() / size) * size;
  const [hovered, setHovered] = useState<{ line: string; index: number } | null>(null);

  const model = useMemo(() => (history.rows === null ? null : buildModel(jobs, history.rows, range, windowStart)), [jobs, history.rows, range, windowStart]);

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
  } else if (model.drawn === 0) {
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
                windowPhrase={range.windowPhrase}
              />
            );
          })}
        </ul>
        <div className={cn(GRID, "mt-1 gap-3")} aria-hidden="true">
          <span />
          <span className="hidden lg:block" />
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
        <p className="basis-full text-xs text-pretty text-muted-foreground">Each cell is the worst status in one {range.windowPhrase} window, oldest on the left. Hover a cell to see the window and what it found.</p>
      </div>
      {body}
      {model !== null && model.drawn > 0 && jobs.length > 0 ? (
        <div className="mt-3 border-t border-border pt-3">
          <Legend />
        </div>
      ) : null}
    </section>
  );
}
