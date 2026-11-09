export type ScheduleType = "scheduled" | "continuous" | "triggered";
export type Severity = "CRITICAL" | "WARNING";
export type DependencyType = "job" | "child_job" | "service";

/** Settings one environment label may change for one job (config.py OVERRIDE_KEYS). */
export interface EnvironmentOverrides {
  severity?: Severity;
  owner?: string;
  enabled?: boolean;
  max_gap_minutes?: number;
  max_runtime_minutes?: number;
  max_retries?: number;
  min_attempt_minutes?: number;
  job_ids?: string[];
}

/** One entry of the jobs section, as stored. Job IDs are always strings. */
export interface JobEntry {
  job_name: string;
  job_name_regex?: string;
  job_name_exclude_regex?: string | null;
  job_ids?: string[];
  schedule_type?: ScheduleType;
  max_gap_minutes?: number;
  max_runtime_minutes?: number;
  max_retries?: number;
  min_attempt_minutes?: number;
  severity?: Severity;
  owner?: string;
  enabled?: boolean;
  notes?: string;
  environments?: Record<string, EnvironmentOverrides>;
}

/** The defaults section: any job setting except the name, the pattern, environments and job IDs. */
export type DefaultsEntry = Omit<JobEntry, "job_name" | "job_name_regex" | "environments" | "job_ids">;

export interface WorkspaceEntry {
  workspace_id?: string;
  workspace_name?: string;
  environment: string;
  notes?: string;
}

export interface DependencyEntry {
  job_name: string;
  depends_on: string;
  dependency_type?: DependencyType;
  notes?: string;
}

/** The whole job list: the same shape and keys as the monitored-jobs YAML file. */
export interface JobListDocument {
  defaults?: DefaultsEntry;
  workspaces?: WorkspaceEntry[];
  jobs: JobEntry[];
  dependencies?: DependencyEntry[];
}

export type Target =
  | { type: "job"; name: string }
  | { type: "dependency"; key: string }
  | { type: "workspace"; key: string }
  | { type: "defaults" };

export type Change =
  | { kind: "upsert"; target: Target; value: JobEntry | DependencyEntry | WorkspaceEntry | DefaultsEntry }
  | { kind: "delete"; target: Target };

export interface RuleIssue { path: string; message: string }
export type ChangeKind = "import" | "create" | "update" | "delete" | "restore";
export interface VersionSummary {
  version: number; savedAt: string; savedBy: string;
  changeKind: ChangeKind; changeTarget: string | null; summary: string;
}
/** The versions that match the filters, newest first, and how many match in all (ignoring `before` and `limit`). */
export interface VersionList { versions: VersionSummary[]; total: number }
/** What the change log can be filtered by, counted over every version. */
export interface VersionFacets {
  people: { email: string; count: number }[];
  jobs: { name: string; count: number }[];
  kinds: { kind: ChangeKind; count: number }[];
  firstSavedAt: string | null;
  lastSavedAt: string | null;
}
export const CHANGE_KINDS: readonly ChangeKind[] = ["import", "create", "update", "delete", "restore"];
export interface VersionDetail extends VersionSummary { document: JobListDocument }
export interface JobListState {
  version: number | null; savedAt: string | null; savedBy: string | null; document: JobListDocument;
}
export interface SaveResult { version: number; summary: string; document: JobListDocument }
export interface DiffEntry { target: string; kind: "added" | "removed" | "changed"; fields: string[] }
export interface ImportPreview { document: JobListDocument; diff: DiffEntry[]; issues: RuleIssue[]; summary: string }
export interface Impact { jobName: string; parentJob: string | null; affectsDirectly: string[]; affectsInAll: string[] }
export interface AppConfig {
  catalog: string; schema: string; region: string;
  appName: string; lakebaseProject: string;
}
export interface SqlCall { name: string; query: string }

export const EMPTY_DOCUMENT: JobListDocument = { jobs: [] };

export function dependencyKey(d: DependencyEntry): string {
  return `${d.job_name}->${d.depends_on}:${d.dependency_type ?? "job"}`;
}

export function workspaceKey(w: WorkspaceEntry): string {
  return w.workspace_id ?? (w.workspace_name ?? "").toLowerCase();
}

export function targetKey(t: Target): string {
  switch (t.type) {
    case "job": return `job:${t.name}`;
    case "dependency": return `dependency:${t.key}`;
    case "workspace": return `workspace:${t.key}`;
    case "defaults": return "defaults";
  }
}
