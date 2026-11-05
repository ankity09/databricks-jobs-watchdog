import { Button, Skeleton, Tooltip, TooltipContent, TooltipTrigger, useAnalyticsQuery, useSidebar } from "@databricks/appkit-ui/react";
import { ArrowUpRight, Hourglass, Play, RotateCw } from "lucide-react";
import { type JSX, useState } from "react";
import { useNow } from "../hooks/useNow";
import { useRefreshKey } from "../hooks/useRefreshKey";
import { type ScanResultTone, type ScanState, scanResultLabel, scanResultTone, useScanNow } from "../hooks/useScanNow";
import { useQueryRows, useWatchdogLocation } from "../hooks/useWatchdogRows";
import { describeProblem } from "../lib/queryProblem";
import { FreshnessRow } from "../lib/rows";
import { formatAgo, formatUtc, parseTime } from "../lib/time";
import { cn } from "../lib/utils";

const TWO_HOURS = 2 * 60 * 60 * 1000;

/** The newest last_observed_at over every scan source, or null when there is none. */
function newestScan(rows: readonly FreshnessRow[]): string | null {
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const row of rows) {
    const ms = row.last_observed_at === null ? null : parseTime(row.last_observed_at);
    if (ms !== null && ms > newestMs) {
      newest = row.last_observed_at;
      newestMs = ms;
    }
  }
  return newest;
}

/** The line under Scan now, and the Scan now button's name when the nav is collapsed. */
function stateLine(state: ScanState): string | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "checking":
      return "Starting.";
    case "running":
      return state.alreadyRunning ? "A scan is already running." : "Scan running.";
    case "done":
      return `Done: ${scanResultLabel(state.result)}.`;
    case "error":
      return state.message;
  }
}

const LINE_TONE: Record<ScanResultTone, string> = { muted: "text-muted-foreground", warning: "text-warning", failed: "text-destructive" };

/** The color of the line under Scan now: an error, and a result that is not a success, in their status tones. */
function stateTone(state: ScanState): ScanResultTone {
  if (state.kind === "error") return "failed";
  return state.kind === "done" ? scanResultTone(state.result) : "muted";
}

/** What a screen reader hears when Scan now changes. */
function stateAnnouncement(state: ScanState): string | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "checking":
      return "Starting a scan.";
    case "running":
      return state.alreadyRunning ? "A scan is already running. Scan now did not start another." : "Scan started.";
    case "done":
      return `Scan done: ${scanResultLabel(state.result)}.`;
    case "error":
      return `Scan now failed. ${state.message}`;
  }
}

/**
 * The text of the live region. It changes only for real news: a newer scan
 * than the one shown before (not the first one, and not the minutes going by),
 * or a change of Scan now's state.
 */
function useAnnouncement(newest: string | null, scanText: string | null): string {
  const [last, setLast] = useState({ newest, scanText, text: "" });
  if (last.newest !== newest || last.scanText !== scanText) {
    let text = last.text;
    if (scanText !== last.scanText) {
      if (scanText !== null) text = scanText;
    } else if (last.newest !== null && newest !== null) {
      text = `New scan results from ${formatUtc(newest)}.`;
    }
    // React's pattern for adjusting state while rendering: the guard stops it after one update.
    setLast({ newest, scanText, text });
  }
  return last.text;
}

function LiveDot({ fresh }: { fresh: boolean }) {
  return (
    <span data-slot="live-dot" data-fresh={fresh} className="relative flex size-2 shrink-0" aria-hidden="true">
      {fresh ? <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-50 motion-reduce:animate-none" /> : null}
      <span className={cn("relative inline-flex size-2 rounded-full", fresh ? "bg-success" : "bg-warning")} />
    </span>
  );
}

function RunLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-sm font-medium text-foreground underline decoration-border underline-offset-2 outline-none hover:text-primary hover:decoration-primary focus-visible:ring-2 focus-visible:ring-ring"
    >
      View run
      <ArrowUpRight className="size-3" aria-hidden="true" />
      <span className="sr-only">, opens in a new tab</span>
    </a>
  );
}

/**
 * The bottom of the nav: when the newest scan ran, with a live dot (green when
 * it is under 2 hours old), and Scan now. Scan now starts watchdog_scan, or
 * shows the run that is already going; when the run ends, every query refreshes.
 * Collapsed, it is the dot and a play button, each with a tooltip.
 */
