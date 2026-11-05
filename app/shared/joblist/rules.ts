/**
 * The job-list rules, ported from jobs_watchdog/config.py (parse_monitored_jobs
 * and parse_monitored_workspaces). The checks run in Python's order and use
 * Python's message text, so the first issue is the error Python raises. Unlike
 * Python, all issues are collected, so the form can show every problem.
 *
 * Patterns are checked with a port of Python's own re parser (pyregex.ts). The
 * scan's serverless Python may be any version from 3.10 to 3.14, so a pattern
 * passes only when all of them compile it, with Python's message.
 *
 * Differences that cannot be avoided in JavaScript:
 * - A \N{...} character name in a pattern is refused: the app has no Unicode name database to look it up.
 * - A float with no fraction (60.0) is told apart from 60 only if the YAML was
 *   parsed with pythonYamlOptions, which marks it with PyFloat; the rules reject the marker.
 * - Deliberate divergence: a count setting (max_gap_minutes and the like) above 9007199254740991
 *   is rejected as too large, because it could not be stored as a number; Python has no limit.
 *   IDs (job_ids, workspace_id) are strings of any length.
 * - A section that is not a list gets the issue "X must be a list". This wording differs from the Python
 *   loader on purpose: Python fails with an unrelated error there, and the form needs a message that names the section.
 * - The YAML reader refuses a file with a duplicate key (PyYAML keeps the last one), so a
 *   mistake is shown rather than dropped silently.
 * - Environment labels that YAML reads as true, false or null become "true", "false" and ""
 *   in JavaScript, where Python's str() gives "True", "False" and "None".
 * The rules accept the raw parse (integers as bigint, floats and timestamps marked), so
 * messages print values the way Python does; normalizeDocument is for storage afterwards.
 */
import { pythonRegexError } from "./pyregex";
import { PyFloat, pyRepr, pySorted, pyStr, pyStrip } from "./pyrepr";
import type { Change, JobListDocument, RuleIssue } from "./types";

type Obj = Record<string, unknown>;

const SCHEDULE_TYPES = ["continuous", "scheduled", "triggered"];
const SEVERITIES = ["CRITICAL", "WARNING"];
const DEPENDENCY_TYPES = ["child_job", "job", "service"];
const JOB_KEYS = [
  "job_name", "job_name_regex", "job_name_exclude_regex", "schedule_type", "max_gap_minutes",
  "max_runtime_minutes", "max_retries", "min_attempt_minutes", "severity", "owner", "enabled", "notes",
  "environments", "job_ids",
];
const NOT_IN_DEFAULTS = ["job_name", "job_name_regex", "environments", "job_ids"];
const DEFAULT_KEYS = JOB_KEYS.filter((k) => !NOT_IN_DEFAULTS.includes(k));
const OVERRIDE_KEYS = [
  "severity", "owner", "enabled", "max_gap_minutes", "max_runtime_minutes", "max_retries",
  "min_attempt_minutes", "job_ids",
];

/** A YAML mapping or a JSON object: a plain object, never an array or a marker such as PyFloat. */
function isMap(value: unknown): value is Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function has(obj: Obj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function get(obj: Obj, key: string): unknown {
  return has(obj, key) ? obj[key] : undefined;
}

/** Python truthiness for the values a YAML document holds. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === 0n || value === "") return false;
  if (value instanceof PyFloat) return value.value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isMap(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python's int: a whole number or a bigint, never a boolean or a marked float. */
function isWholeNumber(value: unknown): value is number | bigint {
  return typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value));
}

function isDigits(text: string): boolean {
  return /^[0-9]+$/.test(text);
}

// ---------------------------------------------------------------------------
// normalizeDocument

function convert(value: unknown, asId: boolean): unknown {
  if (typeof value === "bigint") {
    if (asId) return value.toString();
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof PyFloat) return value.value;
  if (asId && typeof value === "number" && Number.isInteger(value)) return String(value);
  if (Array.isArray(value)) return value.map((item) => convert(item, asId));
  if (isMap(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, convert(v, k === "job_ids" || k === "workspace_id")]),
    );
  }
  return value;
}

