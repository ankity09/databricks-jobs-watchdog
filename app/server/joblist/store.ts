/**
 * The versioned job list. Every save adds a version; nothing is edited in place.
 * A save carries the version the person was looking at (baseVersion). It goes
 * through unless someone else changed the same thing since: that is checked per
 * target, so edits to different jobs never collide. The repo runs each save in
 * one transaction under a lock, so two saves cannot both read the same latest.
 *
 * Text fields are stored as the text the Python loader reads (a job named 2024
 * is the job "2024"). Versions an older app saved may hold numbers or booleans
 * there, so every version is read through the same rule, and each change too.
 */
import { applyChange, ChangeError, sameTargetValue } from "../../shared/joblist/apply";
import { importSummary } from "../../shared/joblist/diff";
import { storedChange, storedDocument, validateDocument } from "../../shared/joblist/rules";
import {
  EMPTY_DOCUMENT, type Change, type ChangeKind, type JobListDocument, type RuleIssue, type VersionFacets,
} from "../../shared/joblist/types";

export interface VersionRow {
  version: number;
  document: JobListDocument;
  savedBy: string;
  savedAt: Date;
  changeKind: ChangeKind;
  changeTarget: string | null;
  summary: string;
}

export interface VersionTx {
  latest(): Promise<VersionRow | null>;
  get(version: number): Promise<VersionRow | null>;
  insert(row: Omit<VersionRow, "savedAt">): Promise<VersionRow>;
}

/** What the change log can narrow to. All of them combine with AND; a missing one does not filter. */
export interface VersionFilter {
  /** The exact `saved_by` email. */
  person?: string;
  kinds?: ChangeKind[];
  /** An exact job name: its own changes, and the links that have it at either end. */
  job?: string;
  /** Saved at or after this instant. */
  from?: Date;
  /** Saved before this instant (exclusive). */
  until?: Date;
  /** A case-insensitive substring of the summary. */
  q?: string;
}

export interface VersionRepo {
  /** Runs fn in one transaction that no other transaction of this repo overlaps. */
  transaction<T>(fn: (tx: VersionTx) => Promise<T>): Promise<T>;
  latest(): Promise<VersionRow | null>;
  get(version: number): Promise<VersionRow | null>;
  /** The newest `limit` versions, newest first; with `before`, only the versions older than it. */
  list(limit: number, before?: number, filter?: VersionFilter): Promise<VersionRow[]>;
  /** How many versions match the filter, ignoring paging. */
  count(filter?: VersionFilter): Promise<number>;
  /** The people, jobs and kinds found over every version. */
  facets(): Promise<VersionFacets>;
}

export class ConflictError extends Error {
  readonly latestVersion: number;
  constructor(latestVersion: number) {
    super("Someone else changed this since you opened it. Reload to see their change.");
    this.name = "ConflictError";
    this.latestVersion = latestVersion;
  }
}

export class InvalidError extends Error {
  readonly issues: RuleIssue[];
  constructor(issues: RuleIssue[]) {
    super("The job list has a problem.");
    this.name = "InvalidError";
    this.issues = issues;
  }
}

export class NotFoundError extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface JobListStore {
  latest(): Promise<VersionRow | null>;
  get(version: number): Promise<VersionRow | null>;
  list(limit: number, before?: number, filter?: VersionFilter): Promise<VersionRow[]>;
  count(filter?: VersionFilter): Promise<number>;
  facets(): Promise<VersionFacets>;
  saveChange(args: { baseVersion: number | null; change: Change; savedBy: string }): Promise<VersionRow>;
  importDocument(args: { baseVersion: number | null; document: JobListDocument; savedBy: string }): Promise<VersionRow>;
  restore(args: { version: number; baseVersion: number | null; savedBy: string }): Promise<VersionRow>;
}

function checkValid(document: JobListDocument): void {
  const issues = validateDocument(document);
  if (issues.length > 0) throw new InvalidError(issues);
}

/** A version with its document in the stored form. */
function readable(row: VersionRow | null): VersionRow | null {
  return row ? { ...row, document: storedDocument(row.document) } : null;
}

export function createJobListStore(repo: VersionRepo): JobListStore {
  return {
    latest: async () => readable(await repo.latest()),
    get: async (version) => readable(await repo.get(version)),
    list: async (limit, before, filter) =>
      (await repo.list(limit, before, filter)).map((row) => ({ ...row, document: storedDocument(row.document) })),
    count: (filter) => repo.count(filter),
    facets: () => repo.facets(),

    saveChange: ({ baseVersion, change: requested, savedBy }) =>
      repo.transaction(async (tx) => {
        const change = storedChange(requested);
        const latest = readable(await tx.latest());
        let base: JobListDocument = EMPTY_DOCUMENT;
        if (baseVersion !== null) {
          const row = latest?.version === baseVersion ? latest : readable(await tx.get(baseVersion));
          if (!row) throw new NotFoundError(`Version ${baseVersion} does not exist.`);
          base = row.document;
        }
        const current = latest?.document ?? EMPTY_DOCUMENT;
        if (latest && !sameTargetValue(base, current, change.target)) throw new ConflictError(latest.version);
        let applied;
        try {
          applied = applyChange(current, change);
        } catch (error) {
          if (error instanceof ChangeError) throw new InvalidError([{ path: "", message: error.message }]);
          throw error;
        }
        checkValid(applied.document);
        return tx.insert({
          version: (latest?.version ?? 0) + 1,
          document: applied.document,
          savedBy,
          changeKind: applied.changeKind,
          changeTarget: applied.changeTarget,
          summary: applied.summary,
        });
      }),

    importDocument: ({ baseVersion, document, savedBy }) =>
      repo.transaction(async (tx) => {
        const latest = await tx.latest();
        if (latest && latest.version !== baseVersion) throw new ConflictError(latest.version);
        if (!latest && baseVersion !== null) throw new NotFoundError(`Version ${baseVersion} does not exist.`);
        checkValid(document);
        return tx.insert({
          version: (latest?.version ?? 0) + 1,
          document: storedDocument(document),
          savedBy,
          changeKind: "import",
          changeTarget: null,
          summary: importSummary(document),
        });
      }),

    restore: ({ version, baseVersion, savedBy }) =>
      repo.transaction(async (tx) => {
        const target = readable(await tx.get(version));
        if (!target) throw new NotFoundError(`Version ${version} does not exist.`);
        const latest = await tx.latest();
        if (latest && latest.version !== baseVersion) throw new ConflictError(latest.version);
        checkValid(target.document);
        return tx.insert({
          version: (latest?.version ?? 0) + 1,
          document: target.document,
          savedBy,
          changeKind: "restore",
          changeTarget: null,
          summary: `Restored version ${version}`,
        });
      }),
  };
}
