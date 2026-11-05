import { sql } from "@databricks/appkit-ui/js";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useAnalyticsQuery,
} from "@databricks/appkit-ui/react";
import { Lock, Plus, RotateCw, Search, X } from "lucide-react";
import { type MouseEvent, useId, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { JobEntry, JobListDocument } from "../../../../shared/joblist/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useLastGood } from "../../hooks/useLastGood";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { RegionJobRow, draftFromRegionJob, isMonitored, queryFailure, triggerLabel } from "../../lib/picker";
import { cn } from "../../lib/utils";

const RegionJobRows = z.array(RegionJobRow);
const SEARCH_DELAY_MS = 300;
const LIMIT = 100;
const NO_ACCESS = "You don't have access to system.lakeflow.jobs. Ask an admin for SELECT on it. You can still add jobs by hand.";

export interface AddFromWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The saved job list, to mark jobs that are monitored already and to keep new names unique. */
  document: JobListDocument;
  /** Called with a new job entry for the chosen job. The dialog closes. */
  onPick: (draft: JobEntry) => void;
}

/** "Add from workspace": search the region's jobs (region_jobs.obo.sql, as the signed-in person) and pick one. */
export function AddFromWorkspaceDialog({ open, onOpenChange, document, onPick }: AddFromWorkspaceDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85svh] flex-col gap-0 p-0 sm:max-w-6xl">
        <DialogHeader className="border-b border-border px-6 pt-5 pb-4 text-left">
          <DialogTitle>Add from workspace</DialogTitle>
          <DialogDescription>
            Search the jobs in this region and pick one. The job form opens with its name, job ID and schedule type filled in.
          </DialogDescription>
        </DialogHeader>
        {/* Inside the content, so each opening starts with an empty search. */}
        <PickerBody
          document={document}
          onPick={(draft) => {
            onPick(draft);
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

interface PickerBodyProps {
  document: JobListDocument;
  onPick: (draft: JobEntry) => void;
}

function PickerBody({ document, onPick }: PickerBodyProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const term = useDebouncedValue(search.trim(), SEARCH_DELAY_MS);
  const { refresh, bump } = useRefreshKey();
  const ready = term !== "";
  const parameters = useMemo(() => ({ search: sql.string(term), refresh: sql.int(refresh) }), [term, refresh]);
  const query = useAnalyticsQuery("region_jobs", parameters, { autoStart: ready });

  // null until the current query answers (AppKit's first render for new parameters is idle, not loading).
  const parsed = useMemo(() => (query.data === null ? null : RegionJobRows.safeParse(query.data)), [query.data]);
  const answer = useMemo(() => (parsed?.success ? { term, rows: parsed.data } : null), [parsed, term]);
  // While a newer query loads, keep the last answer on screen.
  const shown = useLastGood(answer);

  const failure = ready && query.error !== null ? queryFailure(query.error, query.errorCode) : null;
  const badShape = ready && parsed?.success === false;
  const current = shown !== null && shown.term === term;
  const searching = ready && failure === null && !badShape && (answer === null || !current);

  let count: string | null = null;
  if (ready && current && failure === null && !badShape && shown.rows.length > 0) {
    count = shown.rows.length >= LIMIT ? `The first ${LIMIT} jobs. Type more of the name to narrow the list.` : shown.rows.length === 1 ? "1 job" : `${shown.rows.length} jobs`;
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <label htmlFor={inputId} className="sr-only">
            Search jobs by name
          </label>
          <Input
            ref={inputRef}
            id={inputId}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Part of a job name, such as orders_ingest"
            // Chrome draws its own clear button in blue, not the app's accent: the button below takes its place.
            className="pr-9 pl-8 font-mono text-[13px] [&::-webkit-search-cancel-button]:hidden"
            autoComplete="off"
            spellCheck={false}
          />
          {search !== "" ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-1/2 right-1 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear the search"
              onClick={() => {
                setSearch("");
                inputRef.current?.focus();
              }}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        <div className="min-h-5 text-xs text-muted-foreground" role="status" aria-live="polite">
          {searching ? <Skeleton className="h-3.5 w-20" /> : count}
        </div>
      </div>

      <div className="min-h-64 flex-1 overflow-auto px-6 py-4">
        {!ready ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Type part of a job name to search every workspace in this region.</p>
        ) : failure === "no_access" || failure === "rejected" ? (
          <Alert>
            <Lock aria-hidden="true" />
            <AlertTitle>No access to the jobs in this region</AlertTitle>
            <AlertDescription>{NO_ACCESS}</AlertDescription>
          </Alert>
        ) : failure === "other" || badShape ? (
          <Alert variant="destructive">
            <AlertTitle>Could not search the jobs.</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              <span>{badShape ? "The search results had an unexpected shape." : query.error}</span>
              <Button variant="outline" size="sm" className="h-7 gap-1.5" onClick={() => bump()}>
                <RotateCw className="size-3.5" aria-hidden="true" />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : shown === null ? (
          <ResultsSkeleton />
        ) : current && shown.rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No job in this region has {term} in its name.</p>
        ) : (
          <Results rows={shown.rows} document={document} stale={!current} onPick={onPick} />
        )}
      </div>
    </>
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-3 pt-2" aria-hidden="true">
      {["a", "b", "c", "d", "e"].map((key) => (
        <div key={key} className="flex items-center gap-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

interface ResultsProps {
  rows: RegionJobRow[];
  document: JobListDocument;
  /** True while a newer search loads: the rows belong to the previous one. */
  stale: boolean;
  onPick: (draft: JobEntry) => void;
}

function pausedLabel(paused: boolean | null): string {
  if (paused === null) return "";
  return paused ? "Yes" : "No";
}

function Results({ rows, document, stale, onPick }: ResultsProps) {
  const monitored = useMemo(() => rows.map((row) => isMonitored(row, document)), [rows, document]);
  const pick = (row: RegionJobRow) => onPick(draftFromRegionJob(row, document));

  return (
    <Table aria-busy={stale} className={cn("text-[13px] transition-opacity", stale && "opacity-50")}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-40">Workspace</TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="w-40">Job ID</TableHead>
          <TableHead className="w-28">Trigger</TableHead>
          <TableHead className="w-16">Paused</TableHead>
          <TableHead className="w-48">Creator</TableHead>
          <TableHead className="w-20">
            <span className="sr-only">Add</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => {
          const workspace = row.workspace_name ?? row.workspace_id ?? "Unknown workspace";
          const name = row.name ?? `Job ${row.job_id ?? ""}`;
          const monitoredAs = monitored[i];
          return (
            <TableRow key={`${row.workspace_id ?? ""}:${row.job_id ?? ""}`} className="cursor-pointer" onClick={() => pick(row)}>
              <TableCell className="max-w-40 truncate" title={row.workspace_id ?? undefined}>
                {workspace}
              </TableCell>
              {/* Table cells do not wrap by default; a job name is the one value worth two lines. */}
              <TableCell className="whitespace-normal">
                <div className="flex min-w-0 flex-col items-start gap-1">
                  <span className="font-mono text-[12px] text-foreground [overflow-wrap:anywhere]">{name}</span>
                  {monitoredAs ? (
                    <Badge variant="outline" className="h-5 max-w-full border-border px-1.5 text-[11px] font-normal text-muted-foreground">
                      <span className="truncate">Monitored as {monitoredAs}</span>
                    </Badge>
                  ) : null}
                </div>
              </TableCell>
              <TableCell className="font-mono text-[12px] text-muted-foreground">{row.job_id}</TableCell>
              <TableCell>{triggerLabel(row.trigger_type)}</TableCell>
              <TableCell>{pausedLabel(row.paused)}</TableCell>
              <TableCell className="max-w-48 truncate text-muted-foreground" title={row.creator_user_name ?? undefined}>
                {row.creator_user_name}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 px-2"
                  aria-label={`Add ${name} from ${workspace}`}
                  onClick={(event: MouseEvent) => {
                    event.stopPropagation();
                    pick(row);
                  }}
                >
                  <Plus className="size-3.5" aria-hidden="true" />
                  Add
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
