import { sql } from "@databricks/appkit-ui/js";
import {
  Button,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useAnalyticsQuery,
  useSidebar,
} from "@databricks/appkit-ui/react";
import { RotateCw } from "lucide-react";
import { type JSX, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { useAppConfig } from "../hooks/useAppConfig";
import { useRefreshKey } from "../hooks/useRefreshKey";
import { cn } from "../lib/utils";
import { formatAgo, formatUtc, parseTime } from "../lib/time";

const FreshnessRows = z.array(
  z.object({ source: z.string(), last_observed_at: z.string().nullable(), scan_id: z.string().nullable() }),
);

const TWO_HOURS = 2 * 60 * 60 * 1000;

/** The time, re-read every minute, so "12 min ago" stays true. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** The newest last_observed_at over every scan source, or null when there is none. */
function newestScan(rows: z.infer<typeof FreshnessRows>): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    const time = row.last_observed_at === null ? null : parseTime(row.last_observed_at);
    if (time !== null && (newest === null || time > (parseTime(newest) ?? 0))) newest = row.last_observed_at;
  }
  return newest;
}

function LiveDot({ fresh }: { fresh: boolean }) {
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden="true">
      {fresh ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-50 motion-reduce:animate-none" />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", fresh ? "bg-success" : "bg-warning")} />
    </span>
  );
}

/**
 * When the newest scan ran (scan_freshness.obo.sql, run as the signed-in
 * person). Task 5 replaces this with the full version and a Scan now button.
 */
export function ScanStatus(): JSX.Element {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const { config, loading: configLoading, error: configError } = useAppConfig();
  const { refresh, bump } = useRefreshKey();
  const ready = config !== null && config.catalog !== "";
  const parameters = useMemo(
    () => ({ catalog: sql.string(config?.catalog ?? ""), schema: sql.string(config?.schema ?? ""), refresh: sql.int(refresh) }),
    [config, refresh],
  );
  const query = useAnalyticsQuery("scan_freshness", parameters, { autoStart: ready });
  const now = useNow();

  const rows = FreshnessRows.safeParse(query.data ?? []);
  const loading = configLoading || (ready && query.loading);
  const failed = configError !== null || (config !== null && !ready) || query.error !== null || !rows.success;
  const newest = rows.success ? newestScan(rows.data) : null;

  let label: string;
  let detail: string;
  if (loading) {
    label = "Checking the last scan";
    detail = label;
  } else if (failed) {
    label = "Last scan unknown";
    detail = configError?.message ?? query.error ?? "The app cannot read the scan results.";
  } else if (newest === null) {
    label = "No scans yet";
    detail = "No scan results yet. Run the watchdog_scan job, or wait for its schedule.";
  } else {
    label = `Last scan ${formatAgo(newest, now)}`;
    detail = `Last scan ${formatUtc(newest)}`;
  }
  const fresh = newest !== null && now.getTime() - (parseTime(newest) ?? 0) < TWO_HOURS;

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={detail} className="flex size-8 items-center justify-center self-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {loading ? <Skeleton className="size-2 rounded-full" /> : <LiveDot fresh={fresh} />}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{detail}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="flex min-h-8 items-center gap-2 px-2 text-xs" role="status" aria-live="polite">
      {loading ? (
        <Skeleton className="h-3.5 w-36" />
      ) : (
        <>
          <LiveDot fresh={fresh} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={detail}>
            {label}
          </span>
          {failed ? (
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs" onClick={() => bump()}>
              <RotateCw className="size-3" aria-hidden="true" />
              Retry
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
