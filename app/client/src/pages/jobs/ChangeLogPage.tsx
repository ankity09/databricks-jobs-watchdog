import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@databricks/appkit-ui/react";
import { CircleAlert, History, RotateCw } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { ChangeKind, VersionSummary } from "../../../../shared/joblist/types";
import { type ApiError, toApiError } from "../../lib/api";
import { listVersions } from "../../lib/joblist-api";
import { formatUtc } from "../../lib/time";
import { cn } from "../../lib/utils";
import { PageHeader } from "../../layout/PageHeader";
import { ConfigBanner } from "./ConfigBanner";
import { VersionDiffSheet } from "./VersionDiffSheet";

/** Versions load 50 at a time: the newest first, then older ones on request. */
const PAGE = 50;

const KIND_STYLE: Record<ChangeKind, string> = {
  import: "border-foreground/20 bg-background text-foreground",
  create: "border-success/30 bg-success/10 text-success",
  update: "border-border bg-secondary text-secondary-foreground",
  delete: "border-destructive/30 bg-destructive/10 text-destructive",
  restore: "border-warning/30 bg-warning/10 text-warning",
};

interface VersionsState {
  /** Newest first: the newest page, and the older pages loaded since. */
  versions: VersionSummary[] | null;
  /** The newest page did not load. */
  error: ApiError | null;
  /** The newest page is loading: at first, after Retry and after Refresh. */
  loading: boolean;
  /** Older versions can exist past the oldest one shown. */
  more: boolean;
  older: { loading: boolean; error: ApiError | null };
}

const OLDER_IDLE = { loading: false, error: null };

/** Versions count up from 1, so a full page whose oldest version is above 1 has older ones behind it. */
function moreAfter(page: VersionSummary[]): boolean {
  const oldest = page[page.length - 1];
  return page.length === PAGE && oldest !== undefined && oldest.version > 1;
}

/** The newest page joined to the versions shown when the two meet, so a refresh keeps the older pages; else the newest page alone. */
function withNewest(current: VersionsState, page: VersionSummary[]): VersionsState {
  const shown = current.versions ?? [];
  const newestShown = shown[0]?.version;
  const oldestNew = page[page.length - 1]?.version;
  if (newestShown === undefined || oldestNew === undefined || !moreAfter(page) || oldestNew > newestShown) {
    return { versions: page, error: null, loading: false, more: moreAfter(page), older: OLDER_IDLE };
  }
  const byVersion = new Map(shown.map((v) => [v.version, v]));
  for (const v of page) byVersion.set(v.version, v);
  return { ...current, versions: [...byVersion.values()].sort((a, b) => b.version - a.version), error: null, loading: false };
}

