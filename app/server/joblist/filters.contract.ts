/**
 * The change-log filter cases, run against every VersionRepo: the in-memory one, and Lakebase when WATCHDOG_PG_TEST=1.
 * The seeded versions are dated in 2001 and use `fz_` job names and `@filters.example.com` people, so on a real branch
 * `scope` (the 2001 window) keeps the real versions out of every answer.
 */
import { describe, expect, it } from "vitest";
import type { VersionFilter, VersionRepo, VersionRow } from "./store";

type Seed = Omit<VersionRow, "document">;

const at = (iso: string) => new Date(iso);
const ALICE = "alice@filters.example.com";
const BOB = "bob@filters.example.com";
const CAROL = "carol@filters.example.com";
const DAN = "dan@filters.example.com";
const V = 900200;

export const SEEDS: Seed[] = [
  { version: V + 1, savedBy: ALICE, savedAt: at("2001-03-01T10:00:00Z"), changeKind: "import", changeTarget: null, summary: "Imported 3 jobs" },
  { version: V + 2, savedBy: ALICE, savedAt: at("2001-03-01T12:00:00Z"), changeKind: "create", changeTarget: "job:fz_orders_ingest", summary: "Added job fz_orders_ingest" },
  { version: V + 3, savedBy: BOB, savedAt: at("2001-03-02T00:00:00Z"), changeKind: "create", changeTarget: "job:fz_orders", summary: "Added job fz_orders" },
  { version: V + 4, savedBy: BOB, savedAt: at("2001-03-02T23:59:59Z"), changeKind: "update", changeTarget: "job:fz_ordersXingest", summary: "Changed gap of fz_ordersXingest, aXb, c/d, 1000 done" },
  { version: V + 5, savedBy: ALICE, savedAt: at("2001-03-03T09:00:00Z"), changeKind: "create", changeTarget: "dependency:fz_orders_report->fz_orders_ingest:job", summary: "Added link fz_orders_report depends on fz_orders_ingest" },
  { version: V + 6, savedBy: ALICE, savedAt: at("2001-03-04T09:00:00Z"), changeKind: "create", changeTarget: "dependency:fz_orders_ingest->fz_billing_svc:service", summary: "Added link fz_orders_ingest to the service fz_billing_svc" },
  { version: V + 7, savedBy: BOB, savedAt: at("2001-03-05T09:00:00Z"), changeKind: "delete", changeTarget: "job:fz_orders_ingest", summary: "Deleted job fz_orders_ingest and 2 links" },
  { version: V + 8, savedBy: ALICE, savedAt: at("2001-03-06T09:00:00Z"), changeKind: "restore", changeTarget: null, summary: "Restored version 2" },
  { version: V + 9, savedBy: CAROL, savedAt: at("2001-03-07T09:00:00Z"), changeKind: "update", changeTarget: "defaults", summary: "Changed defaults: 100% done" },
  { version: V + 10, savedBy: CAROL, savedAt: at("2001-03-08T09:00:00Z"), changeKind: "update", changeTarget: "workspace:1", summary: "Renamed label a_b" },
  { version: V + 11, savedBy: CAROL, savedAt: at("2001-03-09T09:00:00Z"), changeKind: "update", changeTarget: "workspace:2", summary: "Path c\\d changed" },
  { version: V + 12, savedBy: BOB, savedAt: at("2001-03-10T09:00:00Z"), changeKind: "update", changeTarget: "job:fz_orders", summary: "Changed max_gap_minutes of fz_orders" },
  // A job name that holds "->": the left end is what follows "dependency:" up to "->" (see targetMentionsJob).
  { version: V + 13, savedBy: DAN, savedAt: at("2001-03-11T09:00:00Z"), changeKind: "update", changeTarget: "dependency:fz_x->fz_y->fz_z:job", summary: "Changed a link with an arrow in a name" },
];

export const SCOPE: VersionFilter = { from: at("2001-01-01T00:00:00Z"), until: at("2002-01-01T00:00:00Z") };

export interface Fixture { repo: VersionRepo; scope: VersionFilter }

