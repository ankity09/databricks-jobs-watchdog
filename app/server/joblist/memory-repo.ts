import type { VersionRepo, VersionRow, VersionTx } from "./store";

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

  list(limit: number): Promise<VersionRow[]> {
    return Promise.resolve([...this.rows].reverse().slice(0, limit));
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
