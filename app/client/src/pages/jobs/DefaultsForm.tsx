import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@databricks/appkit-ui/react";
import { Info } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { deepEqual } from "../../../../shared/joblist/apply";
import type { Change, DefaultsEntry, JobEntry, JobListDocument, RuleIssue, SaveResult } from "../../../../shared/joblist/types";
import { useDebouncedCheck } from "../../hooks/useDebouncedCheck";
import { type ReloadJobList, type SaveOutcome, useOpenedVersion } from "../../hooks/useJobList";
import { changeIssues, type DefaultIssue, defaultsIssues } from "../../lib/draft";
import {
  INHERIT,
  type JobFormValues,
  NUMBER_KEYS,
  type NumberKey,
  numberPatch,
  SCHEDULE_TYPES,
  SEVERITIES,
  toEntry,
  toFormValues,
} from "../../lib/job-form";
import { FormRow } from "./FormRow";
import { ReloadButton } from "./ReloadButton";

export interface DefaultsFormProps {
  document: JobListDocument;
  /** The version `document` is. */
  version: number | null;
  /** Saves a change; `baseVersion` is the version the form opened at. */
  onSave: (change: Change, baseVersion: number | null) => Promise<SaveOutcome>;
  onSaved: (result: SaveResult) => void;
  onReload: ReloadJobList;
}

/** The defaults as a job entry with no name, so the job form's conversions apply to them. */
function asEntry(defaults: DefaultsEntry | undefined): JobEntry {
  return { job_name: "", ...(defaults ?? {}) };
}

function asDefaults(entry: JobEntry): DefaultsEntry {
  const { job_name: _name, job_name_regex: _regex, job_ids: _ids, environments: _environments, ...defaults } = entry;
  return defaults;
}

/** The change that saves `next`: an upsert, or a delete when every default was cleared. */
function changeFor(saved: DefaultsEntry | undefined, next: DefaultsEntry): Change | null {
  if (Object.keys(next).length > 0) return { kind: "upsert", target: { type: "defaults" }, value: next };
  return saved && Object.keys(saved).length > 0 ? { kind: "delete", target: { type: "defaults" } } : null;
}

type Problem = { kind: "conflict" } | { kind: "error"; message: string };

const RELOADED = "This form now shows the newest saved values. Make your change again.";

/** "a", "a and b", "a, b and c", or "a, b and 6 more jobs". */
function jobList(jobs: string[]): string {
  if (jobs.length > 3) return `${jobs.slice(0, 2).join(", ")} and ${jobs.length - 2} more jobs`;
  return jobs.length <= 1 ? jobs.join("") : `${jobs.slice(0, -1).join(", ")} and ${jobs[jobs.length - 1] ?? ""}`;
}

/** A default's message, with the jobs that take the default and so report it. */
function fieldMessage({ message, jobs }: DefaultIssue): string {
  return jobs.length > 0 ? `${message} (used by ${jobList(jobs)})` : message;
}

/** "Max gap" on screen; "Max gap (minutes)" for assistive tech. The description gives sighted readers the unit. */
function minutes(text: string): ReactNode {
  return (
    <>
      {text}
      <span className="sr-only"> (minutes)</span>
    </>
  );
}

const NUMBER_LABELS: Record<NumberKey, { label: ReactNode; description: string }> = {
  max_gap_minutes: {
    label: minutes("Max gap"),
    description: "Minutes, for scheduled jobs. Continuous and triggered jobs do not take it from here.",
  },
  max_runtime_minutes: { label: minutes("Max runtime"), description: "Minutes. The longest allowed run, before a warning." },
  max_retries: { label: "Max retries", description: "More retries of a task than this is a retry loop." },
  min_attempt_minutes: { label: minutes("Min attempt"), description: "Minutes. A retried attempt shorter than this is a retry loop." },
};

/**
 * The defaults section: the settings every job gets unless it sets its own.
 * A change is checked against the whole list as you type, so a default that
 * would break a job is caught before it is saved.
 */
/** Where focus goes when the form starts again: the notice after a reload, the card after a save (its Save button goes). */
type FocusOnStart = "notice" | "card" | null;

