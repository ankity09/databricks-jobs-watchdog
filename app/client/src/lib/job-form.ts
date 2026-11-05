import type { EnvironmentOverrides, JobEntry, JobListDocument, ScheduleType, Severity } from "../../../shared/joblist/types";

/**
 * The job editor's form values, and the conversion to and from a JobEntry.
 *
 * Inputs hold strings. An empty field means the key is not set, so the
 * default applies. One rule keeps an edit from changing what the scan reads:
 * a field that is still empty keeps the saved value when that value was null
 * or "", because in the YAML loader such a value blocks the default (for
 * example `max_runtime_minutes: null` turns off a default runtime limit).
 */

export const INHERIT = "inherit";
export type Inherit = typeof INHERIT;

export const SCHEDULE_TYPES: readonly ScheduleType[] = ["scheduled", "continuous", "triggered"];
export const SEVERITIES: readonly Severity[] = ["CRITICAL", "WARNING"];
export const NUMBER_KEYS = ["max_gap_minutes", "max_runtime_minutes", "max_retries", "min_attempt_minutes"] as const;
export type NumberKey = (typeof NUMBER_KEYS)[number];

export interface OverrideFormValues {
  /** The environment label this row is for; not editable. */
  label: string;
  severity: Inherit | Severity;
  owner: string;
  enabled: Inherit | "on" | "off";
  max_gap_minutes: string;
  max_runtime_minutes: string;
  max_retries: string;
  min_attempt_minutes: string;
  job_ids: string[];
}

export interface JobFormValues {
  job_name: string;
  job_name_regex: string;
  job_name_exclude_regex: string;
  /** No exclusion for this job, even when the defaults set one. Stored as null. */
  exclude_off: boolean;
  job_ids: string[];
  schedule_type: Inherit | ScheduleType;
  max_gap_minutes: string;
  max_runtime_minutes: string;
  max_retries: string;
  min_attempt_minutes: string;
  severity: Inherit | Severity;
  owner: string;
  /** null: the job does not set it, so the default applies. */
  enabled: boolean | null;
  notes: string;
  environments: OverrideFormValues[];
}

function isSeverity(value: unknown): value is Severity {
  return value === "CRITICAL" || value === "WARNING";
}

function isScheduleType(value: unknown): value is ScheduleType {
  return value === "scheduled" || value === "continuous" || value === "triggered";
}

/** A stored value as input text. The document is checked for structure only, so any type can arrive. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return "";
}

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asText).filter((id) => id !== "") : [];
}

/** Every workspace label once, in the order of the workspaces section, then any label the entry uses that is not defined. */
export function environmentLabels(document: JobListDocument, entry: JobEntry): string[] {
  const labels: string[] = [];
  for (const workspace of document.workspaces ?? []) {
    const label = asText(workspace?.environment);
    if (label !== "" && !labels.includes(label)) labels.push(label);
  }
  const own = entry.environments;
  if (own && typeof own === "object") {
    for (const label of Object.keys(own)) if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

function overrideValues(label: string, raw: unknown): OverrideFormValues {
  const o: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw)) : {};
  return {
    label,
    severity: isSeverity(o.severity) ? o.severity : INHERIT,
    owner: asText(o.owner),
    enabled: o.enabled === true ? "on" : o.enabled === false ? "off" : INHERIT,
    max_gap_minutes: asText(o.max_gap_minutes),
    max_runtime_minutes: asText(o.max_runtime_minutes),
    max_retries: asText(o.max_retries),
    min_attempt_minutes: asText(o.min_attempt_minutes),
    job_ids: asIds(o.job_ids),
  };
}

export function toFormValues(entry: JobEntry, labels: string[]): JobFormValues {
  const environments: Record<string, unknown> =
    entry.environments && typeof entry.environments === "object" ? { ...entry.environments } : {};
  const exclude: unknown = entry.job_name_exclude_regex;
  return {
    job_name: asText(entry.job_name),
    job_name_regex: asText(entry.job_name_regex),
    job_name_exclude_regex: asText(exclude),
    exclude_off: "job_name_exclude_regex" in entry && (exclude === null || exclude === ""),
    job_ids: asIds(entry.job_ids),
    schedule_type: isScheduleType(entry.schedule_type) ? entry.schedule_type : INHERIT,
    max_gap_minutes: asText(entry.max_gap_minutes),
    max_runtime_minutes: asText(entry.max_runtime_minutes),
    max_retries: asText(entry.max_retries),
    min_attempt_minutes: asText(entry.min_attempt_minutes),
    severity: isSeverity(entry.severity) ? entry.severity : INHERIT,
    owner: asText(entry.owner),
    enabled: typeof entry.enabled === "boolean" ? entry.enabled : null,
    notes: asText(entry.notes),
    environments: labels.map((label) => overrideValues(label, environments[label])),
  };
}

/** A number field: empty is unset; anything else is kept as the number typed, valid or not, for the rules to judge. */
function numberOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** True when the saved value blocks a default (null or ""), so an empty field keeps it. */
function blocksDefault(source: object, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(source, key)) return false;
  const value: unknown = Reflect.get(source, key);
  return value === null || value === "";
}

type OptionalKey = Exclude<keyof JobEntry, "job_name">;

/** Sets `key`, removes it when `value` is undefined, or keeps the saved value when it blocks a default. */
function put<K extends OptionalKey>(entry: JobEntry, base: JobEntry, key: K, value: JobEntry[K]): void {
  if (value !== undefined) entry[key] = value;
  else if (!blocksDefault(base, key)) delete entry[key];
}

