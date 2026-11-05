/**
 * The versioned job list. Every save adds a version; nothing is edited in place.
 * A save carries the version the person was looking at (baseVersion). It goes
 * through unless someone else changed the same thing since: that is checked per
 * target, so edits to different jobs never collide. The repo runs each save in
 * one transaction under a lock, so two saves cannot both read the same latest.
 */
import { applyChange, ChangeError, sameTargetValue } from "../../shared/joblist/apply";
import { importSummary } from "../../shared/joblist/diff";
import { validateDocument } from "../../shared/joblist/rules";
import { EMPTY_DOCUMENT, type Change, type ChangeKind, type JobListDocument, type RuleIssue } from "../../shared/joblist/types";

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

export interface VersionRepo {
  /** Runs fn in one transaction that no other transaction of this repo overlaps. */
  transaction<T>(fn: (tx: VersionTx) => Promise<T>): Promise<T>;
  latest(): Promise<VersionRow | null>;
  get(version: number): Promise<VersionRow | null>;
  list(limit: number): Promise<VersionRow[]>;
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
  list(limit: number): Promise<VersionRow[]>;
  saveChange(args: { baseVersion: number | null; change: Change; savedBy: string }): Promise<VersionRow>;
  importDocument(args: { baseVersion: number | null; document: JobListDocument; savedBy: string }): Promise<VersionRow>;
  restore(args: { version: number; baseVersion: number | null; savedBy: string }): Promise<VersionRow>;
}

function checkValid(document: JobListDocument): void {
  const issues = validateDocument(document);
  if (issues.length > 0) throw new InvalidError(issues);
}

export function createJobListStore(repo: VersionRepo): JobListStore {
  return {
    latest: () => repo.latest(),
    get: (version) => repo.get(version),
    list: (limit) => repo.list(limit),

    saveChange: ({ baseVersion, change, savedBy }) =>
      repo.transaction(async (tx) => {
        const latest = await tx.latest();
        let base: JobListDocument = EMPTY_DOCUMENT;
        if (baseVersion !== null) {
          const row = latest?.version === baseVersion ? latest : await tx.get(baseVersion);
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
          document,
          savedBy,
          changeKind: "import",
          changeTarget: null,
          summary: importSummary(document),
        });
      }),

    restore: ({ version, baseVersion, savedBy }) =>
      repo.transaction(async (tx) => {
        const target = await tx.get(version);
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
