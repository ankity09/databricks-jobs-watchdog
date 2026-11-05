import { z } from "zod";
import { pyStr } from "../../../shared/joblist/pyrepr";
import type {
  Change,
  Impact,
  ImportPreview,
  JobEntry,
  JobListDocument,
  JobListState,
  SaveResult,
  VersionDetail,
  VersionSummary,
} from "../../../shared/joblist/types";
import { apiFetch } from "./api";

/**
 * One function per job list route (see the route contract). Each parses the
 * answer with a zod schema.
 *
 * A document is checked for its structure only: the server's rules decide
 * whether the values are valid. An import preview carries a document together
 * with the issues found in it, so a stricter check here would hide them.
 */
const DocumentStructure = z.looseObject({
  defaults: z.looseObject({}).optional(),
  workspaces: z.array(z.looseObject({})).optional(),
  jobs: z.array(z.looseObject({})),
  dependencies: z.array(z.looseObject({})).optional(),
});

/**
 * How the loader (jobs_watchdog/config.py) reads a text field:
 * - "str": str(value), for names, labels, IDs and the exclusion pattern;
 * - "or-empty": str(value or ""), for owners, notes and the name pattern, so
 *   false, 0, [] and {} read as "" (for the pattern: the default ^name$).
 */
type TextRule = "str" | "or-empty";

const DEFAULT_TEXT: Record<string, TextRule> = { owner: "or-empty", notes: "or-empty", job_name_exclude_regex: "str" };
const JOB_TEXT: Record<string, TextRule> = { ...DEFAULT_TEXT, job_name: "str", job_name_regex: "or-empty" };
const OVERRIDE_TEXT: Record<string, TextRule> = { owner: "or-empty" };
const WORKSPACE_TEXT: Record<string, TextRule> = { workspace_id: "str", workspace_name: "str", environment: "str", notes: "or-empty" };
const DEPENDENCY_TEXT: Record<string, TextRule> = { job_name: "or-empty", depends_on: "or-empty", notes: "or-empty" };

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python's truthiness for the values a stored document holds. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return !isMapping(value) || Object.keys(value).length > 0;
}

/** Text, null and a missing value stay as stored: null and "" switch a default off. Anything else is read as `rule` says. */
function asLoaderText(value: unknown, rule: TextRule): unknown {
  if (value === null || value === undefined || typeof value === "string") return value;
  if (rule === "str") return pyStr(value);
  return truthy(value) ? pyStr(value) : "";
}

/** A copy of `entry` with each text field in `rules` read as the loader reads it. */
function withText<T extends object>(entry: T, rules: Record<string, TextRule>): T {
  const read = { ...entry };
  for (const [key, rule] of Object.entries(rules)) {
    if (Object.prototype.hasOwnProperty.call(read, key)) Reflect.set(read, key, asLoaderText(Reflect.get(read, key), rule));
  }
  return read;
}

function jobWithText(job: JobEntry): JobEntry {
  if (!isMapping(job)) return job;
  const read = withText(job, JOB_TEXT);
  const environments = job.environments;
  if (isMapping(environments)) {
    read.environments = Object.fromEntries(
      Object.entries(environments).map(([label, overrides]) => [label, isMapping(overrides) ? withText(overrides, OVERRIDE_TEXT) : overrides]),
    );
  }
  return read;
}

/**
 * The document with each text field as the scan's loader reads it, through
 * Python's str(). Versions saved before the server stored text as text can
 * hold `job_name: 20241105` or `notes: true` as YAML parsed them, and the
 * pages read these fields as text. Other values stay as stored, so the rules
 * still judge them.
 */
export function withLoaderText(document: JobListDocument): JobListDocument {
  const read: JobListDocument = { ...document, jobs: document.jobs.map(jobWithText) };
  if (isMapping(document.defaults)) read.defaults = withText(document.defaults, DEFAULT_TEXT);
  if (Array.isArray(document.workspaces)) {
    read.workspaces = document.workspaces.map((workspace) => (isMapping(workspace) ? withText(workspace, WORKSPACE_TEXT) : workspace));
  }
  if (Array.isArray(document.dependencies)) {
    read.dependencies = document.dependencies.map((dependency) => (isMapping(dependency) ? withText(dependency, DEPENDENCY_TEXT) : dependency));
  }
  return read;
}

/** A job list document from the server, with its text fields as text (see withLoaderText). */
export const JobListDocumentSchema = z
  .custom<JobListDocument>((value) => DocumentStructure.safeParse(value).success, { message: "Not a job list document" })
  .transform(withLoaderText);

