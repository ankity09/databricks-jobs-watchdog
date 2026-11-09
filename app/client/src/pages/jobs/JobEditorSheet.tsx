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
  Button,
  Checkbox,
  FieldLegend,
  FieldSet,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Switch,
  Textarea,
} from "@databricks/appkit-ui/react";
import { CircleAlert, History, Info } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { deepEqual } from "../../../../shared/joblist/apply";
import type { JobEntry, JobListDocument, RuleIssue } from "../../../../shared/joblist/types";
import { useDebouncedCheck } from "../../hooks/useDebouncedCheck";
import { type ReloadJobList, type SaveOutcome, useOpenedVersion } from "../../hooks/useJobList";
import { toApiError } from "../../lib/api";
import { jobHistoryPath } from "../../lib/changeFilters";
import { draftIssues, jobIssues } from "../../lib/draft";
import {
  blocksDefault,
  effectivePatterns,
  environmentLabels,
  INHERIT,
  inheritedSettings,
  type JobFormValues,
  NUMBER_KEYS,
  type NumberKey,
  numberPatch,
  type OverrideFormValues,
  pyReEscape,
  SCHEDULE_TYPES,
  SEVERITIES,
  toEntry,
  toFormValues,
} from "../../lib/job-form";
import { type EntryJobIds, entryJobIds } from "../../lib/picker";
import { EnvironmentOverridesFields } from "./EnvironmentOverridesFields";
import { FormRow } from "./FormRow";
import { JobIdsInput } from "./JobIdsInput";
import { ReloadButton } from "./ReloadButton";
import { type ReturnFocus, useReturnFocus } from "./returnFocus";

export interface JobEditorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  /** The job to edit, or the draft to start a new job from. */
  initial: JobEntry;
  /** The saved job list the draft is checked against. */
  document: JobListDocument;
  /** The version `document` is; null when nothing is saved yet. */
  version: number | null;
  /** Saves the entry. `baseVersion` is the version the form opened at, so the server refuses the save when the job changed since. */
  onSave: (entry: JobEntry, baseVersion: number | null) => Promise<SaveOutcome>;
  /**
   * Rendered under the pattern fields with the patterns the scan would use, and
   * the entry's job IDs, which the scan uses instead where they apply (Task 7
   * shows the matching jobs here, or that the scan finds the job by its ID).
   */
  renderPatternPreview?: (pattern: string, exclude: string, jobIds: EntryJobIds) => ReactNode;
  /**
   * Reloads the job list after a conflict. In edit mode the form then starts
   * again from the newest saved job. Without it there is no Reload button, and
   * a conflict asks to close the form and open the job again.
   */
  onReload?: ReloadJobList;
  /** Where focus goes when the sheet closes: the control that opened it, then fallbacks (see useReturnFocus). */
  returnFocus?: ReturnFocus;
}

/**
 * The side form to add or edit one job. Every change is checked against the
 * whole job list with the shared rules, 200 ms after the last key, and each
 * issue shows next to its field. Save stays off while there are issues.
 */
