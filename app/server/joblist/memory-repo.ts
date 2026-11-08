import { jobsInTarget } from "../../shared/joblist/changelog";
import { CHANGE_KINDS, type VersionFacets } from "../../shared/joblist/types";
import type { VersionFilter, VersionRepo, VersionRow, VersionTx } from "./store";

function matches(row: VersionRow, f: VersionFilter): boolean {
  if (f.person !== undefined && row.savedBy !== f.person) return false;
  if (f.kinds !== undefined && !f.kinds.includes(row.changeKind)) return false;
  if (f.job !== undefined && !jobsInTarget(row.changeTarget).includes(f.job)) return false;
  if (f.from !== undefined && row.savedAt < f.from) return false;
  if (f.until !== undefined && row.savedAt >= f.until) return false;
  if (f.q !== undefined && !row.summary.toLowerCase().includes(f.q.toLowerCase())) return false;
  return true;
}

function tally(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** An in-memory VersionRepo for tests. Transactions run one at a time, like the advisory lock does in Postgres. */
export class MemoryVersionRepo implements VersionRepo {
  readonly rows: VersionRow[] = [];
  private lock: Promise<unknown> = Promise.resolve();

  latest(): Promise<VersionRow | null> {
    return Promise.resolve(this.rows.length > 0 ? this.rows[this.rows.length - 1] : null);
  }

  get(version: number): Promise<VersionRow | null> {
    return Promise.resolve(this.rows.find((r) => r.version === version) ?? null);
  }

  list(limit: number, before?: number, filter: VersionFilter = {}): Promise<VersionRow[]> {
    const rows = this.rows.filter((r) => (before === undefined || r.version < before) && matches(r, filter));
    return Promise.resolve([...rows].reverse().slice(0, limit));
  }

  count(filter: VersionFilter = {}): Promise<number> {
    return Promise.resolve(this.rows.filter((r) => matches(r, filter)).length);
  }

  facets(): Promise<VersionFacets> {
    const people = [...tally(this.rows.map((r) => r.savedBy))]
      .map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
    const jobs = [...tally(this.rows.flatMap((r) => jobsInTarget(r.changeTarget)))]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const kindCounts = tally(this.rows.map((r) => r.changeKind));
    const kinds = CHANGE_KINDS.flatMap((kind) => {
      const count = kindCounts.get(kind) ?? 0;
      return count > 0 ? [{ kind, count }] : [];
    });
    const times = this.rows.map((r) => r.savedAt.getTime());
    return Promise.resolve({
      people, jobs, kinds,
      firstSavedAt: times.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
      lastSavedAt: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
    });
  }

  transaction<T>(fn: (tx: VersionTx) => Promise<T>): Promise<T> {
    const tx: VersionTx = {
      latest: () => this.latest(),
      get: (version) => this.get(version),
      insert: (row) => {
        const saved: VersionRow = { ...row, savedAt: new Date() };
        this.rows.push(saved);
        return Promise.resolve(saved);
      },
    };
    const run = this.lock.then(() => fn(tx));
    this.lock = run.catch(() => undefined);
    return run;
  }
}