export const RuleIssueSchema = z.object({ path: z.string(), message: z.string() });

const ChangeKindSchema = z.enum(["import", "create", "update", "delete", "restore"]);

export const VersionSummarySchema = z.object({
  version: z.number(),
  savedAt: z.string(),
  savedBy: z.string(),
  changeKind: ChangeKindSchema,
  changeTarget: z.string().nullable(),
  summary: z.string(),
}) satisfies z.ZodType<VersionSummary>;

export const VersionDetailSchema = VersionSummarySchema.extend({
  document: JobListDocumentSchema,
}) satisfies z.ZodType<VersionDetail>;

export const JobListStateSchema = z.object({
  version: z.number().nullable(),
  savedAt: z.string().nullable(),
  savedBy: z.string().nullable(),
  document: JobListDocumentSchema,
}) satisfies z.ZodType<JobListState>;

export const SaveResultSchema = z.object({
  version: z.number(),
  summary: z.string(),
  document: JobListDocumentSchema,
}) satisfies z.ZodType<SaveResult>;

export const ImportPreviewSchema = z.object({
  document: JobListDocumentSchema,
  diff: z.array(z.object({ target: z.string(), kind: z.enum(["added", "removed", "changed"]), fields: z.array(z.string()) })),
  issues: z.array(RuleIssueSchema),
  summary: z.string(),
}) satisfies z.ZodType<ImportPreview>;

export const ImpactSchema = z.object({
  jobName: z.string(),
  parentJob: z.string().nullable(),
  affectsDirectly: z.array(z.string()),
  affectsInAll: z.array(z.string()),
}) satisfies z.ZodType<Impact>;

/** The body of a 409: someone saved a newer version since `baseVersion`. */
export const ConflictBodySchema = z.object({ error: z.literal("conflict"), message: z.string(), latestVersion: z.number().nullable() });

/** The body of a 422: the change breaks the job list rules. */
export const InvalidBodySchema = z.object({ error: z.literal("invalid"), message: z.string(), issues: z.array(RuleIssueSchema) });

function postJson<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
  return apiFetch(path, schema, { method: "POST", body: JSON.stringify(body) });
}

/** GET /api/job-list: the newest version, or version null and `{ jobs: [] }` when nothing is saved. */
export function getJobList(): Promise<JobListState> {
  return apiFetch("/api/job-list", JobListStateSchema);
}

/** GET /api/job-list/versions: the newest `limit` versions, newest first; with `before`, the ones older than that version. */
export async function listVersions(limit = 50, before?: number): Promise<VersionSummary[]> {
  const query = before === undefined ? `limit=${limit}` : `limit=${limit}&before=${before}`;
  const result = await apiFetch(`/api/job-list/versions?${query}`, z.object({ versions: z.array(VersionSummarySchema) }));
  return result.versions;
}

/** GET /api/job-list/versions/:version (404 when there is no such version). */
export function getVersion(v: number): Promise<VersionDetail> {
  return apiFetch(`/api/job-list/versions/${v}`, VersionDetailSchema);
}

/** POST /api/job-list/changes: 201 with the new version; 409 conflict; 422 invalid. */
export function saveChange(baseVersion: number | null, change: Change): Promise<SaveResult> {
  return postJson("/api/job-list/changes", SaveResultSchema, { baseVersion, change });
}

/** POST /api/job-list/import/preview: what an import would change, without saving it. */
export function previewImport(yaml: string): Promise<ImportPreview> {
  return postJson("/api/job-list/import/preview", ImportPreviewSchema, { yaml });
}

/** POST /api/job-list/import: saves a YAML file as a new version. */
export function importYaml(yaml: string, baseVersion: number | null): Promise<SaveResult> {
  return postJson("/api/job-list/import", SaveResultSchema, { yaml, baseVersion });
}

/** POST /api/job-list/restore: saves an older version as a new version. */
export function restoreVersion(version: number, baseVersion: number | null): Promise<SaveResult> {
  return postJson("/api/job-list/restore", SaveResultSchema, { version, baseVersion });
}

/** GET /api/job-list/export downloads the newest version as monitored_jobs.v<N>.yml. */
export function exportUrl(): string {
  return "/api/job-list/export";
}

/** GET /api/job-list/impact/:jobName (404 when the job is not in the list). */
export function getImpact(jobName: string): Promise<Impact> {
  return apiFetch(`/api/job-list/impact/${encodeURIComponent(jobName)}`, ImpactSchema);
}
