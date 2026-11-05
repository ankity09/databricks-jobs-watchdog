import type { LakebasePool } from "@databricks/appkit";
import { createLakebasePool } from "@databricks/appkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Change } from "../../shared/joblist/types";
import { ensureSchema } from "../db/schema";
import { createPgVersionRepo } from "./pg-repo";
import { ConflictError, createJobListStore } from "./store";

// Runs only against a Lakebase branch: WATCHDOG_PG_TEST=1 npx vitest run server/joblist/pg-repo.integration.test.ts
// The app's real versions start at 1; this test uses 900000 and above, and removes them before and after.
const enabled = process.env.WATCHDOG_PG_TEST === "1";

describe.skipIf(!enabled)("pg version repo (Lakebase)", () => {
  let pool: LakebasePool;
  const clean = () => pool.query("DELETE FROM watchdog_app.job_list_versions WHERE version >= 900000");

  beforeAll(async () => {
    pool = createLakebasePool();
    await ensureSchema(pool);
    await clean();
  }, 60_000);

  afterAll(async () => {
    await clean();
    await pool.end();
  }, 60_000);

  const upsert = (name: string, gap: number): Change => ({
    kind: "upsert", target: { type: "job", name }, value: { job_name: name, max_gap_minutes: gap },
  });

  it("stores rows, and exactly one of two concurrent saves to the same job wins", async () => {
    const repo = createPgVersionRepo(pool);
    // Seed at 900000 directly, so real versions are untouched.
    await repo.transaction(async (tx) => {
      await tx.insert({
        version: 900000, document: { jobs: [{ job_name: "orders_ingest", max_gap_minutes: 60 }] }, savedBy: "test",
        changeKind: "import", changeTarget: null, summary: "seed",
      });
    });
    // 900000 is the highest version, so it is the latest whatever real versions exist.
    const store = createJobListStore(repo);
    const results = await Promise.allSettled([
      store.saveChange({ baseVersion: 900000, change: upsert("orders_ingest", 90), savedBy: "a" }),
      store.saveChange({ baseVersion: 900000, change: upsert("orders_ingest", 120), savedBy: "b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost?.status === "rejected" && lost.reason).toBeInstanceOf(ConflictError);
    const stored = await repo.get(900001);
    expect(stored?.document.jobs[0].max_gap_minutes === 90 || stored?.document.jobs[0].max_gap_minutes === 120).toBe(true);
  }, 60_000);

  it("lists the versions before a version, newest first", async () => {
    const repo = createPgVersionRepo(pool);
    await repo.transaction(async (tx) => {
      for (const version of [900100, 900101, 900102]) {
        await tx.insert({
          version, document: { jobs: [{ job_name: "orders_ingest", max_gap_minutes: 60 }] }, savedBy: "test",
          changeKind: "update", changeTarget: "job:orders_ingest", summary: `seed ${version}`,
        });
      }
    });
    const versions = (rows: { version: number }[]) => rows.map((row) => row.version);
    expect(versions(await repo.list(1))).toEqual([900102]);
    expect(versions(await repo.list(2, 900102))).toEqual([900101, 900100]);
    expect(versions(await repo.list(1, 900101))).toEqual([900100]);
  }, 60_000);
});
