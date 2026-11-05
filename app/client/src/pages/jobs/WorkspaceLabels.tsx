import { sql } from "@databricks/appkit-ui/js";
import {
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
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useAnalyticsQuery,
} from "@databricks/appkit-ui/react";
import { CircleAlert, Pencil, Plus, RotateCw, Trash2, X } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { deepEqual } from "../../../../shared/joblist/apply";
import {
  type Change,
  type JobListDocument,
  type RuleIssue,
  type SaveResult,
  type WorkspaceEntry,
  workspaceKey,
} from "../../../../shared/joblist/types";
import { useDebouncedCheck } from "../../hooks/useDebouncedCheck";
import { type ReloadJobList, type SaveOutcome, useOpenedVersion } from "../../hooks/useJobList";
import { useLastGood } from "../../hooks/useLastGood";
import { useRefreshKey } from "../../hooks/useRefreshKey";
import { changeIssues, uniqueIssues, workspaceIssues } from "../../lib/draft";
import { FormRow } from "./FormRow";
import { ReloadButton } from "./ReloadButton";
import { type ReturnFocus, useReturnFocus } from "./returnFocus";

export interface WorkspaceLabelsProps {
  document: JobListDocument;
  /** The version `document` is. */
  version: number | null;
  /** Saves a change; `baseVersion` is the version the form or dialog opened at. */
  onSave: (change: Change, baseVersion: number | null) => Promise<SaveOutcome>;
  onSaved: (result: SaveResult) => void;
  onReload: ReloadJobList;
}

const WorkspaceRows = z.array(z.object({ workspace_id: z.string(), workspace_name: z.string().nullable(), status: z.string().nullable() }));
type WorkspaceRow = z.infer<typeof WorkspaceRows>[number];

interface Suggestions {
  rows: WorkspaceRow[];
  loading: boolean;
  failed: boolean;
  retry: () => void;
}

/** An edit keeps the workspace ID and name, so it offers no suggestions. */
const NO_SUGGESTIONS: Suggestions = { rows: [], loading: false, failed: false, retry: () => undefined };

/**
 * The region's workspaces from system.access.workspaces_latest
 * (workspaces.obo.sql, run as the person). Only the add form calls it, so the
 * query runs while that form is open, not on every load of the page.
 */
function useWorkspaceSuggestions(): Suggestions {
  const { refresh, bump } = useRefreshKey();
  const parameters = useMemo(() => ({ refresh: sql.int(refresh) }), [refresh]);
  const query = useAnalyticsQuery("workspaces", parameters);
  // null until the current query answers (AppKit's first render for new parameters is idle, not loading).
  const parsed = useMemo(() => (query.data === null ? null : WorkspaceRows.safeParse(query.data)), [query.data]);
  const rows = useLastGood(parsed?.success ? parsed.data : null);
  const failed = query.error !== null || parsed?.success === false;
  return { rows: rows ?? [], loading: !failed && rows === null, failed, retry: bump };
}

/** A region can hold thousands of workspaces, so each list offers the first 50 that match what is typed. */
const SUGGESTION_LIMIT = 50;

function matching(rows: WorkspaceRow[], text: string, fields: (row: WorkspaceRow) => string[]): WorkspaceRow[] {
  const needle = text.trim().toLowerCase();
  const found: WorkspaceRow[] = [];
  for (const row of rows) {
    if (found.length >= SUGGESTION_LIMIT) break;
    if (needle === "" || fields(row).some((value) => value.toLowerCase().includes(needle))) found.push(row);
  }
  return found;
}

/** How a label names its workspace, for buttons and titles: the name, else the ID. */
function nameOf(workspace: WorkspaceEntry): string {
  return workspace.workspace_name ?? workspace.workspace_id ?? "";
}

type Editing = { mode: "create" } | { mode: "edit"; key: string; name: string };

const RELOADED = "This form now shows the newest saved values. Make your change again.";