function overrides(row: OverrideFormValues, saved: unknown): EnvironmentOverrides {
  const base: EnvironmentOverrides = saved && typeof saved === "object" && !Array.isArray(saved) ? { ...saved } : {};
  const next: EnvironmentOverrides = { ...base };
  const set = <K extends keyof EnvironmentOverrides>(key: K, value: EnvironmentOverrides[K]) => {
    if (value !== undefined) next[key] = value;
    else if (!blocksDefault(base, key)) delete next[key];
  };
  set("severity", row.severity === INHERIT ? undefined : row.severity);
  set("owner", row.owner.trim() === "" ? undefined : row.owner.trim());
  set("enabled", row.enabled === INHERIT ? undefined : row.enabled === "on");
  for (const key of NUMBER_KEYS) set(key, numberOf(row[key]));
  set("job_ids", row.job_ids.length > 0 ? [...row.job_ids] : undefined);
  return next;
}

/** The entry the form describes, built on `base` (the entry the editor opened with). */
export function toEntry(values: JobFormValues, base: JobEntry): JobEntry {
  const entry: JobEntry = { ...base, job_name: values.job_name.trim() };
  put(entry, base, "job_name_regex", values.job_name_regex === "" ? undefined : values.job_name_regex);
  // "No exclusion" is the checkbox, so an empty pattern without it means the default applies.
  if (values.exclude_off) entry.job_name_exclude_regex = base.job_name_exclude_regex === "" ? "" : null;
  else if (values.job_name_exclude_regex !== "") entry.job_name_exclude_regex = values.job_name_exclude_regex;
  else delete entry.job_name_exclude_regex;
  put(entry, base, "job_ids", values.job_ids.length > 0 ? [...values.job_ids] : undefined);
  put(entry, base, "schedule_type", values.schedule_type === INHERIT ? undefined : values.schedule_type);
  for (const key of NUMBER_KEYS) put(entry, base, key, numberOf(values[key]));
  put(entry, base, "severity", values.severity === INHERIT ? undefined : values.severity);
  put(entry, base, "owner", values.owner.trim() === "" ? undefined : values.owner.trim());
  put(entry, base, "enabled", values.enabled ?? undefined);
  put(entry, base, "notes", values.notes === "" ? undefined : values.notes);

  const saved: Record<string, unknown> = base.environments && typeof base.environments === "object" ? { ...base.environments } : {};
  const environments: Record<string, EnvironmentOverrides> = {};
  for (const row of values.environments) {
    const next = overrides(row, saved[row.label]);
    if (Object.keys(next).length > 0) environments[row.label] = next;
  }
  if (Object.keys(environments).length > 0) entry.environments = environments;
  else delete entry.environments;
  return entry;
}

/** What a job gets when it sets nothing itself: the defaults section, then the loader's built-in values. */
export interface InheritedSettings {
  schedule_type: ScheduleType;
  severity: Severity;
  owner: string;
  enabled: boolean;
  /** The default exclusion pattern, or null when there is none. */
  exclude: string | null;
  notes: string;
  numbers: Partial<Record<NumberKey, number>>;
}

export function inheritedSettings(document: JobListDocument): InheritedSettings {
  const d: Record<string, unknown> = document.defaults && typeof document.defaults === "object" ? { ...document.defaults } : {};
  const numbers: Partial<Record<NumberKey, number>> = {};
  for (const key of NUMBER_KEYS) {
    const value = d[key];
    if (typeof value === "number") numbers[key] = value;
  }
  const exclude = d.job_name_exclude_regex;
  return {
    schedule_type: isScheduleType(d.schedule_type) ? d.schedule_type : "scheduled",
    severity: isSeverity(d.severity) ? d.severity : "WARNING",
    owner: asText(d.owner),
    enabled: typeof d.enabled === "boolean" ? d.enabled : true,
    exclude: typeof exclude === "string" && exclude !== "" ? exclude : null,
    notes: asText(d.notes),
    numbers,
  };
}

/** Python's re.escape (3.7 and later), so a job with no pattern gets the same ^<name>$ the loader builds. */
export function pyReEscape(text: string): string {
  return text.replace(/[()[\]{}?*+\-|^$\\.&~# \t\n\r\v\f]/g, "\\$&");
}

/**
 * The name pattern and the exclusion the scan uses for an entry: its own, or
 * the ones it inherits. An entry with no pattern and no name yet has no
 * pattern (""), not ^$.
 */
export function effectivePatterns(entry: JobEntry, inherited: InheritedSettings): { pattern: string; exclude: string } {
  const own = typeof entry.job_name_regex === "string" && entry.job_name_regex !== "" ? entry.job_name_regex : null;
  const name = typeof entry.job_name === "string" ? entry.job_name : "";
  const pattern = own ?? (name.trim() === "" ? "" : `^${pyReEscape(name)}$`);
  const exclude =
    "job_name_exclude_regex" in entry
      ? typeof entry.job_name_exclude_regex === "string"
        ? entry.job_name_exclude_regex
        : ""
      : (inherited.exclude ?? "");
  return { pattern, exclude };
}

/** A form patch that sets one number field. */
export function numberPatch(name: NumberKey, text: string): Partial<JobFormValues> {
  switch (name) {
    case "max_gap_minutes":
      return { max_gap_minutes: text };
    case "max_runtime_minutes":
      return { max_runtime_minutes: text };
    case "max_retries":
      return { max_retries: text };
    case "min_attempt_minutes":
      return { min_attempt_minutes: text };
  }
}