export function JobEditorSheet({
  open,
  onOpenChange,
  mode,
  initial,
  document,
  version,
  onSave,
  renderPatternPreview,
  onReload,
  returnFocus,
}: JobEditorSheetProps) {
  // Bumped after a reload in edit mode, so the form starts again from the newest saved job.
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // The page also closes the sheet itself (the job was deleted meanwhile), so each opening clears what the last one said.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setNotice(null);
      setConfirmDiscard(false);
    }
  }
  const dirty = useRef(false);
  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  // "Keep editing" gives focus back to where it was in the sheet when the question opened.
  const content = useRef<HTMLDivElement>(null);
  const discardFrom = useRef<HTMLElement | null>(null);
  const backToPage = useReturnFocus(returnFocus);
  const backToSheet = useReturnFocus([discardFrom, content]);

  const close = () => {
    setNotice(null);
    setConfirmDiscard(false);
    dirty.current = false;
    onOpenChange(false);
  };
  const requestClose = () => {
    if (!dirty.current) {
      close();
      return;
    }
    const active = window.document.activeElement;
    discardFrom.current = active instanceof HTMLElement ? active : null;
    setConfirmDiscard(true);
  };
  const reloaded = () => {
    if (mode !== "edit") return;
    setRevision((n) => n + 1);
    setNotice("This form now shows the newest saved values. Make your change again.");
  };

  const name = initial.job_name;
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <SheetContent ref={content} side="right" className="w-full gap-0 p-0 sm:max-w-3xl" onCloseAutoFocus={backToPage}>
        <SheetHeader className="border-b border-border px-6 py-4">
          <SheetTitle className="text-base">{mode === "edit" ? `Edit ${name}` : "Add job"}</SheetTitle>
          <SheetDescription>
            {mode === "edit"
              ? "Change how the Watchdog checks this job. An empty field uses the default."
              : "Add a job for the Watchdog to check. An empty field uses the default. Problems show next to each field as you type."}
          </SheetDescription>
          {mode === "edit" ? (
            <Link
              to={jobHistoryPath(name)}
              className="inline-flex w-fit items-center gap-1.5 rounded-xs text-[13px] text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                // Leaving the page would drop edits that are not saved: the history opens in a new tab instead.
                if (!dirty.current) return;
                event.preventDefault();
                window.open(jobHistoryPath(name), "_blank", "noopener");
              }}
            >
              <History className="size-3.5" aria-hidden="true" />
              View history
            </Link>
          ) : null}
        </SheetHeader>
        {/* SheetContent mounts on open and unmounts after it closes, so each opening starts a fresh form. */}
        <EditorForm
          key={revision}
          mode={mode}
          initial={initial}
          document={document}
          version={version}
          onSave={onSave}
          renderPatternPreview={renderPatternPreview}
          onReload={onReload}
          onReloaded={reloaded}
          notice={notice}
          onDirtyChange={onDirtyChange}
          onCancel={requestClose}
          onDone={close}
        />
      </SheetContent>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent onCloseAutoFocus={backToSheet}>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {mode === "edit" ? `Your changes to ${name} are not saved.` : "The new job is not saved."} If you close the form now, they are
              lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={close}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

interface EditorFormProps {
  mode: "create" | "edit";
  initial: JobEntry;
  document: JobListDocument;
  version: number | null;
  onSave: (entry: JobEntry, baseVersion: number | null) => Promise<SaveOutcome>;
  renderPatternPreview?: (pattern: string, exclude: string, jobIds: EntryJobIds) => ReactNode;
  onReload?: ReloadJobList;
  onReloaded: () => void;
  notice: string | null;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onDone: () => void;
}

type Problem = { kind: "conflict" } | { kind: "error"; message: string };

/** The placeholder of an empty field whose saved null (or "" for text) switches the default off. */
const DEFAULT_OFF = "None, the default is ignored";

/** "Max gap" on screen; "Max gap (minutes)" for assistive tech, which hears the unit the description gives sighted readers. */
function minutes(text: string): ReactNode {
  return (
    <>
      {text}
      <span className="sr-only"> (minutes)</span>
    </>
  );
}

const NUMBER_FIELDS: Record<NumberKey, { label: ReactNode; description?: string }> = {
  max_gap_minutes: { label: minutes("Max gap") },
  max_runtime_minutes: {
    label: minutes("Max runtime"),
    description: "The longest allowed run, in minutes, before a warning.",
  },
  max_retries: { label: "Max retries", description: "More retries of a task than this is a retry loop." },
  min_attempt_minutes: {
    label: minutes("Min attempt"),
    description: "A retried attempt shorter than this, in minutes, is a retry loop.",
  },
};

