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
import { CircleAlert, History, RotateCw, SearchX } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { VersionFacets, VersionList, VersionSummary } from "../../../../shared/joblist/types";
import { type ApiError, toApiError } from "../../lib/api";
import { type ChangeFilters, hasFilters, parseFilters, writeFilters } from "../../lib/changeFilters";
import { getVersionFacets, listVersions } from "../../lib/joblist-api";
import { formatUtc } from "../../lib/time";
import { cn } from "../../lib/utils";
import { PageHeader } from "../../layout/PageHeader";
import { KIND_STYLE } from "./changeKinds";
import { ChangeLogFilters, ClearFiltersButton, type FacetsState } from "./ChangeLogFilters";
import { ConfigBanner } from "./ConfigBanner";
import { VersionDiffSheet } from "./VersionDiffSheet";

/** Versions load 50 at a time: the newest first, then older ones on request. */
const PAGE = 50;

interface VersionsState {
  /** The filters (as their URL query) these versions answer; another query starts over. */
  key: string;
  /** Newest first: the newest page, and the older pages loaded since. */
  versions: VersionSummary[] | null;
  /** How many versions match the filters, whatever is shown. */
  total: number | null;
  /** The newest page did not load. */
  error: ApiError | null;
  /** The newest page is loading: at first, after Retry and after Refresh. */
  loading: boolean;
  /** Older matching versions can exist past the oldest one shown. */
  more: boolean;
  older: { loading: boolean; error: ApiError | null };
}

const OLDER_IDLE = { loading: false, error: null };

function initial(key: string): VersionsState {
  return { key, versions: null, total: null, error: null, loading: true, more: false, older: OLDER_IDLE };
}

/** A full page with matches left over has older ones behind it. */
function moreAfter(page: VersionSummary[], total: number, shown: number): boolean {
  return page.length === PAGE && shown < total;
}

/** The newest page joined to the versions shown when the two meet, so a refresh keeps the older pages; else the newest page alone. */
function withNewest(current: VersionsState, page: VersionList): VersionsState {
  const shown = current.versions ?? [];
  const newestShown = shown[0]?.version;
  const oldestNew = page.versions[page.versions.length - 1]?.version;
  const base = { ...current, total: page.total, error: null, loading: false };
  if (newestShown === undefined || oldestNew === undefined || page.versions.length < PAGE || oldestNew > newestShown) {
    return { ...base, versions: page.versions, more: moreAfter(page.versions, page.total, page.versions.length), older: OLDER_IDLE };
  }
  const byVersion = new Map(shown.map((v) => [v.version, v]));
  for (const v of page.versions) byVersion.set(v.version, v);
  return { ...base, versions: [...byVersion.values()].sort((a, b) => b.version - a.version) };
}

/** The saved versions that match the filters, newest first, 50 at a time. A failed load keeps the versions already shown. */
function useVersions(key: string) {
  const [raw, setRaw] = useState<VersionsState>(() => initial(key));
  // Another set of filters starts over at once, with no rows from the old ones.
  const state = raw.key === key ? raw : initial(key);
  // The newest saved version of the job list (the banner compares the scan with it), apart from the filtered state:
  // a filter change must not take it away, or the banner would leave and come back with every press.
  const [latest, setLatest] = useState<number | null | undefined>(undefined);
  const live = useRef(key);
  useEffect(() => {
    live.current = key;
  }, [key]);
  const update = useCallback(
    (change: (current: VersionsState) => VersionsState) => {
      setRaw((current) => (live.current === key ? change(current.key === key ? current : initial(key)) : current));
    },
    [key],
  );
  const reload = useCallback(async () => {
    const filters = parseFilters(new URLSearchParams(key));
    update((current) => ({ ...current, loading: true }));
    try {
      // With filters, the newest page is not the newest version: the banner needs that one too. If that lookup fails,
      // the banner gets nothing rather than the newest match.
      const [page, newest] = await Promise.all([
        listVersions(PAGE, undefined, filters),
        hasFilters(filters) ? listVersions(1).then((l) => l.versions[0]?.version ?? null, () => undefined) : Promise.resolve(undefined),
      ]);
      if (live.current !== key) return;
      setLatest(hasFilters(filters) ? newest : (page.versions[0]?.version ?? null));
      update((current) => withNewest(current, page));
    } catch (error) {
      update((current) => ({ ...current, error: toApiError(error), loading: false }));
    }
  }, [key, update]);
  const loadOlder = useCallback(
    async (before: number) => {
      const filters = parseFilters(new URLSearchParams(key));
      update((current) => ({ ...current, older: { loading: true, error: null } }));
      try {
        const page = await listVersions(PAGE, before, filters);
        update((current) => {
          const shown = current.versions ?? [];
          // A refresh can replace the versions meanwhile: add the page only where it continues them.
          if (shown[shown.length - 1]?.version !== before) return { ...current, older: OLDER_IDLE };
          return {
            ...current,
            versions: [...shown, ...page.versions],
            total: page.total,
            more: moreAfter(page.versions, page.total, shown.length + page.versions.length),
            older: OLDER_IDLE,
          };
        });
      } catch (error) {
        update((current) => ({ ...current, older: { loading: false, error: toApiError(error) } }));
      }
    },
    [key, update],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...state, latest, reload, loadOlder };
}