/** `setup` seeds SEEDS into a clean repo and returns it. */
export function describeFilters(setup: () => Promise<Fixture>, timeout = 60_000): void {
  const versions = (rows: { version: number }[]) => rows.map((row) => row.version - V);

  async function run(filter: VersionFilter, limit = 50, before?: number) {
    const { repo, scope } = await setup();
    return versions(await repo.list(limit, before === undefined ? undefined : before + V, { ...scope, ...filter }));
  }

  async function check(filter: VersionFilter, expected: number[]) {
    const { repo, scope } = await setup();
    const merged = { ...scope, ...filter };
    // The newest first.
    expect(versions(await repo.list(50, undefined, merged))).toEqual([...expected].sort((a, b) => b - a));
    expect(await repo.count(merged)).toBe(expected.length);
    // Paging with before, two at a time, stays inside the filtered set and ends where the full list ends.
    const paged: number[] = [];
    let before: number | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await repo.list(2, before, merged);
      if (page.length === 0) break;
      paged.push(...versions(page));
      before = page[page.length - 1].version;
      expect(await repo.count(merged)).toBe(expected.length);
    }
    expect(paged).toEqual([...expected].sort((a, b) => b - a));
  }

  describe("filters", () => {
    it("counts every seeded version, newest first, with no filter", async () => {
      await check({}, [13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    }, timeout);

    it("filters by person, exactly", async () => {
      await check({ person: ALICE }, [1, 2, 5, 6, 8]);
      await check({ person: "alice@filters.example" }, []);
      await check({ person: "ALICE@filters.example.com" }, []);
    }, timeout);

    it("filters by one or several kinds", async () => {
      await check({ kinds: ["create"] }, [2, 3, 5, 6]);
      await check({ kinds: ["delete", "restore", "import"] }, [1, 7, 8]);
      await check({ kinds: ["create", "update"] }, [2, 3, 4, 5, 6, 9, 10, 11, 12, 13]);
    }, timeout);

    it("matches a job by its own changes and by either end of a link", async () => {
      // Own changes (2, 7) and the links on either side (5 as the right end, 6 as the left end).
      await check({ job: "fz_orders_ingest" }, [2, 5, 6, 7]);
      await check({ job: "fz_orders_report" }, [5]);
    }, timeout);

    it("treats _ in a job name as a character, not a wildcard", async () => {
      await check({ job: "fz_ordersXingest" }, [4]);
      // fz_orders_ingest would match fz_ordersXingest under LIKE; it must not.
      await check({ job: "fz_orders_ingest" }, [2, 5, 6, 7]);
    }, timeout);

    it("does not match a job whose name is a prefix of another", async () => {
      await check({ job: "fz_orders" }, [3, 12]);
      await check({ job: "fz_order" }, []);
      await check({ job: "fz_orders_" }, []);
    }, timeout);

    it("reads a job name with an arrow the same way on every repo", async () => {
      // The left end is whatever follows "dependency:" up to an arrow; the right end is what follows the first arrow, up to the type.
      await check({ job: "fz_x->fz_y" }, [13]);
      await check({ job: "fz_x" }, [13]);
      await check({ job: "fz_y->fz_z" }, [13]);
      await check({ job: "fz_z" }, []);
      await check({ job: "fz_y" }, []);
    }, timeout);

    it("does not match a service as a job", async () => {
      await check({ job: "fz_billing_svc" }, []);
    }, timeout);

    it("bounds by date on both sides: from is inclusive, until is exclusive", async () => {
      await check({ from: at("2001-03-02T00:00:00Z") }, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      await check({ from: at("2001-03-02T00:00:01Z") }, [4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      await check({ until: at("2001-03-03T00:00:00Z") }, [1, 2, 3, 4]);
      await check({ until: at("2001-03-02T00:00:00Z") }, [1, 2]);
      await check({ from: at("2001-03-02T00:00:00Z"), until: at("2001-03-03T00:00:00Z") }, [3, 4]);
      await check({ from: at("2001-03-03T00:00:00Z"), until: at("2001-03-03T00:00:00Z") }, []);
    }, timeout);

    it("matches a summary case-insensitively as a substring", async () => {
      await check({ q: "ADDED JOB" }, [2, 3]);
      await check({ q: "orders" }, [2, 3, 4, 5, 6, 7, 12]);
    }, timeout);

    it("treats %, _ and \\ in q as plain characters", async () => {
      await check({ q: "100%" }, [9]);
      await check({ q: "a_b" }, [10]);
      await check({ q: "c\\d" }, [11]);
      await check({ q: "%" }, [9]);
      await check({ q: "_" }, [2, 3, 4, 5, 6, 7, 10, 12]);
      await check({ q: "\\" }, [11]);
    }, timeout);

    it("combines every filter with AND", async () => {
      await check({ person: BOB, kinds: ["create", "update"], job: "fz_orders", from: at("2001-03-01T00:00:00Z"), until: at("2001-03-11T00:00:00Z"), q: "orders" }, [3, 12]);
      await check({ person: ALICE, job: "fz_orders_ingest", q: "link" }, [5, 6]);
      await check({ person: CAROL, job: "fz_orders" }, []);
    }, timeout);

    it("answers an empty list and a zero total when nothing matches", async () => {
      const { repo, scope } = await setup();
      expect(await repo.list(50, undefined, { ...scope, q: "no such text" })).toEqual([]);
      expect(await repo.count({ ...scope, q: "no such text" })).toBe(0);
      expect(await repo.list(50, V + 1, { ...scope, q: "no such text" })).toEqual([]);
    }, timeout);

    it("counts the total ignoring before and limit", async () => {
      const { repo, scope } = await setup();
      expect(await repo.count(scope)).toBe(13);
      expect(await repo.count({ ...scope, kinds: ["create"] })).toBe(4);
      expect(await run({ kinds: ["create"] }, 1)).toEqual([6]);
    }, timeout);
  });

  describe("facets", () => {
    it("lists people by count then email, jobs by name, and kinds in order", async () => {
      const { repo } = await setup();
      const facets = await repo.facets();
      expect(facets.people.filter((p) => p.email.endsWith("@filters.example.com"))).toEqual([
        { email: ALICE, count: 5 }, { email: BOB, count: 4 }, { email: CAROL, count: 3 }, { email: DAN, count: 1 },
      ]);
      const counts = facets.people.map((p) => p.count);
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
      // Jobs include the deleted one, and the names that are links' ends; never the service.
      expect(facets.jobs.filter((j) => j.name.startsWith("fz_"))).toEqual([
        { name: "fz_orders", count: 2 }, { name: "fz_ordersXingest", count: 1 },
        { name: "fz_orders_ingest", count: 4 }, { name: "fz_orders_report", count: 1 },
        { name: "fz_x", count: 1 }, { name: "fz_y->fz_z", count: 1 },
      ]);
      const order = ["import", "create", "update", "delete", "restore"];
      const kinds = facets.kinds.map((k) => order.indexOf(k.kind));
      expect(kinds).toEqual([...kinds].sort((a, b) => a - b));
      expect(kinds.every((k) => k >= 0)).toBe(true);
      expect(new Date(facets.firstSavedAt ?? "").getTime()).toBeLessThanOrEqual(at("2001-03-01T10:00:00Z").getTime());
      expect(new Date(facets.lastSavedAt ?? "").getTime()).toBeGreaterThanOrEqual(at("2001-03-11T09:00:00Z").getTime());
    }, timeout);
  });
}
