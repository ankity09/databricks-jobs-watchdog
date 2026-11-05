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
import { CircleAlert, Info, RotateCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobEntry, JobListDocument, RuleIssue } from "../../../../shared/joblist/types";
import { useDebouncedCheck } from "../../hooks/useDebouncedCheck";
import type { SaveOutcome } from "../../hooks/useJobList";
import { toApiError } from "../../lib/api";
import { draftIssues, jobIssues } from "../../lib/draft";
import {
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
import { EnvironmentOverridesFields } from "./EnvironmentOverridesFields";
import { FormRow } from "./FormRow";
import { JobIdsInput } from "./JobIdsInput";

export interface JobEditorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  /** The job to edit, or the draft to start a new job from. */
  initial: JobEntry;
  /** The saved job list the draft is checked against. */
  document: JobListDocument;
  onSave: (entry: JobEntry) => Promise<SaveOutcome>;
  /** Rendered under the pattern fields with the patterns the scan would use (Task 7 shows the matching jobs here). */
  renderPatternPreview?: (pattern: string, exclude: string) => ReactNode;
  /** Reloads the job list after a conflict. In edit mode the form then starts again from the newest saved job. */
  onReload?: () => Promise<void>;
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
  onSave,
  renderPatternPreview,
  onReload,
}: JobEditorSheetProps) {
  // Bumped after a reload in edit mode, so the form starts again from the newest saved job.
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = useRef(false);
  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  const close = () => {
    setNotice(null);
    setConfirmDiscard(false);
    dirty.current = false;
    onOpenChange(false);
  };
  const requestClose = () => {
    if (dirty.current) setConfirmDiscard(true);
    else close();
  };
  const reloaded = () => {
    if (mode !== "edit") return;
    setRevision((n) => n + 1);
    setNotice("This form now shows the newest saved values. Make your change again.");
  };

  const name = initial.job_name;
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-3xl">
        <SheetHeader className="border-b border-border px-6 py-4">
          <SheetTitle className="text-base">{mode === "edit" ? `Edit ${name}` : "Add job"}</SheetTitle>
          <SheetDescription>
            {mode === "edit"
              ? "Change how the Watchdog checks this job. An empty field uses the default."
              : "Add a job for the Watchdog to check. An empty field uses the default. Problems show next to each field as you type."}
          </SheetDescription>
        </SheetHeader>
        {/* SheetContent mounts on open and unmounts after it closes, so each opening starts a fresh form. */}
        <EditorForm
          key={revision}
          mode={mode}
          initial={initial}
          document={document}
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
        <AlertDialogContent>
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
  onSave: (entry: JobEntry) => Promise<SaveOutcome>;
  renderPatternPreview?: (pattern: string, exclude: string) => ReactNode;
  onReload?: () => Promise<void>;
  onReloaded: () => void;
  notice: string | null;
  onDirtyChange: (dirty: boolean) => void;
  onCancel: () => void;
  onDone: () => void;
}

type Problem = { kind: "conflict" } | { kind: "error"; message: string };

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
  onSave,
  renderPatternPreview,
  onReload,
  onReloaded,
  notice,
  onDirtyChange,
  onCancel,
  onDone,
}: EditorFormProps) {
  // The entry and labels the form opened with. A reload remounts the form, so they are read once.
  const [base] = useState(initial);
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
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);

  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(startValues), [values, startValues]);
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

  const save = async () => {
    // Check the entry as it is now, in case the last change was less than 200 ms ago.
    const issues = check(entry);
    setChecked({ value: entry, issues });
    if (issues.length > 0) return;
    setSaving(true);
    setProblem(null);
    let outcome: SaveOutcome;
    try {
      outcome = await onSave(entry);
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

  const reload = async () => {
    setReloading(true);
    try {
      await onReload?.();
    } finally {
      setReloading(false);
    }
    setProblem(null);
    onReloaded();
  };

  const blocked = shownIssues.length > 0 || saving || problem?.kind === "conflict";
  const gapDescription =
    scheduleType === "scheduled"
      ? "The longest allowed time between run starts, in minutes. A scheduled job needs one."
      : scheduleType === "continuous"
        ? "The longest time with no run in progress, in minutes. Empty means 30."
        : "Leave it empty: a triggered job has no schedule check.";
  const numberPlaceholder = (key: NumberKey): string => {
    if (Object.prototype.hasOwnProperty.call(base, key) && Reflect.get(base, key) === null) return "None, the default is ignored";
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
          {renderPatternPreview ? <div className="min-w-0">{renderPatternPreview(patterns.pattern, patterns.exclude)}</div> : null}
          <FormRow
            label="Job IDs"
            yamlKey="job_ids"
            description="Optional. The exact jobs to check, by ID. Where job IDs apply, the patterns are not used."
            errors={errors("job_ids")}
          >
            {(control) => <JobIdsInput {...control} value={values.job_ids} onChange={(ids) => update({ job_ids: ids })} />}
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
                  placeholder={inherited.owner ? `From defaults: ${inherited.owner}` : "Not set"}
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
                placeholder={inherited.notes ? `From defaults: ${inherited.notes}` : "Free text for the people who read this list."}
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
            issues={grouped.environments}
            job={{
              severity: values.severity === INHERIT ? inherited.severity : values.severity,
              owner: values.owner.trim() || inherited.owner,
              enabled,
              numbers: jobNumbers(values, inherited.numbers),
            }}
          />
        </FieldSet>
      </div>

      <SheetFooter className="flex-row flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-3">
        <FooterProblem problem={problem} reloading={reloading} onReload={() => void reload()} />
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

/** The job's own number settings, else its defaults: what an environment row shows it keeps. */
function jobNumbers(values: JobFormValues, inherited: Partial<Record<NumberKey, number>>): Partial<Record<NumberKey, number>> {
  const numbers: Partial<Record<NumberKey, number>> = {};
  for (const key of NUMBER_KEYS) {
    const text = values[key].trim();
    const own = text === "" ? Number.NaN : Number(text);
    const value = Number.isFinite(own) ? own : inherited[key];
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
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          className="font-mono"
          value={values[name]}
          placeholder={placeholder(name)}
          onChange={(event) => update(numberPatch(name, event.target.value))}
        />
      )}
    </FormRow>
  );
}

function FooterProblem({ problem, reloading, onReload }: { problem: Problem | null; reloading: boolean; onReload: () => void }) {
  if (problem?.kind === "conflict") {
    return (
      <div role="alert" className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-destructive">
        <p>Someone else changed this job since you opened it.</p>
        <Button variant="outline" size="sm" className="gap-1.5" disabled={reloading} onClick={onReload}>
          <RotateCw aria-hidden="true" />
          Reload
        </Button>
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