export function ScanStatus(): JSX.Element {
  const { state: sidebar } = useSidebar();
  const collapsed = sidebar === "collapsed";
  const { bump } = useRefreshKey();
  const now = useNow();
  const where = useWatchdogLocation();
  const query = useAnalyticsQuery("scan_freshness", where.params, { autoStart: where.ready });
  const freshness = useQueryRows(query, FreshnessRow, where, "scan_freshness");
  const scan = useScanNow(bump);

  const loading = freshness.rows === null && freshness.problem === null;
  const failed = freshness.rows === null && freshness.problem !== null;
  const newest = freshness.rows === null ? null : newestScan(freshness.rows);
  const fresh = newest !== null && now.getTime() - (parseTime(newest) ?? 0) < TWO_HOURS;
  const busy = scan.state.kind === "checking" || scan.state.kind === "running";
  const line = stateLine(scan.state);
  const runUrl = scan.state.kind === "running" || scan.state.kind === "done" ? scan.state.url : null;
  const announcement = useAnnouncement(newest, stateAnnouncement(scan.state));

  let label: string;
  let detail: string;
  if (loading) {
    label = "Checking the last scan";
    detail = label;
  } else if (failed && freshness.problem) {
    label = "Last scan unknown";
    detail = describeProblem(freshness.problem, where.location).detail;
  } else if (newest === null) {
    label = "No scans yet";
    detail = "No scan results yet. Click Scan now, or wait for the next scheduled scan.";
  } else {
    label = `Last scan ${formatAgo(newest, now)}`;
    detail = `Last scan ${formatUtc(newest)}, ${formatAgo(newest, now)}`;
    if (freshness.problem) detail += ". Could not refresh.";
  }

  const startScan = () => {
    if (!busy) void scan.start();
  };
  const buttonText = scan.state.kind === "checking" ? "Starting" : scan.state.kind === "running" ? "Running" : "Scan now";
  const ButtonIcon = busy ? Hourglass : Play;

  const live = (
    <p role="status" className="sr-only">
      {announcement}
    </p>
  );

  if (collapsed) {
    const scanName = line ? `Scan now. ${line}` : "Scan now";
    return (
      <>
        <div className="flex flex-col items-center gap-1">
          {failed ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Retry loading the last scan" className="text-warning" onClick={bump}>
                  <RotateCw aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Last scan unknown. Retry.</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Focusable, so a keyboard reaches the tooltip too; still an image named by the last scan. */}
                <span
                  role="img"
                  aria-label={detail}
                  tabIndex={0}
                  className="flex size-8 items-center justify-center rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {loading ? <Skeleton className="motion-reduce:animate-none size-2 rounded-full" /> : <LiveDot fresh={fresh} />}
                </span>
              </TooltipTrigger>
              <TooltipContent side="right">{detail}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={scanName} aria-disabled={busy} onClick={startScan} className={cn(busy && "cursor-default opacity-70")}>
                <ButtonIcon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-64">
              {scanName}
            </TooltipContent>
          </Tooltip>
        </div>
        {live}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-1 px-2">
        <div className="flex min-h-8 items-center gap-2">
          {loading ? (
            <Skeleton className="motion-reduce:animate-none h-3.5 flex-1" />
          ) : (
            <>
              <LiveDot fresh={fresh} />
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={detail}>
                {label}
              </span>
            </>
          )}
          {failed ? (
            <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-1.5 text-xs" onClick={bump}>
              <RotateCw className="size-3" aria-hidden="true" />
              Retry
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            aria-disabled={busy}
            onClick={startScan}
            className={cn("h-7 shrink-0 gap-1.5 bg-background px-2.5 text-xs", busy && "cursor-default text-muted-foreground hover:bg-background")}
          >
            <ButtonIcon className="size-3.5" aria-hidden="true" />
            {buttonText}
          </Button>
        </div>
        {line && scan.state.kind !== "checking" ? (
          <p data-tone={stateTone(scan.state)} className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 pl-4 text-[11px] leading-4", LINE_TONE[stateTone(scan.state)])}>
            <span className="min-w-0">{line}</span>
            {runUrl ? <RunLink url={runUrl} /> : null}
          </p>
        ) : null}
      </div>
      {live}
    </>
  );
}