/** The saved versions, newest first, 50 at a time. A failed load keeps the versions already shown. */
function useVersions() {
  const [state, setState] = useState<VersionsState>({ versions: null, error: null, loading: true, more: false, older: OLDER_IDLE });
  const reload = useCallback(async () => {
    setState((current) => ({ ...current, loading: true }));
    try {
      const page = await listVersions(PAGE);
      setState((current) => withNewest(current, page));
    } catch (error) {
      setState((current) => ({ ...current, error: toApiError(error), loading: false }));
    }
  }, []);
  const loadOlder = useCallback(async (before: number) => {
    setState((current) => ({ ...current, older: { loading: true, error: null } }));
    try {
      const page = await listVersions(PAGE, before);
      setState((current) => {
        const shown = current.versions ?? [];
        // A refresh can replace the versions meanwhile: add the page only where it continues them.
        if (shown[shown.length - 1]?.version !== before) return { ...current, older: OLDER_IDLE };
        return { ...current, versions: [...shown, ...page], more: moreAfter(page), older: OLDER_IDLE };
      });
    } catch (error) {
      setState((current) => ({ ...current, older: { loading: false, error: toApiError(error) } }));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...state, reload, loadOlder };
}

/** Every saved version of the job list: who saved it, when, and what changed. */
export function ChangeLogPage() {
  const { versions, error, loading, more, older, reload, loadOlder } = useVersions();
  const [open, setOpen] = useState<VersionSummary | null>(null);
  // Focus goes back to the version's summary when its changes close, else to Refresh (a refresh replaced the rows).
  const opener = useRef<HTMLElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  // A Retry press moves focus to the versions while they load (the Retry goes), and back to Retry when the load
  // fails again; after a load that works, focus stays on the versions.
  const versionsArea = useRef<HTMLDivElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const retried = useRef(false);
  const retry = () => {
    retried.current = true;
    versionsArea.current?.focus();
    void reload();
  };
  useEffect(() => {
    if (!retried.current || loading) return;
    retried.current = false;
    if (error) retryButton.current?.focus();
  }, [loading, error]);
  // After older versions load, focus moves to the first of them (its index in the table).
  const table = useRef<HTMLDivElement>(null);
  const focusAt = useRef<number | null>(null);
  useEffect(() => {
    const index = focusAt.current;
    if (index === null || versions === null || versions.length <= index) return;
    focusAt.current = null;
    table.current?.querySelectorAll<HTMLButtonElement>("button[data-summary]")[index]?.focus();
  }, [versions]);

  let body: ReactNode;
  if (versions === null) {
    body = error && !loading ? <LoadError message={error.message} retryRef={retryButton} onRetry={retry} /> : <TableSkeleton />;
  } else if (versions.length === 0) {
    body = (
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <History aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Nothing is saved yet</EmptyTitle>
          <EmptyDescription>No versions yet. Import your job list or add a job on the Job list page.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline" size="sm">
            <Link to="/jobs">Go to the job list</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    body = (
      <div className="flex flex-col gap-2">
        {error && !loading ? (
          <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-destructive">
            <CircleAlert className="size-3.5" aria-hidden="true" />
            The newest versions did not load. {error.message}
            <Button ref={retryButton} variant="link" size="sm" className="h-auto p-0 text-xs" onClick={retry}>
              Retry
            </Button>
          </p>
        ) : null}
        <div ref={table} className="overflow-hidden rounded-md border border-border">
          <Table className="text-[13px]">
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-9 w-20 px-3 text-xs font-medium text-muted-foreground">Version</TableHead>
                <TableHead className="h-9 w-44 px-3 text-xs font-medium text-muted-foreground">When</TableHead>
                <TableHead className="h-9 w-56 px-3 text-xs font-medium text-muted-foreground">Who</TableHead>
                <TableHead className="h-9 px-3 text-xs font-medium text-muted-foreground">Summary</TableHead>
                <TableHead className="h-9 w-24 px-3 text-xs font-medium text-muted-foreground">Kind</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((version) => (
                <TableRow
                  key={version.version}
                  className="cursor-pointer"
                  onClick={(event) => {
                    opener.current = event.currentTarget.querySelector<HTMLElement>("button[data-summary]");
                    setOpen(version);
                  }}
                >
                  <TableCell className="px-3 py-2 font-mono">{version.version}</TableCell>
                  <TableCell className="px-3 py-2 font-mono text-xs text-muted-foreground">{formatUtc(version.savedAt)}</TableCell>
                  <TableCell className="max-w-56 truncate px-3 py-2 font-mono text-xs" title={version.savedBy}>
                    {version.savedBy}
                  </TableCell>
                  <TableCell className="max-w-0 px-3 py-2">
                    <button
                      type="button"
                      data-summary
                      className="block max-w-full truncate rounded-xs text-left text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      title={version.summary}
                      onClick={(event) => {
                        event.stopPropagation();
                        opener.current = event.currentTarget;
                        setOpen(version);
                      }}
                    >
                      {version.summary}
                    </button>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <Badge
                      variant="outline"
                      className={cn("rounded-sm px-1.5 py-0 font-mono text-[11px] font-normal", KIND_STYLE[version.changeKind])}
                    >
                      {version.changeKind}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {more ? (
            <Button
              variant="outline"
              size="sm"
              disabled={older.loading}
              onClick={() => {
                const oldest = versions[versions.length - 1];
                if (!oldest) return;
                focusAt.current = versions.length;
                void loadOlder(oldest.version);
              }}
            >
              {older.loading ? "Loading older versions..." : "Load older versions"}
            </Button>
          ) : null}
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {more ? `The newest ${versions.length} versions.` : versions.length > PAGE ? `All ${versions.length} versions.` : ""}
          </p>
          {older.error ? (
            <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
              <CircleAlert className="size-3.5" aria-hidden="true" />
              Older versions did not load. {older.error.message}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Change log"
        description="Every saved version of the job list: who saved it, when, and what changed. Click a version to see its changes."
        actions={
          versions !== null ? (
            // Not disabled while it loads: a disabled button would drop the focus of the person who pressed it.
            <Button
              ref={refreshButton}
              variant="outline"
              size="sm"
              className="gap-1.5 aria-disabled:cursor-default aria-disabled:opacity-60"
              aria-disabled={loading}
              aria-busy={loading}
              onClick={() => {
                if (!loading) void reload();
              }}
            >
              <RotateCw aria-hidden="true" />
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
          ) : null
        }
      />
      <ConfigBanner savedVersion={versions === null ? undefined : (versions[0]?.version ?? null)} />
      {/* tabIndex -1: focus waits here while the versions load. */}
      <div
        ref={versionsArea}
        role="region"
        aria-label="Versions"
        aria-busy={loading}
        tabIndex={-1}
        className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {body}
      </div>
      <VersionDiffSheet
        version={open}
        onOpenChange={(next) => {
          if (!next) setOpen(null);
        }}
        returnFocus={[opener, refreshButton]}
      />
    </>
  );
}

function LoadError({ message, retryRef, onRetry }: { message: string; retryRef: RefObject<HTMLButtonElement | null>; onRetry: () => void }) {
  return (
    <Alert variant="destructive" className="border-destructive/40">
      <CircleAlert aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p>The change log did not load. {message}</p>
        <Button ref={retryRef} variant="outline" size="sm" className="gap-1.5" onClick={onRetry}>
          <RotateCw aria-hidden="true" />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-md border border-border" aria-label="Loading the change log">
      <div className="h-9 border-b border-border bg-muted/50" />
      {["a", "b", "c", "d"].map((key) => (
        <div key={key} className="flex h-10 items-center gap-6 border-b border-border px-3 last:border-0">
          <Skeleton className="h-3.5 w-8" />
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3.5 w-80" />
        </div>
      ))}
    </div>
  );
}