/** The environment label of each workspace: add, edit and remove them, one change at a time. */
export function WorkspaceLabels({ document, version, onSave, onSaved, onReload }: WorkspaceLabelsProps) {
  const headingId = useId();
  const [editing, setEditing] = useState<Editing | null>(null);
  // Bumped after a reload in edit mode, so the form starts again from the newest saved label.
  const [revision, setRevision] = useState(0);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // Where focus goes when the label form or the removal question closes: the button that opened it, else Add label
  // (the button went with its row).
  const opener = useRef<HTMLElement | null>(null);
  const addLabel = useRef<HTMLButtonElement>(null);
  const returnFocus: ReturnFocus = [opener, addLabel];
  const onCloseAutoFocus = useReturnFocus(returnFocus);
  const workspaces = document.workspaces ?? [];
  const editingEntry = editing?.mode === "edit" ? workspaces.find((w) => workspaceKey(w) === editing.key) : undefined;
  // A label someone else removed while its form was open: the form closes and the card says so.
  const vanished = editing?.mode === "edit" && editingEntry === undefined ? editing.name : null;
  const removingEntry = removing === null ? undefined : workspaces.find((w) => workspaceKey(w) === removing);
  const edit = (next: Editing | null) => {
    setFormNotice(null);
    setEditing(next);
  };
  const formProps = {
    document,
    version,
    notice: formNotice,
    onSave,
    onSaved: (result: SaveResult) => {
      edit(null);
      onSaved(result);
    },
    onReload,
    onCancel: () => edit(null),
  };

  return (
    <Card className="gap-4 py-5" role="region" aria-labelledby={headingId}>
      <CardHeader className="px-5">
        <CardTitle id={headingId} className="text-[15px]">
          Workspace labels
        </CardTitle>
        <CardDescription>
          An environment label for each workspace, such as production or lower. Every finding carries it, and a job can change its settings
          for one label.
        </CardDescription>
        <CardAction>
          <Button
            ref={addLabel}
            size="sm"
            variant="outline"
            onClick={(event) => {
              opener.current = event.currentTarget;
              edit({ mode: "create" });
            }}
          >
            <Plus aria-hidden="true" />
            Add label
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3 px-5">
        {vanished ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-foreground"
          >
            <CircleAlert className="size-4 shrink-0 text-warning" aria-hidden="true" />
            <p className="min-w-0 flex-1 leading-5">
              The label for {vanished} is no longer in the list. Someone removed it while you were editing.
            </p>
            <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Dismiss" onClick={() => edit(null)}>
              <X aria-hidden="true" />
            </Button>
          </div>
        ) : null}
        {workspaces.length === 0 ? (
          <p className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground">
            No labels yet. Add one to label a workspace production or lower.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <Table className="text-[13px]">
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-9 px-3 text-xs font-medium text-muted-foreground">Workspace</TableHead>
                  <TableHead className="h-9 px-3 text-xs font-medium text-muted-foreground">Label</TableHead>
                  <TableHead className="h-9 px-3 text-xs font-medium text-muted-foreground">Notes</TableHead>
                  <TableHead className="h-9 w-20 px-3">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workspaces.map((workspace) => {
                  const key = workspaceKey(workspace);
                  const name = nameOf(workspace);
                  return (
                    <TableRow key={key}>
                      <TableCell className="max-w-56 px-3 py-2">
                        {workspace.workspace_name ? <span className="block truncate">{workspace.workspace_name}</span> : null}
                        {workspace.workspace_id ? <span className="block truncate font-mono text-xs">{workspace.workspace_id}</span> : null}
                        <span className="block text-[11px] text-muted-foreground">
                          {workspace.workspace_id ? "by ID" : "by name, any case"}
                        </span>
                      </TableCell>
                      <TableCell className="px-3 py-2">
                        <Badge variant="outline" className="rounded-sm px-1.5 py-0 font-mono text-[11px] font-normal">
                          {workspace.environment}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-72 truncate px-3 py-2 text-muted-foreground" title={workspace.notes}>
                        {workspace.notes ?? ""}
                      </TableCell>
                      <TableCell className="px-2 py-2 text-right">
                        <span className="inline-flex gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-7 text-muted-foreground hover:text-foreground"
                            aria-label={`Edit the label for ${name}`}
                            onClick={(event) => {
                              opener.current = event.currentTarget;
                              edit({ mode: "edit", key, name });
                            }}
                          >
                            <Pencil aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-7 text-muted-foreground hover:text-destructive"
                            aria-label={`Remove the label for ${name}`}
                            onClick={(event) => {
                              opener.current = event.currentTarget;
                              setRemoving(key);
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog
        open={editing !== null && (editing.mode === "create" || editingEntry !== undefined)}
        onOpenChange={(open) => {
          if (!open) edit(null);
        }}
      >
        <DialogContent className="sm:max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
          {editing?.mode === "create" ? (
            // A new label keeps what was typed after a reload: the check then shows whether someone added it meanwhile.
            <CreateLabelForm {...formProps} onReloaded={() => undefined} />
          ) : editing && editingEntry ? (
            <LabelForm
              key={`${editing.key}|${revision}`}
              {...formProps}
              mode="edit"
              initial={editingEntry}
              suggestions={NO_SUGGESTIONS}
              onReloaded={() => {
                setFormNotice(RELOADED);
                setRevision((n) => n + 1);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {removingEntry ? (
        <RemoveLabelDialog
          workspace={removingEntry}
          document={document}
          version={version}
          onCancel={() => setRemoving(null)}
          onRemove={async (baseVersion) => {
            const outcome = await onSave({ kind: "delete", target: { type: "workspace", key: workspaceKey(removingEntry) } }, baseVersion);
            if (outcome.ok) {
              setRemoving(null);
              onSaved(outcome.result);
            }
            return outcome;
          }}
          onReload={onReload}
          returnFocus={returnFocus}
        />
      ) : null}
    </Card>
  );
}

interface LabelFormProps {
  mode: "create" | "edit";
  initial: WorkspaceEntry;
  document: JobListDocument;
  /** The version `document` is. */
  version: number | null;
  suggestions: Suggestions;
  /** Shown at the top of the form, such as after a reload. */
  notice: string | null;
  onSave: (change: Change, baseVersion: number | null) => Promise<SaveOutcome>;
  onSaved: (result: SaveResult) => void;
  onReload: ReloadJobList;
  /** After a conflict's reload worked. */
  onReloaded: () => void;
  onCancel: () => void;
}

const NEW_LABEL: WorkspaceEntry = { environment: "" };

/** The add form, with suggestions from the region's workspaces, which it reads while it is open. */
function CreateLabelForm(props: Omit<LabelFormProps, "mode" | "initial" | "suggestions">) {
  const suggestions = useWorkspaceSuggestions();
  return <LabelForm {...props} mode="create" initial={NEW_LABEL} suggestions={suggestions} />;
}

type Problem = { kind: "conflict" } | { kind: "error"; message: string };

/** Typed text, trimmed, or the stored value while its field still shows it exactly, so an untouched field saves as it was. */
function kept(typed: string, stored: string | undefined): string | undefined {
  if (stored !== undefined && typed === (stored ?? "")) return stored;
  const trimmed = typed.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * The label the form describes, built on the stored one. What a field still
 * shows unchanged is saved as stored: a name with spaces around it keeps its
 * key (the one the save names), and empty notes stay, so an unchanged label
 * is not a change.
 */
function entryFrom(base: WorkspaceEntry, id: string, name: string, environment: string, notes: string): WorkspaceEntry {
  const entry: WorkspaceEntry = { environment: kept(environment, base.environment) ?? "" };
  const workspaceId = kept(id, base.workspace_id);
  const workspaceName = kept(name, base.workspace_name);
  const text = kept(notes, base.notes);
  if (workspaceId !== undefined) entry.workspace_id = workspaceId;
  if (workspaceName !== undefined) entry.workspace_name = workspaceName;
  if (text !== undefined) entry.notes = text;
  return entry;
}

function LabelForm({ mode, initial, document, version, suggestions, notice, onSave, onSaved, onReload, onReloaded, onCancel }: LabelFormProps) {
  // The label and the version the form opened at (a reload starts the form again).
  const [base] = useState(initial);
  const [openedAt] = useOpenedVersion(version);
  const idsList = useId();
  const namesList = useId();
  const labelsList = useId();
  const [id, setId] = useState(base.workspace_id ?? "");
  const [name, setName] = useState(base.workspace_name ?? "");
  const [environment, setEnvironment] = useState(base.environment);
  const [notes, setNotes] = useState(base.notes ?? "");
  const entry = useMemo(() => entryFrom(base, id, name, environment, notes), [base, id, name, environment, notes]);
  const check = useCallback((candidate: WorkspaceEntry) => workspaceIssues(document, candidate, mode), [document, mode]);
  const [checked, setChecked] = useDebouncedCheck(entry, check);
  const [server, setServer] = useState<{ entry: WorkspaceEntry; issues: RuleIssue[] } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);

  const workspaces = useMemo(() => document.workspaces ?? [], [document.workspaces]);
  const index = mode === "edit" ? workspaces.findIndex((w) => workspaceKey(w) === workspaceKey(base)) : workspaces.length;
  const issues = server !== null && server.entry === entry ? server.issues : checked.issues;
  const at = `workspaces[${index >= 0 ? index : workspaces.length}]`;
  const fieldIssues = (key: string) => issues.filter((issue) => issue.path === `${at}.${key}`).map((issue) => issue.message);
  // Each issue once: the rules can report one twice, and the list keys on path and message.
  const listed = uniqueIssues(issues.filter((issue) => issue.path === at || issue.path === "" || issue.path.startsWith("jobs[")));
  // An edit that would save the label as it is stays off: the store would write an empty version.
  const changed = mode === "create" || !deepEqual(entry, base);
  const labels = useMemo(
    () => [...new Set(workspaces.map((w) => w.environment).filter((label) => typeof label === "string" && label !== ""))],
    [workspaces],
  );
  const idSuggestions = useMemo(
    () => matching(suggestions.rows, id, (row) => [row.workspace_id, row.workspace_name ?? ""]),
    [suggestions.rows, id],
  );
  const nameSuggestions = useMemo(
    () =>
      matching(
        suggestions.rows.filter((row) => row.workspace_name),
        name,
        (row) => [row.workspace_name ?? "", row.workspace_id],
      ),
    [suggestions.rows, name],
  );

  const save = async () => {
    const now = check(entry);
    setChecked({ value: entry, issues: now });
    if (now.length > 0) return;
    setSaving(true);
    setProblem(null);
    const outcome = await onSave(
      { kind: "upsert", target: { type: "workspace", key: workspaceKey(mode === "edit" ? base : entry) }, value: entry },
      openedAt,
    );
    setSaving(false);
    if (outcome.ok) onSaved(outcome.result);
    else if (outcome.conflict) setProblem({ kind: "conflict" });
    else if (outcome.issues.length > 0) setServer({ entry, issues: outcome.issues });
    else setProblem({ kind: "error", message: outcome.message });
  };

  const readOnly = mode === "edit";
  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === "edit" ? `Edit the label for ${nameOf(base)}` : "Add a workspace label"}</DialogTitle>
        <DialogDescription>
          {readOnly
            ? "To label another workspace, remove this label and add a new one."
            : "Give the workspace ID, its name, or both. With an ID, the label matches that workspace only; with only a name, it matches the name in any case."}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        {notice ? (
          <p role="status" className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
            {notice}
          </p>
        ) : null}
        {suggestions.failed ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <p className="min-w-0 flex-1 leading-4">
              No suggestions: the app could not read system.access.workspaces_latest, often because you have no SELECT on it. You can still
              type a workspace ID or name.
            </p>
            <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2" onClick={suggestions.retry}>
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormRow label="Workspace ID" yamlKey="workspace_id" errors={fieldIssues("workspace_id")}>
            {(control) => (
              <Input
                {...control}
                value={id}
                readOnly={readOnly}
                inputMode="numeric"
                list={readOnly ? undefined : idsList}
                spellCheck={false}
                className={readOnly ? "bg-muted font-mono text-muted-foreground" : "font-mono"}
                placeholder={readOnly ? "Not set" : suggestions.loading ? "Loading suggestions" : "1111111111111111"}
                onChange={(event) => setId(event.target.value)}
              />
            )}
          </FormRow>
          <FormRow label="Workspace name" yamlKey="workspace_name" errors={fieldIssues("workspace_name")}>
            {(control) => (
              <Input
                {...control}
                value={name}
                readOnly={readOnly}
                list={readOnly ? undefined : namesList}
                spellCheck={false}
                className={readOnly ? "bg-muted text-muted-foreground" : undefined}
                placeholder={readOnly ? "Not set" : "example-prod"}
                onChange={(event) => setName(event.target.value)}
              />
            )}
          </FormRow>
        </div>
        <FormRow
          label="Environment label"
          yamlKey="environment"
          description="Letters, digits, - and _, for example production or lower."
          errors={fieldIssues("environment")}
        >
          {(control) => (
            <Input
              {...control}
              value={environment}
              list={labelsList}
              spellCheck={false}
              autoFocus={readOnly}
              className="font-mono"
              placeholder="production"
              onChange={(event) => setEnvironment(event.target.value)}
            />
          )}
        </FormRow>
        <FormRow label="Notes" yamlKey="notes" errors={fieldIssues("notes")}>
          {(control) => <Input {...control} value={notes} placeholder="Optional" onChange={(event) => setNotes(event.target.value)} />}
        </FormRow>
        <datalist id={idsList}>
          {idSuggestions.map((row) => (
            <option key={row.workspace_id} value={row.workspace_id}>
              {[row.workspace_name, row.status].filter(Boolean).join(", ")}
            </option>
          ))}
        </datalist>
        <datalist id={namesList}>
          {nameSuggestions.map((row) => (
            <option key={row.workspace_id} value={row.workspace_name ?? ""}>
              {row.workspace_id}
            </option>
          ))}
        </datalist>
        <datalist id={labelsList}>
          {labels.map((label) => (
            <option key={label} value={label} />
          ))}
        </datalist>
        {listed.length > 0 ? (
          <ul className="grid gap-0.5 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {listed.map((issue) => (
              <li key={`${issue.path}|${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        ) : null}
      </div>
      <DialogFooter className="items-center gap-2 sm:flex-wrap sm:justify-between">
        {/* A problem takes its own row above the buttons. */}
        {problem?.kind === "conflict" ? (
          <div role="alert" className="flex basis-full flex-wrap items-center gap-2 text-sm text-destructive">
            <p className="leading-5">Someone else changed this label since you opened it.</p>
            <ReloadButton
              onReload={onReload}
              onReloaded={() => {
                setProblem(null);
                onReloaded();
              }}
            />
          </div>
        ) : problem?.kind === "error" ? (
          <p role="alert" className="basis-full text-sm text-destructive">
            Could not save: {problem.message}
          </p>
        ) : null}
        <div className="flex gap-2 sm:ml-auto">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!changed || issues.length > 0 || saving || problem?.kind === "conflict"} onClick={() => void save()}>
            {saving ? "Saving..." : mode === "edit" ? "Save label" : "Add label"}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

interface RemoveLabelDialogProps {
  workspace: WorkspaceEntry;
  document: JobListDocument;
  /** The version `document` is. */
  version: number | null;
  onCancel: () => void;
  /** Removes the label; `baseVersion` is the version the dialog opened at. */
  onRemove: (baseVersion: number | null) => Promise<SaveOutcome>;
  onReload: ReloadJobList;
  /** Where focus goes when the dialog closes (see useReturnFocus). */
  returnFocus?: ReturnFocus;
}

const OVERRIDE_PATH = /^jobs\[(.+)\]\.environments\.([^.]+)$/;

function listOf(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

/** What stops a removal, one sentence per label that jobs still set settings for, then any other issue as written. */
function blockerSentences(issues: RuleIssue[]): string[] {
  const jobsByLabel = new Map<string, string[]>();
  const other: string[] = [];
  for (const issue of issues) {
    const match = OVERRIDE_PATH.exec(issue.path);
    const job = match?.[1];
    const label = match?.[2];
    if (job && label) jobsByLabel.set(label, [...(jobsByLabel.get(label) ?? []), job]);
    else other.push(issue.message);
  }
  const sentences = [...jobsByLabel].map(([label, jobs]) =>
    jobs.length === 1
      ? `${listOf(jobs)} sets settings for ${label}. Remove them from the job first, or keep another workspace labeled ${label}.`
      : `${listOf(jobs)} set settings for ${label}. Remove them from the jobs first, or keep another workspace labeled ${label}.`,
  );
  // Each sentence once, so the list can key on it.
  return [...new Set([...sentences, ...other])];
}

/** Confirms a label removal. A label that a job still sets settings for cannot go while no other workspace has it. */
function RemoveLabelDialog({ workspace, document, version, onCancel, onRemove, onReload, returnFocus }: RemoveLabelDialogProps) {
  const backToPage = useReturnFocus(returnFocus);
  const name = nameOf(workspace);
  const blockers = useMemo(
    () => changeIssues(document, { kind: "delete", target: { type: "workspace", key: workspaceKey(workspace) } }),
    [document, workspace],
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Exclude<SaveOutcome, { ok: true }> | null>(null);
  // The version the dialog opened at, until a reload after a conflict shows a newer one.
  const [openedAt, takeNewest] = useOpenedVersion(version);

  const confirm = async () => {
    setBusy(true);
    const outcome = await onRemove(openedAt);
    setBusy(false);
    if (!outcome.ok) setFailure(outcome);
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent onCloseAutoFocus={backToPage}>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove the label for {name}?</AlertDialogTitle>
          <AlertDialogDescription>Findings from this workspace no longer carry the label {workspace.environment}.</AlertDialogDescription>
        </AlertDialogHeader>
        {blockers.length > 0 ? (
          <ul className="grid gap-1 text-sm text-destructive">
            {blockerSentences(blockers).map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
        ) : null}
        {failure?.conflict ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            <p className="leading-5">Someone else changed this label since you opened it.</p>
            <ReloadButton
              onReload={onReload}
              onReloaded={() => {
                setFailure(null);
                takeNewest();
              }}
            />
          </div>
        ) : failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure.issues[0]?.message ?? failure.message}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={busy || blockers.length > 0 || failure?.conflict === true}
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            {busy ? "Removing..." : "Remove label"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
