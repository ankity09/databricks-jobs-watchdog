import { Alert, AlertDescription, Button, Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle, Skeleton } from "@databricks/appkit-ui/react";
import { Activity, RotateCw, TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useNoScansAdvice } from "../../hooks/useNoScansAdvice";
import { useNow } from "../../hooks/useNow";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { useWatchdogLocation } from "../../hooks/useWatchdogRows";
import { PageHeader } from "../../layout/PageHeader";
import type { JobStatusRow } from "../../lib/rows";
import { formatUtc } from "../../lib/time";
import { HistoryStrip } from "./HistoryStrip";
import { JobDetailSheet } from "./JobDetailSheet";
import { JobFilters } from "./JobFilters";
import { JobStatusTable } from "./JobStatusTable";
import { countByStatus, filterJobs, filterOptions, jobKey, type JobFilterValue, type JobRef, newestScan, NO_FILTERS, sameJob, sortJobs } from "./jobs";
import { ProblemAlert } from "./ProblemAlert";
import { useJobStatus } from "./queries";
import { SummaryCounts } from "./SummaryCounts";

const SKELETON_ROWS = ["a", "b", "c", "d", "e", "f", "g", "h"];

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {["failed", "warning", "unknown", "healthy"].map((id) => (
          <Skeleton key={id} className="h-[62px] rounded-lg motion-reduce:animate-none" />
        ))}
      </div>
      <div className="flex gap-2">
        {["environment", "owner", "severity", "workspace", "check", "last-run"].map((id) => (
          <Skeleton key={id} className="h-8 w-36 motion-reduce:animate-none" />
        ))}
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <Skeleton className="motion-reduce:animate-none h-9 rounded-none" />
        {SKELETON_ROWS.map((id) => (
          <div key={id} className="flex items-center gap-6 border-t border-border px-4 py-3">
            <Skeleton className="motion-reduce:animate-none h-5 w-16" />
            <Skeleton className="motion-reduce:animate-none h-4 w-44" />
            <Skeleton className="motion-reduce:animate-none h-4 w-28" />
            <Skeleton className="motion-reduce:animate-none h-4 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The empty state. It reads the job list, so it mounts only when there are no scan results. */
function NoScans() {
  const advice = useNoScansAdvice();
  if (advice === "loading") return <PageSkeleton />;
  return (
    <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Activity aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No scans yet</EmptyTitle>
        <EmptyDescription>
          {advice === "add-jobs"
            ? "The job list is empty, so a scan has nothing to check. Add or import jobs first, then scan."
            : "Click Scan now, or wait for the next scheduled scan."}
        </EmptyDescription>
      </EmptyHeader>
      {advice === "add-jobs" ? (
        <EmptyContent>
          <Button asChild size="sm">
            <Link to="/jobs">Go to the Job list</Link>
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}

/** Stands in for the time when no filter reads it. */
const NO_CLOCK = new Date(0);

/**
 * Monitoring: how many jobs are failed, warning, unknown and healthy, one row
 * per job and workspace from the newest scans (filterable), the detail panel
 * per job, and each job's history over the last days.
 */
export function MonitoringPage() {
  const { bump } = useRefreshKey();
  const now = useNow();
  const where = useWatchdogLocation();
  const status = useJobStatus(where);
  const [filters, setFilters] = useState<JobFilterValue>(NO_FILTERS);
  const [panelJob, setPanelJob] = useState<JobRef | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const focusBack = useRef<HTMLElement | null>(null);

  const sorted = useMemo(() => (status.rows === null ? [] : sortJobs(status.rows)), [status.rows]);
  // The counts follow every filter except the status, so each count says how many clicking it would show.
  // Only the last-run filter reads the time. Without it the clock is a fixed date, so the minute tick leaves
  // `scoped` and `visible` alone and the history strip does not rebuild its cells.
  const filterNow = filters.lastRun === null ? NO_CLOCK : now;
  const scoped = useMemo(() => filterJobs(sorted, { ...filters, status: null }, filterNow), [sorted, filters, filterNow]);
  const visible = useMemo(() => (filters.status === null ? scoped : scoped.filter((row) => row.status === filters.status)), [scoped, filters.status]);
  const counts = useMemo(() => countByStatus(scoped), [scoped]);
  const options = useMemo(() => filterOptions(sorted), [sorted]);
  const newest = useMemo(() => newestScan(sorted), [sorted]);
  // The open job's status from the newest rows, for the panel until its checks load.
  const panelStatus = useMemo(() => (panelJob === null ? null : (sorted.find((row) => sameJob(row, panelJob))?.status ?? null)), [sorted, panelJob]);

  const openPanel = useCallback((row: JobStatusRow, back: HTMLElement | null) => {
    focusBack.current = back;
    setPanelJob({ job_name: row.job_name, workspace_id: row.workspace_id, job_id: row.job_id });
    setPanelOpen(true);
  }, []);
  const getFocusBack = useCallback(() => focusBack.current, []);

  const hasRows = status.rows !== null && status.rows.length > 0;
  const refreshing = status.loading && status.rows !== null;

  let body;
  if (status.rows === null && status.problem) {
    body = <ProblemAlert problem={status.problem} location={where.location} onRetry={bump} />;
  } else if (status.rows === null) {
    body = <PageSkeleton />;
  } else if (status.rows.length === 0) {
    body = <NoScans />;
  } else {
    body = (
      <>
        {status.problem ? (
          <ProblemAlert
            problem={status.problem}
            location={where.location}
            title="Could not refresh"
            detail={newest ? `Showing the results of the scan at ${formatUtc(newest)}.` : "Showing the last results."}
            onRetry={bump}
          />
        ) : null}
        {status.bad > 0 ? (
          <Alert className="flex items-center gap-2 border-warning/30 bg-warning/[0.05] py-2.5">
            <TriangleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
            <AlertDescription className="text-[13px] text-foreground">
              {status.bad === 1 ? "1 row had an unexpected shape and is not shown." : `${status.bad} rows had an unexpected shape and are not shown.`}
            </AlertDescription>
          </Alert>
        ) : null}
        <SummaryCounts counts={counts} selected={filters.status} onSelect={(next) => setFilters((current) => ({ ...current, status: next }))} />
        <div className="flex flex-col gap-3">
          <JobFilters options={options} value={filters} onChange={setFilters} shown={visible.length} total={sorted.length} />
          {visible.length > 0 ? (
            <JobStatusTable rows={visible} selectedKey={panelOpen && panelJob ? jobKey(panelJob) : null} onOpen={openPanel} now={now} />
          ) : (
            <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">No jobs match these filters.</p>
          )}
        </div>
        <HistoryStrip jobs={visible} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Monitoring"
        description="The status of every monitored job, from the newest scans."
        actions={
          <>
            {hasRows && newest ? (
              <span className="text-xs text-muted-foreground">
                {refreshing ? (
                  "Updating"
                ) : (
                  <>
                    Newest scan <span className="font-mono text-foreground tabular-nums">{formatUtc(newest)}</span>
                  </>
                )}
              </span>
            ) : null}
            <Button variant="outline" size="sm" onClick={bump}>
              <RotateCw aria-hidden="true" />
              Refresh
            </Button>
          </>
        }
      />
      {body}
      <JobDetailSheet
        job={panelJob?.job_name ?? null}
        workspaceId={panelJob?.workspace_id ?? null}
        jobId={panelJob?.job_id ?? null}
        open={panelOpen}
        onOpenChange={setPanelOpen}
        focusBack={getFocusBack}
        rowStatus={panelStatus}
      />
    </>
  );
}
