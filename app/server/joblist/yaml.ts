/**
 * Reading and writing the job list as a monitored-jobs YAML file. The reader
 * follows PyYAML's safe loader (its YAML 1.1 scalar types: `yes` is true and `y`
 * is text; merge keys work; an unknown tag is refused) so the file means the same
 * to the Python loader. One deliberate difference: a duplicate key is refused,
 * where PyYAML keeps the last value without a word. Job and workspace IDs keep
 * every digit.
 */
import { parseDocument, stringify } from "yaml";
import { normalizeDocument, toJobListDocument, validateDocument } from "../../shared/joblist/rules";
import { pythonYamlOptions, pythonYamlWriteTags } from "../../shared/joblist/yamlOptions";
import type { JobListDocument, RuleIssue } from "../../shared/joblist/types";

export class YamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YamlError";
  }
}

export interface ReadResult {
  /** The document as it would be stored: IDs are strings. */
  document: JobListDocument;
  /** Rule issues found in the raw parse, with Python's message text. Empty when valid. */
  issues: RuleIssue[];
}

/** A YAML mapping: a plain object, not an array or a marker such as a timestamp. */
function isMap(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Parses the text, checks the rules on the raw values, then normalizes for storage. Throws YamlError on bad YAML. */
export function readJobListYaml(text: string, source = "the YAML file"): ReadResult {
  const parsed = parseDocument(text, { ...pythonYamlOptions, uniqueKeys: true });
  // An unknown tag is only a warning to the yaml library; PyYAML's safe loader refuses the file.
  const first = parsed.errors[0] ?? parsed.warnings.find((warning) => warning.code === "TAG_RESOLVE_FAILED");
  if (first) throw new YamlError(first.message);
  let raw: unknown;
  try {
    raw = parsed.toJS();
  } catch (error) {
    // The yaml library refuses a file whose aliases expand past its limit (an alias bomb) with a ReferenceError
    // that says "Excessive alias count". Any other error is not the file's fault and stays a server error.
    if (error instanceof ReferenceError && /alias count/i.test(error.message)) throw new YamlError("The YAML file uses too many aliases.");
    throw error;
  }
  if (!isMap(raw)) throw new YamlError(`${source} must contain a YAML mapping at the top level`);
  const issues = validateDocument(raw, source);
  return { document: toJobListDocument(normalizeDocument(raw)), issues };
}

/** The stored document for a YAML text. Throws YamlError on bad YAML; rule problems are not checked here. */
export function parseJobListYaml(text: string): JobListDocument {
  return readJobListYaml(text).document;
}

const JOB_KEY_ORDER = [
  "job_name", "job_name_regex", "job_name_exclude_regex", "job_ids", "schedule_type", "max_gap_minutes",
  "max_runtime_minutes", "max_retries", "min_attempt_minutes", "severity", "owner", "enabled", "notes",
  "environments",
];
const DEFAULT_KEY_ORDER = JOB_KEY_ORDER.filter((k) => !["job_name", "job_name_regex", "job_ids", "environments"].includes(k));
const ENV_KEY_ORDER = ["severity", "owner", "enabled", "max_gap_minutes", "max_runtime_minutes", "max_retries", "min_attempt_minutes", "job_ids"];
const WORKSPACE_KEY_ORDER = ["workspace_id", "workspace_name", "environment", "notes"];
const DEPENDENCY_KEY_ORDER = ["job_name", "depends_on", "dependency_type", "notes"];

function ordered(entry: object, order: string[]): Record<string, unknown> {
  const source = Object.fromEntries(Object.entries(entry));
  const out: Record<string, unknown> = {};
  for (const key of order) if (source[key] !== undefined) out[key] = source[key];
  for (const key of Object.keys(source)) if (!(key in out) && source[key] !== undefined) out[key] = source[key];
  return out;
}

function orderedJob(job: object): Record<string, unknown> {
  const out = ordered(job, JOB_KEY_ORDER);
  const envs = out.environments;
  if (isMap(envs)) {
    out.environments = Object.fromEntries(Object.entries(envs).map(([label, values]) => [label, isMap(values) ? ordered(values, ENV_KEY_ORDER) : values]));
  }
  return out;
}

export interface ExportMeta { version: number; savedAt: string; savedBy: string }

/** The job list as YAML, sections in the order defaults, workspaces, jobs, dependencies. Comments are not kept. */
export function toJobListYaml(doc: JobListDocument, meta: ExportMeta): string {
  const body: Record<string, unknown> = {};
  if (doc.defaults && Object.keys(doc.defaults).length > 0) body.defaults = ordered(doc.defaults, DEFAULT_KEY_ORDER);
  if (doc.workspaces && doc.workspaces.length > 0) body.workspaces = doc.workspaces.map((w) => ordered(w, WORKSPACE_KEY_ORDER));
  body.jobs = doc.jobs.map(orderedJob);
  if (doc.dependencies && doc.dependencies.length > 0) body.dependencies = doc.dependencies.map((d) => ordered(d, DEPENDENCY_KEY_ORDER));
  const header = `# Exported from the Watchdog app: version ${meta.version}, saved ${meta.savedAt} by ${meta.savedBy}\n`;
  return header + stringify(body, { version: "1.1", lineWidth: 0, customTags: pythonYamlWriteTags });
}
