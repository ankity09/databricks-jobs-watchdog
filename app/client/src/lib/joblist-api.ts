import { z } from "zod";
import type {
  Change,
  Impact,
  ImportPreview,
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

export const JobListDocumentSchema = z.custom<JobListDocument>((value) => DocumentStructure.safeParse(value).success, {
  message: "Not a job list document",
});

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

/** GET /api/job-list/versions: the saved versions, newest first. */
export async function listVersions(limit = 50): Promise<VersionSummary[]> {
  const result = await apiFetch(`/api/job-list/versions?limit=${limit}`, z.object({ versions: z.array(VersionSummarySchema) }));
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