export function DefaultsForm({ document, version, onSave, onSaved, onReload }: DefaultsFormProps) {
  // Bumped after a save or a reload, and when a newer version changed the defaults while the form has no edits,
  // so the form starts again from the newest saved defaults.
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusOnStart>(null);
  const restart = useCallback((next: { notice: string | null; focus: FocusOnStart }) => {
    setNotice(next.notice);
    setFocus(next.focus);
    setRevision((n) => n + 1);
  }, []);
  // A newer version starting the form again leaves focus where the person has it.
  const outdated = useCallback(() => restart({ notice: null, focus: null }), [restart]);
  return (
    <DefaultsFields
      key={revision}
      document={document}
      version={version}
      notice={notice}
      focus={focus}
      onSave={onSave}
      onSaved={(result) => {
        onSaved(result);
        restart({ notice: null, focus: "card" });
      }}
      onReload={onReload}
      onReloaded={() => restart({ notice: RELOADED, focus: "notice" })}
      onOutdated={outdated}
    />
  );
}

interface DefaultsFieldsProps extends DefaultsFormProps {
  notice: string | null;
  focus: FocusOnStart;
  onReloaded: () => void;
  /** A newer version has other defaults, and the form has no edits: it starts again from them. */
  onOutdated: () => void;
}

function DefaultsFields({ document, version, notice, focus, onSave, onSaved, onReload, onReloaded, onOutdated }: DefaultsFieldsProps) {
  const headingId = useId();
  // The form starts again after a reload or a save; focus moves to the notice that says so, or to the card.
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus === "notice") noticeRef.current?.focus();
    else if (focus === "card") cardRef.current?.focus();
  }, [focus]);
  // The defaults and the version the form opened at. A save sends that version, so when someone changed the
  // defaults since (a label save on this page brought their change), the server refuses it instead of saving
  // these values over theirs.
  const [saved] = useState(document.defaults);
  const [openedAt] = useOpenedVersion(version);
  const [base] = useState(() => asEntry(document.defaults));
  const [startValues] = useState(() => toFormValues(base, []));
  const [values, setValues] = useState<JobFormValues>(startValues);
  const next = useMemo(() => asDefaults(toEntry(values, base)), [values, base]);
  const change = useMemo(() => changeFor(saved, next), [saved, next]);
  const check = useCallback((candidate: Change | null) => (candidate ? changeIssues(document, candidate) : []), [document]);
  const [checked, setChecked] = useDebouncedCheck(change, check);
  const [server, setServer] = useState<{ change: Change | null; issues: RuleIssue[] } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);

  const issues = server !== null && server.change === change ? server.issues : checked.issues;
  // A bad default comes back once per job that takes it: it shows on its field, once, and the jobs count each job once.
  const grouped = useMemo(() => defaultsIssues(document, issues), [document, issues]);
  const fieldIssues = (key: string) => (grouped.fields[key] ?? []).map(fieldMessage);
  const dirty = !deepEqual(next, saved ?? {});
  // Edits stay until they are saved or undone; without edits, the form shows the newest defaults.
  const outdated = !dirty && !deepEqual(document.defaults ?? {}, saved ?? {});
  useEffect(() => {
    if (outdated) onOutdated();
  }, [outdated, onOutdated]);
  const update = (patch: Partial<JobFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
    if (problem?.kind === "error") setProblem(null);
  };

  const save = async () => {
    if (!change) return;
    const now = check(change);
    setChecked({ value: change, issues: now });
    if (now.length > 0) return;
    setSaving(true);
    setProblem(null);
    const outcome = await onSave(change, openedAt);
    setSaving(false);
    if (outcome.ok) onSaved(outcome.result);
    else if (outcome.conflict) setProblem({ kind: "conflict" });
    else if (outcome.issues.length > 0) setServer({ change, issues: outcome.issues });
    else setProblem({ kind: "error", message: outcome.message });
  };

  return (
    <Card
      ref={cardRef}
      tabIndex={-1}
      className="gap-4 py-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="region"
      aria-labelledby={headingId}
    >
      <CardHeader className="px-5">
        <CardTitle id={headingId} className="text-[15px]">
          Defaults
        </CardTitle>
        <CardDescription>The settings every job gets unless it sets its own. An empty field leaves the setting out.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 px-5">
        {notice ? (
          <p
            ref={noticeRef}
            role="status"
            tabIndex={-1}
            className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Info className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {notice}
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <FormRow
            label="Schedule type"
            yamlKey="schedule_type"
            description="For jobs that set none."
            errors={fieldIssues("schedule_type")}
          >
            {(control) => (
              <Select
                value={values.schedule_type}
                onValueChange={(value) => update({ schedule_type: SCHEDULE_TYPES.find((type) => type === value) ?? INHERIT })}
              >
                <SelectTrigger {...control} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>Not set (scheduled)</SelectItem>
                  {SCHEDULE_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormRow>
          <FormRow label="Severity" yamlKey="severity" description="For jobs that set none." errors={fieldIssues("severity")}>
            {(control) => (
              <Select
                value={values.severity}
                onValueChange={(value) => update({ severity: SEVERITIES.find((s) => s === value) ?? INHERIT })}
              >
                <SelectTrigger {...control} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>Not set (WARNING)</SelectItem>
                  {SEVERITIES.map((severity) => (
                    <SelectItem key={severity} value={severity}>
                      {severity}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormRow>
          {NUMBER_KEYS.map((key) => (
            <FormRow
              key={key}
              label={NUMBER_LABELS[key].label}
              yamlKey={key}
              description={NUMBER_LABELS[key].description}
              errors={fieldIssues(key)}
            >
              {(control) => (
                <Input
                  {...control}
                  // Text, not type="number": a number field hands over "" for text such as "1e", which would save as empty.
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  className="font-mono"
                  value={values[key]}
                  placeholder="Not set"
                  onChange={(event) => update(numberPatch(key, event.target.value))}
                />
              )}
            </FormRow>
          ))}
          <FormRow label="Owner" yamlKey="owner" description="The team or person findings go to." errors={fieldIssues("owner")}>
            {(control) => (
              <Input {...control} value={values.owner} placeholder="Not set" onChange={(event) => update({ owner: event.target.value })} />
            )}
          </FormRow>
          <FormRow
            label="Enabled"
            yamlKey="enabled"
            description="Off switches off every job that does not set enabled itself."
            errors={fieldIssues("enabled")}
          >
            {(control) => (
              <Select
                value={values.enabled === null ? INHERIT : values.enabled ? "on" : "off"}
                onValueChange={(value) => update({ enabled: value === "on" ? true : value === "off" ? false : null })}
              >
                <SelectTrigger {...control} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>Not set (on)</SelectItem>
                  <SelectItem value="on">On</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormRow>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <FormRow
            label="Exclude pattern"
            yamlKey="job_name_exclude_regex"
            description="Real names that match are skipped, for every job that sets no exclusion. For example _test(_|$) skips test copies."
            errors={fieldIssues("job_name_exclude_regex")}
          >
            {(control) => (
              <Input
                {...control}
                value={values.job_name_exclude_regex}
                spellCheck={false}
                className="font-mono"
                placeholder="Not set"
                onChange={(event) => update({ job_name_exclude_regex: event.target.value, exclude_off: false })}
              />
            )}
          </FormRow>
          <FormRow label="Notes" yamlKey="notes" errors={fieldIssues("notes")}>
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                className="min-h-14"
                value={values.notes}
                placeholder="Not set"
                onChange={(event) => update({ notes: event.target.value })}
              />
            )}
          </FormRow>
        </div>

        {grouped.jobs.length > 0 || grouped.other.length > 0 ? (
          <div className="grid gap-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
            {grouped.jobs.length > 0 ? (
              <p className="leading-5 font-medium text-destructive">
                {grouped.jobs.length === 1 ? "This change breaks 1 job:" : `This change breaks ${grouped.jobs.length} jobs:`}
              </p>
            ) : null}
            {/* defaultsIssues lists each message once, so these keys are unique. */}
            <ul className="grid gap-0.5 text-xs text-destructive">
              {grouped.jobs.flatMap((job) => job.messages.map((message) => <li key={`${job.name}|${message}`}>{message}</li>))}
              {grouped.other.map((issue) => (
                <li key={`${issue.path}|${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-3">
          {problem?.kind === "conflict" ? (
            <div role="alert" className="mr-auto flex flex-wrap items-center gap-2 text-sm text-destructive">
              <p className="leading-5">Someone else changed the defaults since you opened this page.</p>
              <ReloadButton onReload={onReload} onReloaded={onReloaded} />
            </div>
          ) : problem?.kind === "error" ? (
            <p role="alert" className="mr-auto text-sm text-destructive">
              Could not save: {problem.message}
            </p>
          ) : null}
          <Button variant="outline" size="sm" disabled={!dirty || saving} onClick={() => setValues(startValues)}>
            Undo changes
          </Button>
          <Button
            size="sm"
            disabled={!dirty || change === null || issues.length > 0 || saving || problem?.kind === "conflict"}
            onClick={() => void save()}
          >
            {saving ? "Saving..." : "Save defaults"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
