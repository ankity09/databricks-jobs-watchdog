import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@databricks/appkit-ui/react";
import { CircleAlert, CircleCheck, Download, ListChecks, Pencil, Plus, RotateCw, ScanSearch, Search, Trash2, Upload, X } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { type Change, dependencyKey, type JobEntry, type JobListDocument, type SaveResult } from "../../../../shared/joblist/types";
import { type ReloadJobList, type SaveOutcome, useJobList, useOpenedVersion } from "../../hooks/useJobList";
import { type LiveStatus, useLiveStatus } from "../../hooks/useLiveStatus";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { changeIssues, linksRemovedWith } from "../../lib/draft";
import { blocksDefault, inheritedSettings, type InheritedSettings, type NumberKey, pyReEscape } from "../../lib/job-form";
import { exportUrl } from "../../lib/joblist-api";
import type { EntryJobIds } from "../../lib/picker";
import type { Status } from "../../lib/status";
import { describeTarget } from "../../lib/targets";
import { formatUtc } from "../../lib/time";
import { cn } from "../../lib/utils";
import { PageHeader } from "../../layout/PageHeader";
import { StatusBadge } from "../monitoring/StatusBadge";
import { AddFromWorkspaceDialog } from "./AddFromWorkspaceDialog";
import { ConfigBanner } from "./ConfigBanner";
import { ImportDialog } from "./ImportDialog";
import { JobEditorSheet } from "./JobEditorSheet";
import { PatternMatches } from "./PatternMatches";
import { QueryProblemLine } from "./QueryProblemLine";
import { ReloadButton } from "./ReloadButton";
import { type ReturnFocus, useReturnFocus } from "./returnFocus";

/** What an extra toolbar action can do on this page. */
export interface JobListActions {
  /**
   * Opens the editor in create mode, filled from a draft (Task 7's "Add from workspace"). Focus goes back to
   * `opener` when the editor closes; by default, to what has focus now.
   */
  openCreate(this: void, draft: JobEntry, opener?: HTMLElement | null): void;
  /** The saved job list. */
  document: JobListDocument;
  /** False until the job list has loaded; until then, document is an empty list. */
  ready: boolean;
}

export interface JobListPageProps {
  /** Extra buttons in the toolbar, before Import YAML. By default Add from workspace, the picker of the region's jobs. */
  extraActions?: ReactNode | ((actions: JobListActions) => ReactNode);
}

/** "Add from workspace": pick one of the region's jobs, and the editor opens with its name, job ID and schedule type. */
function AddFromWorkspace({ openCreate, document, ready }: JobListActions) {
  const [open, setOpen] = useState(false);
  // The picker gives focus back to this button, and so does the editor a pick opens.
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={button} variant="outline" size="sm" onClick={() => setOpen(true)} disabled={!ready}>
        <ScanSearch aria-hidden="true" />
        Add from workspace
      </Button>
      <AddFromWorkspaceDialog
        open={open}
        onOpenChange={setOpen}
        document={document}
        onPick={(draft) => openCreate(draft, button.current)}
        returnFocus={[button]}
      />
    </>
  );
}

function addFromWorkspace(actions: JobListActions): ReactNode {
  return <AddFromWorkspace {...actions} />;
}

/** Under the editor's pattern fields: which of the region's jobs those patterns match, and where the scan finds the job by its ID instead. */
function patternPreview(pattern: string, exclude: string, jobIds: EntryJobIds): ReactNode {
  return <PatternMatches pattern={pattern} exclude={exclude} jobIds={jobIds} />;
}

type Editing = { mode: "create"; draft: JobEntry } | { mode: "edit"; name: string };

interface Problem {
  message: string;
  conflict: boolean;
}

const COLUMNS = ["Job", "Schedule", "Limits", "Severity", "Owner", "Environments", "Enabled", "Live status"] as const;

