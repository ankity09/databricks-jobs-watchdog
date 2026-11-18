import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, ToggleGroup, ToggleGroupItem } from "@databricks/appkit-ui/react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { deepEqual } from "../../../../shared/joblist/apply";
import type { JobEntry, JobListDocument, ScheduleType } from "../../../../shared/joblist/types";
import { useDebouncedCheck } from "../../hooks/useDebouncedCheck";
import type { SaveOutcome } from "../../hooks/useJobList";
import { draftIssues, jobIssues } from "../../lib/draft";
import {
  blocksDefault,
  environmentLabels,
  INHERIT,
  inheritedSettings,
  type JobFormValues,
  type NumberKey,
  numberPatch,
  SCHEDULE_TYPES,
  SEVERITIES,
  toEntry,
  toFormValues,
} from "../../lib/job-form";
import { FormRow } from "./FormRow";

/** The placeholder of an empty field whose saved null switches the default off. */
const DEFAULT_OFF = "None, the default is ignored";

/** "Max gap" on screen; "Max gap (minutes)" for assistive tech. */
function minutes(text: string): ReactNode {
  return (
    <>
      {text}
      <span className="sr-only"> (minutes)</span>
    </>
  );
}

const SCHEDULE_LABEL: Record<ScheduleType, string> = { scheduled: "Scheduled", continuous: "Continuous", triggered: "Triggered" };

const NUMBER_FIELDS: ReadonlyArray<{ name: NumberKey; label: ReactNode }> = [
  { name: "max_gap_minutes", label: minutes("Max gap") },
  { name: "max_runtime_minutes", label: minutes("Max runtime") },
  { name: "max_retries", label: "Max retries" },
  { name: "min_attempt_minutes", label: minutes("Min attempt") },
];

export interface MapSettingsFormProps {
  job: JobEntry;
  document: JobListDocument;
  saving: boolean;
  /** Saves the changed job (one upsert). The form starts again from the saved job when the list shows it. */
  onSave: (entry: JobEntry) => Promise<SaveOutcome>;
}

/**
 * A job's common settings in the side panel: owner, severity, schedule type,
 * the four limits and the Monitored switch. Empty means the default applies,
 * and the placeholder shows it. Rule issues show under their fields, and Save
 * stays off while the form is unchanged or has an issue. It starts again from
 * the job when the saved job changes (after a save or a reload).
 */
export function MapSettingsForm(props: MapSettingsFormProps) {
  return <SettingsFields key={JSON.stringify(props.job)} {...props} />;
}

function SettingsFields({ job, document, saving, onSave }: MapSettingsFormProps) {
  const [startValues] = useState(() => toFormValues(job, environmentLabels(document, job)));
  const [values, setValues] = useState<JobFormValues>(startValues);
  const entry = useMemo(() => toEntry(values, job), [values, job]);
  const inherited = useMemo(() => inheritedSettings(document), [document]);

  // Checked 200 ms after the last change, like the job editor. The first check runs at once.
  const check = useCallback((draft: JobEntry) => draftIssues(document, draft, "edit"), [document]);
  const [checked, setChecked] = useDebouncedCheck(entry, check);
  const index = Math.max(
    0,
    document.jobs.findIndex((saved) => saved.job_name === job.job_name),
  );
  const grouped = useMemo(() => jobIssues(checked.issues, entry.job_name, index), [checked.issues, entry.job_name, index]);
  const errors = (key: string) => grouped.fields[key] ?? [];

  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(startValues), [values, startValues]);
  // A form that would save the job as it is stays off: the store would write an empty version.
  const changed = !deepEqual(entry, job);
  const blocked = !changed || checked.issues.length > 0 || saving;

  const update = (patch: Partial<JobFormValues>) => setValues((current) => ({ ...current, ...patch }));
  const scheduleType = values.schedule_type === INHERIT ? inherited.schedule_type : values.schedule_type;
  const enabled = values.enabled ?? inherited.enabled;

  const textPlaceholder = (): string => {
    if (blocksDefault(job, "owner")) return DEFAULT_OFF;
    return inherited.owner ? `From defaults: ${inherited.owner}` : "Not set";
  };
  const numberPlaceholder = (key: NumberKey): string => {
    if (Object.prototype.hasOwnProperty.call(job, key) && Reflect.get(job, key) === null) return DEFAULT_OFF;
    if (key === "max_gap_minutes" && scheduleType === "continuous") return "30";
    if (key === "max_gap_minutes" && scheduleType === "triggered") return "Not used";
    const value = inherited.numbers[key];
    return value === undefined ? "Not set" : `From defaults: ${value}`;
  };

  const save = async () => {
    // Check the entry as it is now, in case the last change was less than 200 ms ago.
    const issues = check(entry);
    setChecked({ value: entry, issues });
    if (issues.length > 0) return;
    await onSave(entry);
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked) void save();
      }}
    >
      <FormRow label="Owner" errors={errors("owner")}>
        {(control) => (
          <Input
            {...control}
            type="text"
            autoComplete="off"
            value={values.owner}
            placeholder={textPlaceholder()}
            onChange={(event) => update({ owner: event.target.value })}
          />
        )}
      </FormRow>

      <FormRow label="Severity" errors={errors("severity")}>
        {(control) => (
          <Select value={values.severity} onValueChange={(value) => update({ severity: SEVERITIES.find((s) => s === value) ?? INHERIT })}>
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

      <FormRow label="Schedule type" errors={errors("schedule_type")}>
        {(control) => (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            className="w-full"
            aria-label="Schedule type"
            aria-invalid={control["aria-invalid"]}
            value={scheduleType}
            onValueChange={(value) => {
              const next = SCHEDULE_TYPES.find((type) => type === value);
              // A click on the chosen one keeps it. The job's own choice is saved only when it differs from the default.
              if (!next) return;
              update({ schedule_type: job.schedule_type === undefined && next === inherited.schedule_type ? INHERIT : next });
            }}
          >
            {SCHEDULE_TYPES.map((type) => (
              <ToggleGroupItem key={type} value={type} className="flex-1 text-xs">
                {SCHEDULE_LABEL[type]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </FormRow>

      <div className="grid grid-cols-2 gap-x-3 gap-y-3">
        {NUMBER_FIELDS.map(({ name, label }) => (
          <FormRow key={name} label={label} errors={errors(name)}>
            {(control) => (
              <Input
                {...control}
                // Text, not type="number": a number field hands over "" for text such as "1e", which would save as empty.
                type="text"
                inputMode="numeric"
                autoComplete="off"
                className="font-mono"
                value={values[name]}
                placeholder={numberPlaceholder(name)}
                onChange={(event) => update(numberPatch(name, event.target.value))}
              />
            )}
          </FormRow>
        ))}
      </div>

      <FormRow label="Monitored" errors={errors("enabled")}>
        {(control) => (
          <div className="flex h-8 items-center gap-2">
            <Switch
              {...control}
              checked={enabled}
              onCheckedChange={(next) => update({ enabled: job.enabled === undefined && next === inherited.enabled ? null : next })}
            />
            <span className="text-xs text-muted-foreground">{enabled ? "Checked" : "Off: kept, not checked"}</span>
          </div>
        )}
      </FormRow>

      {grouped.other.length > 0 ? (
        <div className="grid gap-0.5 text-xs leading-4 text-destructive">
          {grouped.other.map((issue) => (
            <p key={`${issue.path}:${issue.message}`}>{issue.message}</p>
          ))}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={!dirty || saving} onClick={() => setValues(startValues)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={blocked}>
          Save
        </Button>
      </div>
    </form>
  );
}