/*
 * Text fields, stored the way the Python loader reads them. The loader reads
 * names, owners and notes with str(), so YAML that gives a number, a boolean
 * or a date there is valid, and the app stores the text Python reads: the job
 * name 20241105 is "20241105" and notes: true is "True". Each rule keeps
 * config.py's own reading, its `or ""` included. A value the loader refuses
 * is left alone: the rules report it, and nothing invalid is stored. These
 * run on the raw parse, so floats and timestamps print as Python prints them.
 */
type TextRule = (value: unknown) => unknown;

/** str(value or ""), for owner and notes, and a link's names. None stays None: it means the same. */
const orEmpty: TextRule = (value) => value === null || value === undefined || typeof value === "string" ? value : truthy(value) ? pyStr(value) : "";
/** str(value) unless it is None or "", for job_name_exclude_regex and workspace_name. */
const unlessEmpty: TextRule = (value) => value === null || value === undefined || typeof value === "string" ? value : pyStr(value);
/** str(value), for job_name and a workspace's environment, which must not be empty. */
const whenSet: TextRule = (value) => typeof value === "string" || !truthy(value) ? value : pyStr(value);
/** job_name_regex: any empty value means "^<name>$", so it is stored as "". Any other non-text value is refused. */
const pattern: TextRule = (value) => typeof value === "string" || value === null || value === undefined || truthy(value) ? value : "";

const JOB_TEXT: Record<string, TextRule> = {
  job_name: whenSet, job_name_regex: pattern, job_name_exclude_regex: unlessEmpty, owner: orEmpty, notes: orEmpty,
};
const DEFAULTS_TEXT: Record<string, TextRule> = { job_name_exclude_regex: unlessEmpty, owner: orEmpty, notes: orEmpty };
const OVERRIDE_TEXT: Record<string, TextRule> = { owner: orEmpty };
const WORKSPACE_TEXT: Record<string, TextRule> = { workspace_name: unlessEmpty, environment: whenSet, notes: orEmpty };
const DEPENDENCY_TEXT: Record<string, TextRule> = { job_name: orEmpty, depends_on: orEmpty, notes: orEmpty };

function withText(entry: unknown, rules: Record<string, TextRule>): unknown {
  if (!isMap(entry)) return entry;
  const out: Obj = { ...entry };
  for (const [key, rule] of Object.entries(rules)) if (has(out, key)) out[key] = rule(out[key]);
  return out;
}

/** Python reads each job ID as str(value).strip() and keeps that text. */
function jobIdsText(entry: unknown): unknown {
  if (!isMap(entry) || !Array.isArray(entry.job_ids)) return entry;
  return { ...entry, job_ids: entry.job_ids.map((id: unknown) => (typeof id === "string" ? pyStrip(id) : id)) };
}

function jobText(entry: unknown): unknown {
  const out = jobIdsText(withText(entry, JOB_TEXT));
  if (!isMap(out) || !isMap(out.environments)) return out;
  const environments = Object.fromEntries(
    Object.entries(out.environments).map(([label, values]) => [label, jobIdsText(withText(values, OVERRIDE_TEXT))]),
  );
  return { ...out, environments };
}

const ENTRY_TEXT: Record<string, (entry: unknown) => unknown> = {
  job: jobText,
  defaults: (entry) => withText(entry, DEFAULTS_TEXT),
  workspace: (entry) => withText(entry, WORKSPACE_TEXT),
  dependency: (entry) => withText(entry, DEPENDENCY_TEXT),
};

