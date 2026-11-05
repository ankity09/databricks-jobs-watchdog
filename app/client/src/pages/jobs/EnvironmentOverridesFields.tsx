import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@databricks/appkit-ui/react";
import { ChevronRight } from "lucide-react";
import type { Severity } from "../../../../shared/joblist/types";
import type { EnvironmentIssues } from "../../lib/draft";
import { INHERIT, NUMBER_KEYS, type NumberKey, type OverrideFormValues, SEVERITIES } from "../../lib/job-form";
import { cn } from "../../lib/utils";
import { FormRow } from "./FormRow";
import { JobIdsInput } from "./JobIdsInput";

/** The job's own settings, after its defaults: what an environment gets when it changes nothing. */
export interface JobSettingsForOverrides {
  severity: Severity;
  owner: string;
  enabled: boolean;
  numbers: Partial<Record<NumberKey, number>>;
}

export interface EnvironmentOverridesFieldsProps {
  rows: OverrideFormValues[];
  onRowChange: (index: number, row: OverrideFormValues) => void;
  /** Rule issues by environment label. */
  issues: Record<string, EnvironmentIssues>;
  job: JobSettingsForOverrides;
}

/** The visible label, and the unit only assistive tech hears (the placeholder shows the number). */
const NUMBER_LABELS: Record<NumberKey, [string, string]> = {
  max_gap_minutes: ["Max gap", " (minutes)"],
  max_runtime_minutes: ["Max runtime", " (minutes)"],
  max_retries: ["Max retries", ""],
  min_attempt_minutes: ["Min attempt", " (minutes)"],
};

const SUMMARY_NAMES: Record<NumberKey, string> = {
  max_gap_minutes: "max gap",
  max_runtime_minutes: "max runtime",
  max_retries: "max retries",
  min_attempt_minutes: "min attempt",
};

/** "severity WARNING, enabled off", or null when the row changes nothing. */
function summaryOf(row: OverrideFormValues): string | null {
  const parts: string[] = [];
  if (row.severity !== INHERIT) parts.push(`severity ${row.severity}`);
  if (row.enabled !== INHERIT) parts.push(`enabled ${row.enabled}`);
  if (row.owner.trim() !== "") parts.push(`owner ${row.owner.trim()}`);
  for (const key of NUMBER_KEYS) if (row[key].trim() !== "") parts.push(`${SUMMARY_NAMES[key]} ${row[key].trim()}`);
  if (row.job_ids.length > 0) parts.push(row.job_ids.length === 1 ? "1 job ID" : `${row.job_ids.length} job IDs`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function issueCount(issues: EnvironmentIssues | undefined): number {
  if (!issues) return 0;
  return issues.label.length + Object.values(issues.fields).reduce((n, list) => n + list.length, 0);
}

/** "Severity" on screen, "Severity in lower" for assistive tech, so each environment's fields have their own name. */
function InLabel({ text, label, unit = "" }: { text: string; label: string; unit?: string }) {
  return (
    <>
      {text}
      <span className="sr-only">
        {unit} in {label}
      </span>
    </>
  );
}

/**
 * The settings a job changes in one environment, one collapsible row per
 * workspace label. An empty field keeps the job's own setting there.
 */
export function EnvironmentOverridesFields({ rows, onRowChange, issues, job }: EnvironmentOverridesFieldsProps) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No workspace labels yet. Add labels such as production or lower on the Defaults and workspace labels page, then change settings for
        one environment here.
      </p>
    );
  }
  return (
    <div className="divide-y divide-border rounded-md border border-border">
      {rows.map((row, index) => (
        <OverrideRow key={row.label} row={row} issues={issues[row.label]} job={job} onChange={(next) => onRowChange(index, next)} />
      ))}
    </div>
  );
}

interface OverrideRowProps {
  row: OverrideFormValues;
  issues: EnvironmentIssues | undefined;
  job: JobSettingsForOverrides;
  onChange: (row: OverrideFormValues) => void;
}

function OverrideRow({ row, issues, job, onChange }: OverrideRowProps) {
  const summary = summaryOf(row);
  const problems = issueCount(issues);
  const set = <K extends keyof OverrideFormValues>(key: K, value: OverrideFormValues[K]) => onChange({ ...row, [key]: value });
  const errors = (key: string) => issues?.fields[key] ?? [];

  return (
    <Collapsible defaultOpen={summary !== null || problems > 0} className="group/row">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/row:rotate-90"
          aria-hidden="true"
        />
        <span className="font-mono text-[13px] font-medium text-foreground">{row.label}</span>
        <span className={cn("min-w-0 flex-1 truncate text-xs", summary ? "text-foreground" : "text-muted-foreground")}>
          {summary ?? "Same as the job"}
        </span>
        {problems > 0 ? (
          <span className="rounded-full bg-destructive px-1.5 text-[11px] leading-4 font-medium text-white">
            {problems === 1 ? "1 problem" : `${problems} problems`}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pt-1 pb-4">
        {issues && issues.label.length > 0 ? (
          <div className="mb-3 grid gap-0.5 text-xs text-destructive">
            {issues.label.map((message) => (
              <p key={message} className="leading-4">
                {message}
              </p>
            ))}
          </div>
        ) : null}
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
          <FormRow label={<InLabel text="Severity" label={row.label} />} yamlKey="severity" errors={errors("severity")}>
            {(control) => (
              <Select
                value={row.severity}
                onValueChange={(value) => set("severity", value === INHERIT ? INHERIT : (SEVERITIES.find((s) => s === value) ?? INHERIT))}
              >
                <SelectTrigger {...control} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>As the job ({job.severity})</SelectItem>
                  {SEVERITIES.map((severity) => (
                    <SelectItem key={severity} value={severity}>
                      {severity}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormRow>
          <FormRow label={<InLabel text="Enabled" label={row.label} />} yamlKey="enabled" errors={errors("enabled")}>
            {(control) => (
              <Select value={row.enabled} onValueChange={(value) => set("enabled", value === "on" || value === "off" ? value : INHERIT)}>
                <SelectTrigger {...control} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>As the job ({job.enabled ? "on" : "off"})</SelectItem>
                  <SelectItem value="on">On</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormRow>
          <FormRow label={<InLabel text="Owner" label={row.label} />} yamlKey="owner" errors={errors("owner")}>
            {(control) => (
              <Input
                {...control}
                value={row.owner}
                placeholder={job.owner ? `As the job (${job.owner})` : "As the job"}
                onChange={(event) => set("owner", event.target.value)}
              />
            )}
          </FormRow>
          {NUMBER_KEYS.map((key) => (
            <FormRow
              key={key}
              label={<InLabel text={NUMBER_LABELS[key][0]} unit={NUMBER_LABELS[key][1]} label={row.label} />}
              yamlKey={key}
              errors={errors(key)}
            >
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  className="font-mono"
                  value={row[key]}
                  placeholder={job.numbers[key] === undefined ? "As the job" : `As the job (${job.numbers[key]})`}
                  onChange={(event) => set(key, event.target.value)}
                />
              )}
            </FormRow>
          ))}
          <FormRow
            className="sm:col-span-3"
            label={<InLabel text="Job IDs" label={row.label} />}
            yamlKey="job_ids"
            description="The jobs to check by ID in this environment, in place of the job's own IDs or its name pattern."
            errors={errors("job_ids")}
          >
            {(control) => <JobIdsInput {...control} value={row.job_ids} placeholder="As the job" onChange={(ids) => set("job_ids", ids)} />}
          </FormRow>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