/** The people, jobs and kinds to filter by, over every version. */
function useFacets(): FacetsState & { reload: () => void } {
  const [state, setState] = useState<{ facets: VersionFacets | null; failed: boolean }>({ facets: null, failed: false });
  const load = useCallback(() => {
    getVersionFacets().then(
      (facets) => setState({ facets, failed: false }),
      () => setState((current) => ({ ...current, failed: true })),
    );
  }, []);
  const reload = useCallback(() => {
    setState((current) => ({ ...current, failed: false }));
    load();
  }, [load]);
  useEffect(() => {
    load();
  }, [load]);
  return { ...state, retry: reload, reload };
}

/** Every saved version of the job list: who saved it, when, and what changed. */
export function ChangeLogPage() {
  const [params, setParams] = useSearchParams();
  const filters = parseFilters(params);
  const key = writeFilters(filters).toString();
  const filtered = hasFilters(filters);
  const { versions, total, latest, error, loading, more, older, reload, loadOlder } = useVersions(key);
  const facets = useFacets();
  const allVersions = facets.facets === null ? null : facets.facets.kinds.reduce((sum, k) => sum + k.count, 0);
  // Search and the date boxes replace the history entry (each pause or digit would be a step for the back button);
  // a real filter change pushes one, and a change that changes nothing adds none.
  // `newest` holds the params of the last change made, so two changes before the page re-renders both stay
  // (react-router's setSearchParams with a function reads the params of the last render, not of the last call).
  const newest = useRef(params);
  useEffect(() => {
    newest.current = params;
  }, [params]);
  const change = (patch: Partial<ChangeFilters>, replace = false) => {
    if (Object.keys(patch).length === 0) return;
    newest.current = writeFilters({ ...parseFilters(newest.current), ...patch });
    setParams(newest.current, { replace });
  };
  // Clear filters also drops a search that is still waiting to be sent: the filter bar starts its Search box again.
  const [cleared, setCleared] = useState(0);
  const clearFilters = () => {
    setCleared((n) => n + 1);
    newest.current = new URLSearchParams();
    setParams(newest.current);
  };
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
  } else if (versions.length === 0 && filtered) {
    body = (
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No changes match these filters.</EmptyTitle>
          <EmptyDescription>Try fewer filters, or a wider time range.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        </EmptyContent>
      </Empty>
    );
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
            {more
              ? `The newest ${versions.length} ${filtered ? "matching versions" : "versions"}.`
              : versions.length > PAGE
                ? `All ${versions.length} ${filtered ? "matching versions" : "versions"}.`
                : ""}
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
                if (loading) return;
                void reload();
                facets.reload();
              }}
            >
              <RotateCw aria-hidden="true" />
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
          ) : null
        }
      />
      <ConfigBanner savedVersion={latest} />
      <div className="flex flex-col gap-2">
        <ChangeLogFilters filters={filters} facets={facets} onChange={change} resetKey={cleared} />
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1">
          <p className="text-[13px] text-muted-foreground" aria-live="polite">
            {versions === null || total === null ? null : <CountLine total={total} all={allVersions} filtered={filtered} />}
          </p>
          {filtered ? <ClearFiltersButton onClick={clearFilters} /> : null}
        </div>
      </div>
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

/** "312 versions", or "12 of 312 versions match" when filters are on (the 312 is every version, from the facets). */
function CountLine({ total, all, filtered }: { total: number; all: number | null; filtered: boolean }) {
  const n = (value: number) => <span className="font-mono tabular-nums text-foreground">{value}</span>;
  if (!filtered) return <>{n(total)} {total === 1 ? "version" : "versions"}</>;
  if (all === null) return <>{n(total)} {total === 1 ? "version matches" : "versions match"}</>;
  return <>{n(total)} of {n(all)} {all === 1 ? "version matches" : "versions match"}</>;
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