function sectionText(value: unknown, entry: (item: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map(entry) : value;
}

/**
 * The job list as it is stored: job and workspace IDs become strings, other big
 * integers become numbers when safe, else strings, and text fields hold the text
 * the Python loader reads. Running it twice changes nothing more.
 */
export function normalizeDocument(raw: Record<string, unknown>): Record<string, unknown> {
  const text: Obj = { ...raw };
  if (has(text, "defaults")) text.defaults = ENTRY_TEXT.defaults(text.defaults);
  if (has(text, "workspaces")) text.workspaces = sectionText(text.workspaces, ENTRY_TEXT.workspace);
  if (has(text, "jobs")) text.jobs = sectionText(text.jobs, ENTRY_TEXT.job);
  if (has(text, "dependencies")) text.dependencies = sectionText(text.dependencies, ENTRY_TEXT.dependency);
  const out = convert(text, false);
  return isMap(out) ? out : {};
}

/** The four sections of a normalized document, typed. The rules check the contents when the list is saved. */
export function toJobListDocument(normalized: Record<string, unknown>): JobListDocument {
  const { defaults, workspaces, jobs, dependencies } = normalized;
  return {
    ...(isMap(defaults) && Object.keys(defaults).length > 0 ? { defaults: defaults as JobListDocument["defaults"] } : {}),
    ...(Array.isArray(workspaces) ? { workspaces: workspaces as JobListDocument["workspaces"] } : {}),
    jobs: Array.isArray(jobs) ? (jobs as JobListDocument["jobs"]) : [],
    ...(Array.isArray(dependencies) ? { dependencies: dependencies as JobListDocument["dependencies"] } : {}),
  };
}

/** A stored job list in its stored form. Versions an older app saved may hold numbers or booleans in text fields. */
export function storedDocument(doc: JobListDocument): JobListDocument {
  return toJobListDocument(normalizeDocument({ ...doc }));
}

/** A change with its entry in the stored form, so a job named 2024 in the request is the job "2024". */
export function storedChange(change: Change): Change {
  if (change.kind === "delete") return change;
  const value = convert(ENTRY_TEXT[change.target.type](change.value), false);
  return { ...change, value: value as typeof change.value };
}

// ---------------------------------------------------------------------------
// validateDocument

class Collector {
  readonly issues: RuleIssue[] = [];
  add(path: string, message: string): void {
    this.issues.push({ path, message });
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function optionalInt(c: Collector, path: string, raw: unknown, jobName: string, field: string): void {
  if (raw === null || raw === undefined) return;
  // a bigint from the raw parse, or the string normalizeDocument made of one
  const big = typeof raw === "bigint" ? raw : typeof raw === "string" && /^[0-9]+$/.test(raw) ? BigInt(raw) : null;
  if (big !== null && big > MAX_SAFE) {
    c.add(path, `job ${jobName}: ${field} is too large (at most ${Number.MAX_SAFE_INTEGER}), got ${big}`);
    return;
  }
  if (typeof raw === "boolean" || !isWholeNumber(raw) || raw < 0) {
    c.add(path, `job ${jobName}: ${field} must be a whole number of zero or more, got ${pyRepr(raw)}`);
  }
}

/** re.compile(raw), as the loader runs it: Python's own message when it fails. */
function compiled(c: Collector, path: string, raw: unknown, name: string, field: string): void {
  const error = typeof raw === "string" ? pythonRegexError(raw) : "first argument must be string or compiled pattern";
  if (error !== null) c.add(path, `job ${name}: ${field} does not compile: ${error}`);
}

function checkJobIds(c: Collector, path: string, raw: unknown, where: string): void {
  if (!Array.isArray(raw) || raw.length === 0) {
    c.add(path, `${where}: job_ids must be a list of one or more job IDs, got ${pyRepr(raw)}`);
    return;
  }
  const seen: string[] = [];
  for (const value of raw) {
    if (typeof value === "boolean" || (typeof value !== "string" && !isWholeNumber(value))) {
      c.add(path, `${where}: job_ids must be whole numbers, got ${pyRepr(value)}`);
      return;
    }
    const text = String(value).trim();
    if (!isDigits(text)) {
      c.add(path, `${where}: job_ids must be whole numbers, got ${pyRepr(value)}`);
      return;
    }
    if (seen.includes(text)) {
      c.add(path, `${where}: job ID ${text} is listed twice`);
      return;
    }
    seen.push(text);
  }
}

function checkSeverity(c: Collector, path: string, value: unknown, where: string): void {
  if (typeof value !== "string" || !SEVERITIES.includes(value)) {
    c.add(path, `${where}: severity must be one of ${pyRepr(SEVERITIES)}, got ${pyRepr(value)}`);
  }
}

function checkEnabled(c: Collector, path: string, value: unknown, where: string): void {
  if (typeof value !== "boolean") c.add(path, `${where}: enabled must be true or false, got ${pyRepr(value)}`);
}

function parseDefaults(c: Collector, raw: unknown): Obj {
  if (raw === null || raw === undefined || (isMap(raw) && Object.keys(raw).length === 0)) return {};
  if (!isMap(raw)) {
    c.add("defaults", `defaults must be a mapping of job settings, got ${pyRepr(raw)}`);
    return {};
  }
  for (const key of Object.keys(raw)) {
    if (NOT_IN_DEFAULTS.includes(key) || key === "job_name") {
      c.add(`defaults.${key}`, `defaults cannot set ${key}: set it on each job`);
    }
  }
  const unknown = pySorted(Object.keys(raw).filter((k) => !DEFAULT_KEYS.includes(k)));
  if (unknown.length > 0) {
    c.add("defaults", `defaults has unknown keys ${pyRepr(unknown)}; allowed: ${pyRepr(pySorted(DEFAULT_KEYS))}`);
  }
  return raw;
}

interface ParsedWorkspace { id: string | null; name: string | null; index: number }

function parseWorkspace(c: Collector, raw: unknown, index: number): ParsedWorkspace | null {
  const at = `workspaces[${index}]`;
  if (!isMap(raw)) {
    c.add(at, `every workspace entry must be a mapping, got ${pyRepr(raw)}`);
    return null;
  }
  const rawId = get(raw, "workspace_id");
  const rawName = get(raw, "workspace_name");
  const id = rawId === null || rawId === undefined || rawId === "" ? null : pyStr(rawId);
  const name = rawName === null || rawName === undefined || rawName === "" ? null : pyStr(rawName);
  const label = id || name;
  if (label === null || label === "") {
    c.add(at, `workspace entry ${pyRepr(raw)}: set workspace_id or workspace_name`);
    return null;
  }
  let ok = true;
  if (id !== null && !isDigits(id)) {
    c.add(`${at}.workspace_id`, `workspace ${label}: workspace_id must be digits, got ${pyRepr(id)}`);
    ok = false;
  }
  const environment = get(raw, "environment");
  if (!truthy(environment)) {
    c.add(`${at}.environment`, `workspace ${label}: environment is required, for example production or lower`);
    ok = false;
  } else if (!/^[A-Za-z0-9_-]+$/.test(pyStr(environment))) {
    c.add(`${at}.environment`, `workspace ${label}: environment must be letters, digits, - or _, got ${pyRepr(environment)}`);
    ok = false;
  }
  return ok ? { id, name, index } : null;
}

function parseEnvironments(c: Collector, base: string, raw: unknown, name: string, labels: Set<string>): Obj {
  const parsed: Obj = {};
  if (raw === null || raw === undefined || (isMap(raw) && Object.keys(raw).length === 0)) return parsed;
  if (!isMap(raw)) {
    c.add(`${base}.environments`, `job ${name}: environments must be a mapping of environment label to settings`);
    return parsed;
  }
  for (const [label, overrides] of Object.entries(raw)) {
    const path = `${base}.environments.${label}`;
    const where = `job ${name}: environments.${label}`;
    if (!labels.has(label)) {
      const defined = pySorted(labels).join(", ") || "none defined";
      c.add(path, `job ${name}: environment ${pyRepr(label)} is not a label in the workspaces section (${defined})`);
      continue;
    }
    if (!isMap(overrides)) {
      c.add(path, `${where} must be a mapping such as {severity: WARNING}, got ${pyRepr(overrides)}`);
      continue;
    }
    const unknown = pySorted(Object.keys(overrides).filter((k) => !OVERRIDE_KEYS.includes(k)));
    if (unknown.length > 0) {
      c.add(path, `${where} has unknown keys ${pyRepr(unknown)}; allowed: ${pyRepr(OVERRIDE_KEYS)}`);
      continue;
    }
    const values: Obj = {};
    for (const [key, value] of Object.entries(overrides)) {
      const keyPath = `${path}.${key}`;
      if (key === "severity") checkSeverity(c, keyPath, value, where);
      else if (key === "enabled") checkEnabled(c, keyPath, value, where);
      else if (key === "job_ids") checkJobIds(c, keyPath, value, where);
      else if (key !== "owner") optionalInt(c, keyPath, value, name, `environments.${label}.${key}`);
      values[key] = value;
    }
    parsed[label] = values;
  }
  return parsed;
}

function parseJob(c: Collector, raw: unknown, index: number, defaults: Obj, labels: Set<string>): string | null {
  if (!isMap(raw) || !truthy(get(raw, "job_name"))) {
    c.add(`jobs[${index}]`, `every job needs a job_name, got ${pyRepr(raw)}`);
    return null;
  }
  const name = pyStr(raw.job_name);
  const base = `jobs[${name}]`;
  const unknown = pySorted(Object.keys(raw).filter((k) => !JOB_KEYS.includes(k)));
  if (unknown.length > 0) {
    c.add(base, `job ${name}: unknown keys ${pyRepr(unknown)}; allowed: ${pyRepr(pySorted(JOB_KEYS))}`);
  }
  const environments = parseEnvironments(c, base, get(raw, "environments"), name, labels);
  const own = raw;
  const jobIds = get(raw, "job_ids");
  if (jobIds !== null && jobIds !== undefined) checkJobIds(c, `${base}.job_ids`, jobIds, `job ${name}`);
  const merged: Obj = { ...defaults, ...raw };

  const regex = merged.job_name_regex;
  if (truthy(regex)) compiled(c, `${base}.job_name_regex`, regex, name, "job_name_regex");
  const exclude = merged.job_name_exclude_regex;
  if (exclude !== null && exclude !== undefined && exclude !== "") {
    compiled(c, `${base}.job_name_exclude_regex`, pyStr(exclude), name, "job_name_exclude_regex");
  }
  checkEnabled(c, `${base}.enabled`, has(merged, "enabled") ? merged.enabled : true, `job ${name}`);

  const scheduleType = has(merged, "schedule_type") ? merged.schedule_type : "scheduled";
  const scheduleOk = typeof scheduleType === "string" && SCHEDULE_TYPES.includes(scheduleType);
  if (!scheduleOk) {
    c.add(`${base}.schedule_type`, `job ${name}: schedule_type must be one of ${pyRepr(SCHEDULE_TYPES)}, got ${pyRepr(scheduleType)}`);
  }
  checkSeverity(c, `${base}.severity`, has(merged, "severity") ? merged.severity : "WARNING", `job ${name}`);
  const maxGap = get(merged, "max_gap_minutes");
  optionalInt(c, `${base}.max_gap_minutes`, maxGap, name, "max_gap_minutes");
  if (scheduleType === "scheduled" && (maxGap === null || maxGap === undefined)) {
    c.add(`${base}.max_gap_minutes`, `job ${name}: scheduled jobs need max_gap_minutes`);
  }
  // Python checks a continuous job's own max_gap_minutes a second time. The merged check above already covers
  // it (the job's own value wins over defaults), so the same issue is not emitted twice.
  if (scheduleType === "triggered") {
    const gapLabels = pySorted(Object.keys(environments).filter((label) => {
      const values = environments[label];
      return isMap(values) && has(values, "max_gap_minutes");
    }));
    if (has(own, "max_gap_minutes") || gapLabels.length > 0) {
      const where = gapLabels.length > 0 ? ` (environments ${gapLabels.join(", ")})` : "";
      c.add(`${base}.max_gap_minutes`, `job ${name}: triggered jobs have no schedule check, so remove max_gap_minutes${where}`);
    }
  }
  for (const field of ["max_runtime_minutes", "max_retries", "min_attempt_minutes"]) {
    optionalInt(c, `${base}.${field}`, get(merged, field), name, field);
  }
  return name;
}

function checkDependency(c: Collector, raw: unknown, index: number, jobNames: Set<string>): { job: string; on: string; type: string } | null {
  if (!isMap(raw)) {
    c.add(`dependencies[${index}]`, `every dependency must be a mapping, got ${pyRepr(raw)}`);
    return null;
  }
  const jobName = truthy(raw.job_name) ? pyStr(raw.job_name) : "";
  const dependsOn = truthy(raw.depends_on) ? pyStr(raw.depends_on) : "";
  const type = has(raw, "dependency_type") ? raw.dependency_type : "job";
  const label = `dependency ${jobName} -> ${dependsOn}`;
  const typeText = typeof type === "string" ? type : pyStr(type);
  const at = jobName && dependsOn ? `dependencies[${jobName}->${dependsOn}:${typeText}]` : `dependencies[${index}]`;
  if (!jobName || !dependsOn) {
    c.add(at, `${label}: job_name and depends_on are both required`);
    return null;
  }
  if (typeof type !== "string" || !DEPENDENCY_TYPES.includes(type)) {
    c.add(at, `${label}: dependency_type must be one of ${pyRepr(DEPENDENCY_TYPES)}, got ${pyRepr(type)}`);
    return null;
  }
  if (!jobNames.has(jobName)) {
    c.add(at, `${label}: ${jobName} is not a configured job`);
    return null;
  }
  if ((type === "job" || type === "child_job") && !jobNames.has(dependsOn)) {
    c.add(at, `${label}: ${dependsOn} is not a configured job (use dependency_type: service for services)`);
    return null;
  }
  return { job: jobName, on: dependsOn, type };
}

function section(c: Collector, data: Obj, key: string): unknown[] {
  const raw = get(data, key);
  if (!truthy(raw)) return [];
  if (!Array.isArray(raw)) {
    c.add(key, `${key} must be a list, got ${pyRepr(raw)}`);
    return [];
  }
  return raw;
}

/** The issues in a job list; empty when it is valid. The first one is the error Python raises. */
export function validateDocument(doc: unknown, source = "the job list"): RuleIssue[] {
  const c = new Collector();
  if (!isMap(doc)) {
    c.add("", `${source} must contain a YAML mapping at the top level`);
    return c.issues;
  }
  const defaults = parseDefaults(c, get(doc, "defaults"));
  const workspaces = section(c, doc, "workspaces");
  const labels = new Set<string>();
  const parsedWorkspaces: ParsedWorkspace[] = [];
  workspaces.forEach((raw, index) => {
    const parsed = parseWorkspace(c, raw, index);
    if (parsed) parsedWorkspaces.push(parsed);
    if (isMap(raw) && truthy(raw.environment)) labels.add(pyStr(raw.environment));
  });

  const jobs = section(c, doc, "jobs");
  const names: string[] = [];
  jobs.forEach((raw, index) => {
    const name = parseJob(c, raw, index, defaults, labels);
    if (name !== null) names.push(name);
  });
  if (jobs.length === 0) c.add("jobs", `${source} lists no jobs`);
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) c.add(`jobs[${name}]`, `duplicate job_name ${pyRepr(name)} in ${source}`);
    seen.add(name);
  }

  // Python reads every link first and looks for a second parent after, so a bad link is reported first.
  const deps = section(c, doc, "dependencies").map((raw, index) => checkDependency(c, raw, index, seen));
  const parents = new Map<string, string>();
  for (const dep of deps) {
    if (dep === null || dep.type !== "child_job") continue;
    const parent = parents.get(dep.job);
    if (parent !== undefined && parent !== dep.on) {
      c.add(`dependencies[${dep.job}->${dep.on}:child_job]`,
        `job ${dep.job} is a child_job of both ${parent} and ${dep.on}; a job can have only one parent`);
    }
    parents.set(dep.job, dep.on);
  }

  const keys = new Set<string>();
  parsedWorkspaces.forEach((workspace) => {
    for (const [kind, value] of [["id", workspace.id], ["name", workspace.name?.toLowerCase() ?? null]] as const) {
      if (value === null) continue;
      if (keys.has(`${kind}:${value}`)) c.add(`workspaces[${workspace.index}]`, `workspace ${value} is listed twice in ${source}`);
      keys.add(`${kind}:${value}`);
    }
  });
  return c.issues;
}