/** The element that has focus, such as the button just pressed. */
function activeElement(): HTMLElement | null {
  return window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Checked in at least one environment: on, or switched on for some label (the loader's MonitoredJob.active). */
function isActive(job: JobEntry, inherited: InheritedSettings): boolean {
  if ((job.enabled ?? inherited.enabled) === true) return true;
  return Object.values(job.environments ?? {}).some((overrides) => overrides?.enabled === true);
}

/** The jobs the Watchdog monitors: each job's settings and live status, the editor, import and export. */
export function JobListPage({ extraActions = addFromWorkspace }: JobListPageProps = {}) {
  const { state, loading, error, reload, save } = useJobList();
  const live = useLiveStatus();
  const { bump } = useRefreshKey();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [toggling, setToggling] = useState<Record<string, boolean>>({});
  // Where focus goes when the editor, the delete question or the import closes: the control that opened it, else
  // the search field (the control went with its row, or with the empty state), else Add job.
  const opener = useRef<HTMLElement | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const addJob = useRef<HTMLButtonElement>(null);
  const returnFocus: ReturnFocus = [opener, searchField, addJob];
  const openedFrom = (element: HTMLElement | null) => {
    opener.current = element;
  };

  const document = state?.document ?? null;
  const jobs = useMemo(() => document?.jobs ?? [], [document]);
  const inherited = useMemo(() => inheritedSettings(document ?? { jobs: [] }), [document]);
  const query = search.trim().toLowerCase();
  const shown = useMemo(
    () => (query === "" ? jobs : jobs.filter((job) => String(job.job_name).toLowerCase().includes(query))),
    [jobs, query],
  );

  const saved = (result: SaveResult) => {
    setProblem(null);
    setNotice(`Saved version ${result.version}: ${result.summary}.`);
  };
  const apply = async (change: Change, baseVersion: number | null): Promise<SaveOutcome> => {
    const outcome = await save(change, baseVersion);
    if (outcome.ok) saved(outcome.result);
    return outcome;
  };

  // The switch saves the job as this version shows it, so it sends this version.
  const toggle = async (job: JobEntry, next: boolean, baseVersion: number | null) => {
    setToggling((current) => ({ ...current, [job.job_name]: next }));
    const outcome = await apply(
      { kind: "upsert", target: { type: "job", name: job.job_name }, value: { ...job, enabled: next } },
      baseVersion,
    );
    setToggling(({ [job.job_name]: _done, ...rest }) => rest);
    if (outcome.ok) return;
    if (outcome.conflict)
      setProblem({
        conflict: true,
        message: `Someone else changed ${job.job_name} since you opened the list. Reload to see their change.`,
      });
    else setProblem({ conflict: false, message: outcome.issues[0]?.message ?? outcome.message });
  };

  const openCreate = (draft: JobEntry, from: HTMLElement | null = activeElement()) => {
    openedFrom(from);
    setEditing({ mode: "create", draft });
  };
  const editingJob = editing?.mode === "edit" ? jobs.find((job) => job.job_name === editing.name) : undefined;
  // A job someone else deleted while its editor was open: the editor closes and the page says so.
  const vanished = editing?.mode === "edit" && state !== null && editingJob === undefined ? editing.name : null;
  const actions: JobListActions = { openCreate, document: document ?? { jobs: [] }, ready: state !== null };
  const extra = typeof extraActions === "function" ? extraActions(actions) : extraActions;
  const hasVersion = state !== null && state.version !== null;

  const toolbar = (
    <>
      {extra}
      <Button
        variant="outline"
        size="sm"
        onClick={(event) => {
          openedFrom(event.currentTarget);
          setImporting(true);
        }}
        disabled={state === null}
      >
        <Upload aria-hidden="true" />
        Import YAML
      </Button>
      {hasVersion ? (
        <Button asChild variant="outline" size="sm">
          <a href={exportUrl()} download>
            <Download aria-hidden="true" />
            Export YAML
          </a>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled title="Save or import a job list first">
          <Download aria-hidden="true" />
          Export YAML
        </Button>
      )}
      <Button ref={addJob} size="sm" onClick={(event) => openCreate({ job_name: "" }, event.currentTarget)} disabled={state === null}>
        <Plus aria-hidden="true" />
        Add job
      </Button>
    </>
  );

  let body: ReactNode;
  if (state === null) {
    body = error && !loading ? <LoadError message={error.message} onRetry={() => void reload()} /> : <TableSkeleton />;
  } else if (state.version === null && jobs.length === 0) {
    body = (
      <Empty className="flex-none border border-dashed border-border bg-muted/40 md:py-14">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListChecks aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>The job list is empty</EmptyTitle>
          <EmptyDescription>No jobs yet. Import your monitored-jobs YAML file, or add a job.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={(event) => {
              openedFrom(event.currentTarget);
              setImporting(true);
            }}
          >
            <Upload aria-hidden="true" />
            Import YAML
          </Button>
          <Button size="sm" onClick={(event) => openCreate({ job_name: "" }, event.currentTarget)}>
            <Plus aria-hidden="true" />
            Add job
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    body = (
      <section className="flex flex-col gap-3" aria-label="Monitored jobs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="relative w-full max-w-xs">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              ref={searchField}
              type="search"
              aria-label="Search jobs by name"
              placeholder="Search jobs by name"
              className="h-8 pl-8"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {query === "" ? count(jobs.length, "job", "jobs") : `${shown.length} of ${count(jobs.length, "job", "jobs")}`}
          </p>
          {state.version !== null ? (
            <p className="ml-auto font-mono text-[11px] text-muted-foreground">
              Version {state.version}
              {state.savedAt ? `, saved ${formatUtc(state.savedAt)}` : ""} by {state.savedBy ?? "you"}
            </p>
          ) : null}
        </div>
        {live.problem ? (
          <QueryProblemLine
            title={live.stale ? "Live status did not refresh" : "Live status is not available"}
            problem={live.problem}
            location={live.location}
            note={live.stale ? "The table shows the statuses from before." : undefined}
            onRetry={bump}
          />
        ) : null}
        <JobTable
          jobs={shown}
          query={search.trim()}
          inherited={inherited}
          live={live}
          toggling={toggling}
          onClearSearch={() => setSearch("")}
          onEdit={(name, from) => {
            openedFrom(from);
            setEditing({ mode: "edit", name });
          }}
          onDelete={(name, from) => {
            openedFrom(from);
            setDeleting(name);
          }}
          onToggle={(job, next) => void toggle(job, next, state.version)}
        />
      </section>
    );
  }

  return (
    <>
      <PageHeader title="Job list" description="The jobs the Watchdog monitors, and the limits for each." actions={toolbar} />
      <ConfigBanner savedVersion={state ? state.version : undefined} />
      {notice ? <Notice text={notice} onDismiss={() => setNotice(null)} /> : null}
      {vanished ? (
        <Notice
          tone="warning"
          text={`${vanished} is no longer in the list. Someone deleted it while you were editing.`}
          onDismiss={() => setEditing(null)}
        />
      ) : null}
      {problem ? (
        <ProblemAlert problem={problem} onReload={reload} onReloaded={() => setProblem(null)} onDismiss={() => setProblem(null)} />
      ) : state !== null && error !== null && !loading ? (
        // The list on screen loaded, but a later load did not: say so, as the change log does.
        <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-destructive">
          <CircleAlert className="size-3.5" aria-hidden="true" />
          The newest job list did not load. {error.message}
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => void reload()}>
            Retry
          </Button>
        </p>
      ) : null}
      {body}

      {state ? (
        <JobEditorSheet
          open={editing !== null && (editing.mode === "create" || editingJob !== undefined)}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          mode={editing?.mode ?? "create"}
          initial={editing?.mode === "create" ? editing.draft : (editingJob ?? { job_name: "" })}
          document={state.document}
          version={state.version}
          onSave={(entry, baseVersion) => apply({ kind: "upsert", target: { type: "job", name: entry.job_name }, value: entry }, baseVersion)}
          renderPatternPreview={patternPreview}
          onReload={reload}
          returnFocus={returnFocus}
        />
      ) : null}

      {state && deleting ? (
        <DeleteJobDialog
          name={deleting}
          document={state.document}
          version={state.version}
          onCancel={() => setDeleting(null)}
          onDelete={async (baseVersion) => {
            const outcome = await apply({ kind: "delete", target: { type: "job", name: deleting } }, baseVersion);
            if (outcome.ok) setDeleting(null);
            return outcome;
          }}
          onReload={reload}
          returnFocus={returnFocus}
        />
      ) : null}

      <ImportDialog
        open={importing}
        onOpenChange={setImporting}
        baseVersion={state?.version ?? null}
        onReload={reload}
        returnFocus={returnFocus}
        onImported={(result) => {
          saved(result);
          // An import's result has no savedAt or savedBy; a reload brings them.
          void reload();
        }}
      />
    </>
  );
}

function Notice({ text, tone = "success", onDismiss }: { text: string; tone?: "success" | "warning"; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-foreground",
        tone === "success" ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5",
      )}
    >
      <CircleCheck className={cn("size-4 shrink-0", tone === "success" ? "text-success" : "text-warning")} aria-hidden="true" />
      <p className="min-w-0 flex-1 leading-5">{text}</p>
      <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Dismiss" onClick={onDismiss}>
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

interface ProblemAlertProps {
  problem: Problem;
  onReload: ReloadJobList;
  onReloaded: () => void;
  onDismiss: () => void;
}

function ProblemAlert({ problem, onReload, onReloaded, onDismiss }: ProblemAlertProps) {
  return (
    <Alert variant="destructive" className="border-destructive/40">
      <CircleAlert aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p>{problem.message}</p>
        {problem.conflict ? (
          <ReloadButton onReload={onReload} onReloaded={onReloaded} />
        ) : (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive" className="border-destructive/40">
      <CircleAlert aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p>The job list did not load. {message}</p>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onRetry}>
          <RotateCw aria-hidden="true" />
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-md border border-border" aria-label="Loading the job list">
      <div className="flex h-9 items-center gap-6 border-b border-border bg-muted/50 px-3">
        {COLUMNS.map((column) => (
          <Skeleton key={column} className="h-3 w-16" />
        ))}
      </div>
      {["a", "b", "c", "d", "e"].map((key) => (
        <div key={key} className="flex h-14 items-center gap-6 border-b border-border px-3 last:border-0">
          <div className="grid w-52 gap-1.5">
            <Skeleton className="h-3.5 w-36" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-3.5 w-24" />
        </div>
      ))}
    </div>
  );
}

interface JobTableProps {
  jobs: JobEntry[];
  query: string;
  inherited: InheritedSettings;
  live: LiveStatus;
  toggling: Record<string, boolean>;
  onClearSearch: () => void;
  /** `from` is the button that was pressed, which gets focus back when the editor closes. */
  onEdit: (name: string, from: HTMLElement) => void;
  onDelete: (name: string, from: HTMLElement) => void;
  onToggle: (job: JobEntry, next: boolean) => void;
}

function JobTable({ jobs, query, inherited, live, toggling, onClearSearch, onEdit, onDelete, onToggle }: JobTableProps) {
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <Table className="text-[13px]">
        <TableHeader className="bg-muted/50">
          <TableRow className="hover:bg-transparent">
            {COLUMNS.map((column) => (
              <TableHead key={column} className="h-9 px-3 text-xs font-medium text-muted-foreground">
                {column}
              </TableHead>
            ))}
            <TableHead className="h-9 w-20 px-3">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={COLUMNS.length + 1} className="px-3 py-8 text-center text-muted-foreground">
                <p>No job names match {query}.</p>
                <Button variant="link" size="sm" onClick={onClearSearch}>
                  Clear the search
                </Button>
              </TableCell>
            </TableRow>
          ) : (
            jobs.map((job) => (
              <JobRow
                key={job.job_name}
                job={job}
                inherited={inherited}
                live={live}
                pending={toggling[job.job_name]}
                onEdit={(from) => onEdit(job.job_name, from)}
                onDelete={(from) => onDelete(job.job_name, from)}
                onToggle={(next) => onToggle(job, next)}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/** A value the job takes from the defaults: muted, and named as a default for assistive tech. */
function Inherited({ children }: { children: ReactNode }) {
  return (
    <span className="text-muted-foreground" title="From the defaults">
      {children}
      <span className="sr-only"> (default)</span>
    </span>
  );
}

function SeverityBadge({ severity, inherited }: { severity: string; inherited: boolean }) {
  return (
    <Badge
      variant="outline"
      title={inherited ? "From the defaults" : undefined}
      className={cn(
        "rounded-sm px-1.5 py-0 font-mono text-[11px] font-medium",
        severity === "CRITICAL"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-warning/30 bg-warning/10 text-warning",
        inherited && "border-dashed",
      )}
    >
      {severity}
    </Badge>
  );
}

function overrideSummary(overrides: object): string {
  return Object.entries(overrides)
    .map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join(", ");
}

function LiveStatusCell({ status, live, active }: { status: Status | undefined; live: LiveStatus; active: boolean }) {
  // The same badge as Monitoring, so a status reads the same on every page.
  if (status) return <StatusBadge status={status} />;
  if (live.loading) return <Skeleton className="h-3.5 w-16" />;
  if (live.problem) return <span className="text-xs text-muted-foreground">Not available</span>;
  return <span className="text-xs text-muted-foreground">{active ? "Not scanned yet" : "Off"}</span>;
}

interface JobRowProps {
  job: JobEntry;
  inherited: InheritedSettings;
  live: LiveStatus;
  pending: boolean | undefined;
  onEdit: (from: HTMLElement) => void;
  onDelete: (from: HTMLElement) => void;
  onToggle: (next: boolean) => void;
}

interface Limit {
  text: string;
  inherited: boolean;
}

function limitsOf(job: JobEntry, inherited: InheritedSettings): Limit[] {
  const limits: Limit[] = [];
  const add = (name: string, key: NumberKey, unit: string) => {
    // A saved null switches the default off: the job has no such limit.
    if (blocksDefault(job, key)) return;
    const own = job[key];
    const value = own ?? inherited.numbers[key];
    if (typeof value === "number") limits.push({ text: `${name} ${value}${unit}`, inherited: own === undefined });
  };
  add("runtime", "max_runtime_minutes", " min");
  add("retries", "max_retries", "");
  add("attempt", "min_attempt_minutes", " min");
  return limits;
}

function JobRow({ job, inherited, live, pending, onEdit, onDelete, onToggle }: JobRowProps) {
  const schedule = job.schedule_type ?? inherited.schedule_type;
  // Continuous jobs take only their own gap (30 when unset); triggered jobs have none.
  const gap =
    schedule === "triggered"
      ? null
      : schedule === "continuous"
        ? (job.max_gap_minutes ?? 30)
        : (job.max_gap_minutes ?? inherited.numbers.max_gap_minutes ?? null);
  const gapInherited = schedule === "scheduled" && job.max_gap_minutes === undefined;
  const limits = limitsOf(job, inherited);
  const severity = job.severity ?? inherited.severity;
  // A saved null or "" switches the default owner off.
  const owner = blocksDefault(job, "owner") ? "" : (job.owner ?? inherited.owner);
  const enabled = pending ?? job.enabled ?? inherited.enabled;
  const ids = Array.isArray(job.job_ids) ? job.job_ids.length : 0;
  const pattern = job.job_name_regex || `^${pyReEscape(job.job_name)}$`;
  const environments = Object.entries(job.environments ?? {});
  const active = isActive(job, inherited);

  return (
    <TableRow>
      <TableCell className="max-w-[15rem] px-3 py-2.5">
        <button
          type="button"
          className="block max-w-full truncate rounded-xs text-left font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => onEdit(event.currentTarget)}
        >
          {job.job_name}
        </button>
        <span
          className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground"
          title={ids > 0 ? job.job_ids?.join(", ") : pattern}
        >
          {ids > 0 ? count(ids, "job ID", "job IDs") : pattern}
        </span>
      </TableCell>
      <TableCell className="px-3 py-2.5">
        <span className="block">{job.schedule_type ? schedule : <Inherited>{schedule}</Inherited>}</span>
        {gap !== null ? (
          <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
            {gapInherited ? <Inherited>{`gap ${gap} min`}</Inherited> : `gap ${gap} min`}
          </span>
        ) : null}
      </TableCell>
      <TableCell className="px-3 py-2.5">
        {limits.length === 0 ? (
          <span className="text-xs text-muted-foreground">None</span>
        ) : (
          <span className="flex flex-col gap-0.5 font-mono text-[11px]">
            {limits.map((limit) => (
              <span key={limit.text}>{limit.inherited ? <Inherited>{limit.text}</Inherited> : limit.text}</span>
            ))}
          </span>
        )}
      </TableCell>
      <TableCell className="px-3 py-2.5">
        <SeverityBadge severity={severity} inherited={job.severity === undefined} />
      </TableCell>
      <TableCell className="max-w-[9rem] truncate px-3 py-2.5">
        {owner === "" ? (
          <span className="text-xs text-muted-foreground">Not set</span>
        ) : job.owner === undefined ? (
          <Inherited>{owner}</Inherited>
        ) : (
          owner
        )}
      </TableCell>
      <TableCell className="px-3 py-2.5">
        {environments.length === 0 ? (
          <span className="text-xs text-muted-foreground">None</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {environments.map(([label, overrides]) => (
              <Tooltip key={label}>
                <TooltipTrigger asChild>
                  <Badge variant="outline" tabIndex={0} className="rounded-sm px-1.5 py-0 font-mono text-[11px] font-normal">
                    {label}
                    <span className="sr-only">: {overrideSummary(overrides ?? {})}</span>
                  </Badge>
                </TooltipTrigger>
                <TooltipContent className="font-mono text-xs">{overrideSummary(overrides ?? {}) || "No changes"}</TooltipContent>
              </Tooltip>
            ))}
          </span>
        )}
      </TableCell>
      <TableCell className="px-3 py-2.5">
        <Switch checked={enabled} disabled={pending !== undefined} aria-label={`Check ${job.job_name}`} onCheckedChange={onToggle} />
      </TableCell>
      <TableCell className="px-3 py-2.5">
        <LiveStatusCell status={live.byJob.get(job.job_name)} live={live} active={active} />
      </TableCell>
      <TableCell className="px-2 py-2.5 text-right">
        <span className="inline-flex gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 text-muted-foreground hover:text-foreground"
            aria-label={`Edit ${job.job_name}`}
            onClick={(event) => onEdit(event.currentTarget)}
          >
            <Pencil aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-7 text-muted-foreground hover:text-destructive"
            aria-label={`Delete ${job.job_name}`}
            onClick={(event) => onDelete(event.currentTarget)}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </span>
      </TableCell>
    </TableRow>
  );
}

interface DeleteJobDialogProps {
  name: string;
  document: JobListDocument;
  /** The version `document` is. */
  version: number | null;
  onCancel: () => void;
  /** Deletes the job; `baseVersion` is the version the dialog opened at. */
  onDelete: (baseVersion: number | null) => Promise<SaveOutcome>;
  onReload: ReloadJobList;
  /** Where focus goes when the dialog closes (see useReturnFocus). */
  returnFocus?: ReturnFocus;
}

/** Confirms a delete, and names the links that go with it. */
function DeleteJobDialog({ name, document, version, onCancel, onDelete, onReload, returnFocus }: DeleteJobDialogProps) {
  const onCloseAutoFocus = useReturnFocus(returnFocus);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  // The version the dialog opened at, until a reload after a conflict shows a newer one.
  const [openedAt, takeNewest] = useOpenedVersion(version);
  const links = useMemo(() => linksRemovedWith(document, name), [document, name]);
  const blockers = useMemo(() => changeIssues(document, { kind: "delete", target: { type: "job", name } }), [document, name]);

  const confirm = async () => {
    setBusy(true);
    const result = await onDelete(openedAt);
    setBusy(false);
    if (!result.ok) setOutcome(result);
  };
  const failure = outcome !== null && !outcome.ok ? outcome : null;
  const conflict = failure?.conflict === true;
  const message = failure !== null && !failure.conflict ? (failure.issues[0]?.message ?? failure.message) : null;

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>The Watchdog stops checking this job. The change log keeps every earlier version.</AlertDialogDescription>
        </AlertDialogHeader>
        {links.length > 0 ? (
          <div className="grid gap-1.5 text-sm">
            <p>{links.length === 1 ? "This also removes 1 link:" : `This also removes ${links.length} links:`}</p>
            <ul className="grid gap-1 rounded-md border border-border bg-muted/40 px-3 py-2">
              {links.map((link) => (
                <li key={dependencyKey(link)} className="font-mono text-xs">
                  {describeTarget(`dependency:${dependencyKey(link)}`).name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {blockers.length > 0 ? (
          <p className="text-sm text-destructive">
            {blockers[0]?.path === "jobs"
              ? "This is the only job, and the list needs at least one."
              : `This job cannot be deleted: ${blockers[0]?.message ?? ""}`}
          </p>
        ) : null}
        {conflict ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            <p className="leading-5">Someone else changed this job since you opened it.</p>
            <ReloadButton
              onReload={onReload}
              onReloaded={() => {
                setOutcome(null);
                takeNewest();
              }}
            />
          </div>
        ) : null}
        {message ? (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={busy || blockers.length > 0 || conflict}
            onClick={(event) => {
              // Keep the dialog open until the save answers.
              event.preventDefault();
              void confirm();
            }}
          >
            {busy ? "Deleting..." : "Delete job"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