function EditorForm({
  mode,
  initial,
  document,
  version,
  onSave,
  renderPatternPreview,
  onReload,
  onReloaded,
  notice,
  onDirtyChange,
  onCancel,
  onDone,
}: EditorFormProps) {
  // The entry, labels and version the form opened with. A reload remounts the form, so they are read once.
  // The save sends that version: when the job changed since (a switch saved after the form opened), the server
  // refuses it instead of saving the old values over the change.
  const [base] = useState(initial);
  const [openedAt, takeNewest] = useOpenedVersion(version);
  const [labels] = useState(() => environmentLabels(document, initial));
  const [startValues] = useState(() => toFormValues(initial, labels));
  const [values, setValues] = useState<JobFormValues>(startValues);
  const entry = useMemo(() => toEntry(values, base), [values, base]);
  const inherited = useMemo(() => inheritedSettings(document), [document]);

  // Checked 200 ms after the last change. The first check runs at once, so a draft shows what it still needs.
  const check = useCallback((draft: JobEntry) => draftIssues(document, draft, mode), [document, mode]);
  const [checked, setChecked] = useDebouncedCheck(entry, check);

  // Issues the server returned on save; shown until the next change.
  const [server, setServer] = useState<{ entry: JobEntry; issues: RuleIssue[] } | null>(null);
  // The job ID fields (the job's, then one per environment) that hold text they refused: Save waits for them.
  const [refusedIds, setRefusedIds] = useState<ReadonlySet<string>>(() => new Set());
  const idsRefused = useCallback((where: string, refused: boolean) => {
    setRefusedIds((current) => {
      if (current.has(where) === refused) return current;
      const next = new Set(current);
      if (refused) next.add(where);
      else next.delete(where);
      return next;
    });
  }, []);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(startValues), [values, startValues]);
  // An edit that would save the job as it is stays off: the store would write an empty version.
  const changed = useMemo(() => mode === "create" || !deepEqual(entry, base), [mode, entry, base]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const shownIssues = server !== null && server.entry === entry ? server.issues : checked.issues;
  // Where the draft sits in the checked list: in place of the saved job, or appended (rules name a nameless entry by index).
  const savedAt = mode === "edit" ? document.jobs.findIndex((job) => job.job_name === base.job_name) : -1;
  const index = savedAt >= 0 ? savedAt : document.jobs.length;
  const grouped = useMemo(() => jobIssues(shownIssues, entry.job_name, index), [shownIssues, entry.job_name, index]);
  const errors = (key: string) => grouped.fields[key] ?? [];

  const update = (patch: Partial<JobFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
    if (problem?.kind === "error") setProblem(null);
  };
  const updateRow = (rowIndex: number, row: OverrideFormValues) =>
    setValues((current) => ({
      ...current,
      environments: current.environments.map((r, i) => (i === rowIndex ? row : r)),
    }));

  const scheduleType = values.schedule_type === INHERIT ? inherited.schedule_type : values.schedule_type;
  const enabled = values.enabled ?? inherited.enabled;
  const patterns = useMemo(() => effectivePatterns(checked.value, inherited), [checked.value, inherited]);
  const jobIds = useMemo(() => entryJobIds(checked.value), [checked.value]);

  const save = async () => {
    // Check the entry as it is now, in case the last change was less than 200 ms ago.
    const issues = check(entry);
    setChecked({ value: entry, issues });
    if (issues.length > 0 || refusedIds.size > 0) return;
    setSaving(true);
    setProblem(null);
    let outcome: SaveOutcome;
    try {
      outcome = await onSave(entry, openedAt);
    } catch (error) {
      outcome = { ok: false, conflict: false, issues: [], message: toApiError(error).message };
    }
    setSaving(false);
    if (outcome.ok) {
      onDone();
    } else if (outcome.conflict) {
      setProblem({ kind: "conflict" });
    } else if (outcome.issues.length > 0) {
      setServer({ entry, issues: outcome.issues });
    } else {
      setProblem({ kind: "error", message: outcome.message });
    }
  };

  const blocked = !changed || shownIssues.length > 0 || refusedIds.size > 0 || saving || problem?.kind === "conflict";
  const gapDescription =
    scheduleType === "scheduled"
      ? "The longest allowed time between run starts, in minutes. A scheduled job needs one."
      : scheduleType === "continuous"
        ? "The longest time with no run in progress, in minutes. Empty means 30."
        : "Leave it empty: a triggered job has no schedule check.";
  // A saved null (or "" for text) switches the default off; an empty field keeps it so.
  const textPlaceholder = (key: "owner" | "notes", fallback: string): string => {
    if (blocksDefault(base, key)) return DEFAULT_OFF;
    return inherited[key] ? `From defaults: ${inherited[key]}` : fallback;
  };
  const numberPlaceholder = (key: NumberKey): string => {
    if (Object.prototype.hasOwnProperty.call(base, key) && Reflect.get(base, key) === null) return DEFAULT_OFF;
    if (key === "max_gap_minutes" && scheduleType === "continuous") return "30";
    if (key === "max_gap_minutes" && scheduleType === "triggered") return "Not used";
    const value = inherited.numbers[key];
    return value === undefined ? "Not set" : `From defaults: ${value}`;
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
        {notice ? (
          <Alert role="status" className="border-border bg-muted/50">
            <Info aria-hidden="true" />
            <AlertDescription className="text-foreground">{notice}</AlertDescription>
          </Alert>
        ) : null}
        {grouped.other.length > 0 ? (
          <section aria-label="Other problems in the job list">
            <Alert variant="destructive" className="border-destructive/40">
              <CircleAlert aria-hidden="true" />
              <AlertDescription>
                <p className="font-medium">The job list has other problems, so it cannot be saved yet:</p>
                <ul className="grid gap-1">
                  {/* jobIssues lists each issue once, so path and message make a unique key. */}
                  {grouped.other.map((issue) => (
                    <li key={`${issue.path}|${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          </section>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <FormRow
            label="Job name"
            yamlKey="job_name"
            description={
              mode === "edit" ? "To rename a job, delete it and add it again." : "A short name for findings and alerts. It must be unique."
            }
            errors={errors("job_name")}
          >
            {(control) => (
              <Input
                {...control}
                value={values.job_name}
                readOnly={mode === "edit"}
                autoFocus={mode === "create"}
                spellCheck={false}
                className={mode === "edit" ? "bg-muted font-mono text-muted-foreground" : "font-mono"}
                placeholder="orders_ingest"
                onChange={(event) => update({ job_name: event.target.value })}
              />
            )}
          </FormRow>
          <FormRow label="Enabled" yamlKey="enabled" errors={errors("enabled")} className="sm:w-44">
            {(control) => (
              <div className="flex h-9 items-center gap-2">
                <Switch
                  {...control}
                  checked={enabled}
                  onCheckedChange={(next) => update({ enabled: base.enabled === undefined && next === inherited.enabled ? null : next })}
                />
                <span className="text-xs text-muted-foreground">{enabled ? "Checked" : "Off: kept, not checked"}</span>
              </div>
            )}
          </FormRow>
        </div>

        <FieldSet className="gap-4">
          <FieldLegend variant="label" className="mb-0 text-[13px] font-semibold">
            Which jobs it matches
          </FieldLegend>
          <FormRow
            label="Name pattern"
            yamlKey="job_name_regex"
            description="A regex for the job's real name in each workspace. Without ^ and $ it matches anywhere in the name."
            errors={errors("job_name_regex")}
          >
            {(control) => (
              <Input
                {...control}
                value={values.job_name_regex}
                // In edit mode the name is read-only, so the form starts here.
                autoFocus={mode === "edit"}
                spellCheck={false}
                className="font-mono"
                placeholder={`^${pyReEscape(values.job_name.trim() || "job_name")}$`}
                onChange={(event) => update({ job_name_regex: event.target.value })}
              />
            )}
          </FormRow>
          <FormRow
            label="Exclude pattern"
            yamlKey="job_name_exclude_regex"
            description="Real names that match this are skipped, such as test copies."
            errors={errors("job_name_exclude_regex")}
          >
            {(control) => (
              <Input
                {...control}
                value={values.exclude_off ? "" : values.job_name_exclude_regex}
                disabled={values.exclude_off}
                spellCheck={false}
                className="font-mono"
                placeholder={values.exclude_off ? "No exclusion" : inherited.exclude ? `From defaults: ${inherited.exclude}` : "None"}
                onChange={(event) => update({ job_name_exclude_regex: event.target.value })}
              />
            )}
          </FormRow>
          {inherited.exclude !== null || values.exclude_off ? (
            <NoExclusion checked={values.exclude_off} onChange={(on) => update({ exclude_off: on })} />
          ) : null}
          {renderPatternPreview ? <div className="min-w-0">{renderPatternPreview(patterns.pattern, patterns.exclude, jobIds)}</div> : null}
          <FormRow
            label="Job IDs"
            yamlKey="job_ids"
            description="Optional. The exact jobs to check, by ID. Where job IDs apply, the patterns are not used."
            errors={errors("job_ids")}
          >
            {(control) => (
              <JobIdsInput
                {...control}
                value={values.job_ids}
                onChange={(ids) => update({ job_ids: ids })}
                onRefusedChange={(refused) => idsRefused("job", refused)}
              />
            )}
          </FormRow>
        </FieldSet>

        <FieldSet className="gap-4">
          <FieldLegend variant="label" className="mb-0 text-[13px] font-semibold">
            Schedule and limits
          </FieldLegend>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormRow label="Schedule type" yamlKey="schedule_type" errors={errors("schedule_type")}>
              {(control) => (
                <Select
                  value={values.schedule_type}
                  onValueChange={(value) => update({ schedule_type: SCHEDULE_TYPES.find((type) => type === value) ?? INHERIT })}
                >
                  <SelectTrigger {...control} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>Default ({inherited.schedule_type})</SelectItem>
                    {SCHEDULE_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormRow>
            <NumberRow
              name="max_gap_minutes"
              description={gapDescription}
              values={values}
              errors={errors}
              placeholder={numberPlaceholder}
              update={update}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {NUMBER_KEYS.filter((key) => key !== "max_gap_minutes").map((key) => (
              <NumberRow key={key} name={key} values={values} errors={errors} placeholder={numberPlaceholder} update={update} />
            ))}
          </div>
        </FieldSet>

        <FieldSet className="gap-4">
          <FieldLegend variant="label" className="mb-0 text-[13px] font-semibold">
            Routing
          </FieldLegend>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormRow label="Severity" yamlKey="severity" description="Used when the job is not healthy." errors={errors("severity")}>
              {(control) => (
                <Select
                  value={values.severity}
                  onValueChange={(value) => update({ severity: SEVERITIES.find((s) => s === value) ?? INHERIT })}
                >
                  <SelectTrigger {...control} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>Default ({inherited.severity})</SelectItem>
                    {SEVERITIES.map((severity) => (
                      <SelectItem key={severity} value={severity}>
                        {severity}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormRow>
            <FormRow label="Owner" yamlKey="owner" description="The team or person findings go to." errors={errors("owner")}>
              {(control) => (
                <Input
                  {...control}
                  value={values.owner}
                  placeholder={textPlaceholder("owner", "Not set")}
                  onChange={(event) => update({ owner: event.target.value })}
                />
              )}
            </FormRow>
          </div>
          <FormRow label="Notes" yamlKey="notes" errors={errors("notes")}>
            {(control) => (
              <Textarea
                {...control}
                value={values.notes}
                rows={2}
                className="min-h-14"
                placeholder={textPlaceholder("notes", "Free text for the people who read this list.")}
                onChange={(event) => update({ notes: event.target.value })}
              />
            )}
          </FormRow>
        </FieldSet>

        <FieldSet className="gap-3">
          <FieldLegend variant="label" className="mb-0 text-[13px] font-semibold">
            Per environment
          </FieldLegend>
          <p className="-mt-1 text-xs text-muted-foreground">
            {"Settings this job changes in the workspaces with one label. An empty field keeps the job's own setting."}
          </p>
          {errors("environments").map((message) => (
            <p key={message} className="text-xs text-destructive">
              {message}
            </p>
          ))}
          <EnvironmentOverridesFields
            rows={values.environments}
            onRowChange={updateRow}
            onIdsRefused={(label, refused) => idsRefused(`environment:${label}`, refused)}
            issues={grouped.environments}
            job={{
              severity: values.severity === INHERIT ? inherited.severity : values.severity,
              owner: values.owner.trim() || (blocksDefault(base, "owner") ? "" : inherited.owner),
              enabled,
              numbers: jobNumbers(values, inherited.numbers, base),
            }}
          />
        </FieldSet>
      </div>

      <SheetFooter className="flex-row flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-3">
        <FooterProblem
          problem={problem}
          onReload={onReload}
          onReloaded={() => {
            setProblem(null);
            // A new job keeps what was typed, and saves from the version it now checks against (an edit starts again).
            takeNewest();
            onReloaded();
          }}
        />
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={blocked} onClick={() => void save()}>
            {saving ? "Saving..." : mode === "edit" ? "Save changes" : "Add job"}
          </Button>
        </div>
      </SheetFooter>
    </>
  );
}

/** The job's own number settings, else its defaults (unless a saved null switches them off): what an environment row shows it keeps. */
function jobNumbers(values: JobFormValues, inherited: Partial<Record<NumberKey, number>>, base: JobEntry): Partial<Record<NumberKey, number>> {
  const numbers: Partial<Record<NumberKey, number>> = {};
  for (const key of NUMBER_KEYS) {
    const text = values[key].trim();
    const own = text === "" ? Number.NaN : Number(text);
    const value = Number.isFinite(own) ? own : blocksDefault(base, key) ? undefined : inherited[key];
    if (value !== undefined) numbers[key] = value;
  }
  return numbers;
}

function NoExclusion({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="-mt-2 flex items-center gap-2">
      <Checkbox id="no-exclusion" checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor="no-exclusion" className="text-xs font-normal">
        No exclusion for this job, even though the defaults set one
      </Label>
    </div>
  );
}

interface NumberRowProps {
  name: NumberKey;
  description?: string;
  values: JobFormValues;
  errors: (key: string) => string[];
  placeholder: (key: NumberKey) => string;
  update: (patch: Partial<JobFormValues>) => void;
}

function NumberRow({ name, description, values, errors, placeholder, update }: NumberRowProps) {
  return (
    <FormRow
      label={NUMBER_FIELDS[name].label}
      yamlKey={name}
      description={description ?? NUMBER_FIELDS[name].description}
      errors={errors(name)}
    >
      {(control) => (
        <Input
          {...control}
          // Text, not type="number": a number field hands over "" for text such as "1e", which would save as empty.
          type="text"
          inputMode="numeric"
          autoComplete="off"
          className="font-mono"
          value={values[name]}
          placeholder={placeholder(name)}
          onChange={(event) => update(numberPatch(name, event.target.value))}
        />
      )}
    </FormRow>
  );
}

interface FooterProblemProps {
  problem: Problem | null;
  onReload?: ReloadJobList;
  onReloaded: () => void;
}

function FooterProblem({ problem, onReload, onReloaded }: FooterProblemProps) {
  if (problem?.kind === "conflict") {
    return (
      <div role="alert" className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-destructive">
        {onReload ? (
          <>
            <p className="leading-5">Someone else changed this job since you opened it.</p>
            <ReloadButton onReload={onReload} onReloaded={onReloaded} />
          </>
        ) : (
          <p className="leading-5">
            Someone else changed this job since you opened it. Close this form and open the job again to see their change.
          </p>
        )}
      </div>
    );
  }
  if (problem?.kind === "error") {
    return (
      <p role="alert" className="min-w-0 text-sm text-destructive">
        Could not save: {problem.message}
      </p>
    );
  }
  return null;
}
