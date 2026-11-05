import { applyChange, ChangeError, sameTargetValue } from "../../../shared/joblist/apply";
import { validateDocument } from "../../../shared/joblist/rules";
import { type Change, EMPTY_DOCUMENT, type JobListDocument, type JobListState } from "../../../shared/joblist/types";

/** The body of POST /api/job-list/changes. */
export interface SaveBody {
  baseVersion: number | null;
  change: Change;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * A job list server for page tests. It keeps every version and checks a save
 * the way server/joblist/store.ts does: a change whose target differs between
 * its base version and the newest version gets 409, and a change that breaks
 * a rule gets 422.
 */
export function jobListServer(document: JobListDocument, version = 1) {
  const versions = new Map<number, JobListDocument>([[version, document]]);
  let latest = version;
  const saves: SaveBody[] = [];

  const newest = (): JobListDocument => versions.get(latest) ?? EMPTY_DOCUMENT;

  /** Saves a change on the newest version, as another person would. */
  const commit = (change: Change) => {
    const applied = applyChange(newest(), change);
    latest += 1;
    versions.set(latest, applied.document);
    return { version: latest, summary: applied.summary, document: applied.document };
  };

  return {
    saves,
    state(): JobListState {
      return { version: latest, savedAt: "2026-11-05T10:05:00Z", savedBy: "someone@example.com", document: newest() };
    },
    /** Someone else saves a change, which this page does not see until it loads the list again. */
    saveAsSomeoneElse(change: Change): void {
      commit(change);
    },
    /** The answer to POST /api/job-list/changes. */
    answer(body: SaveBody): Response {
      saves.push(body);
      const base = body.baseVersion === null ? EMPTY_DOCUMENT : versions.get(body.baseVersion);
      if (!base) return json({ error: "not_found", message: `Version ${body.baseVersion} does not exist.` }, 404);
      if (!sameTargetValue(base, newest(), body.change.target)) {
        return json({ error: "conflict", message: "Someone else changed this since you opened it. Reload to see their change.", latestVersion: latest }, 409);
      }
      let next: JobListDocument;
      try {
        next = applyChange(newest(), body.change).document;
      } catch (error) {
        if (error instanceof ChangeError) return json({ error: "invalid", message: "The job list has a problem.", issues: [{ path: "", message: error.message }] }, 422);
        throw error;
      }
      const issues = validateDocument(next);
      if (issues.length > 0) return json({ error: "invalid", message: "The job list has a problem.", issues }, 422);
      return json(commit(body.change), 201);
    },
  };
}
