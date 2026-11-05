import { describe, expect, it } from "vitest";
import type { Change, JobEntry, JobListDocument } from "../../shared/joblist/types";
import { MemoryVersionRepo } from "./memory-repo";
import { ConflictError, createJobListStore, InvalidError, NotFoundError } from "./store";

const job = (name: string) => ({ type: "job", name }) as const;
const add = (name: string, gap = 60): Change => ({ kind: "upsert", target: job(name), value: { job_name: name, max_gap_minutes: gap } });

function setup() {
  const repo = new MemoryVersionRepo();
  return { repo, store: createJobListStore(repo) };
}

describe("saveChange", () => {
  it("saves into an empty list as version 1", async () => {
    const { store } = setup();
    const row = await store.saveChange({ baseVersion: null, change: add("a"), savedBy: "me" });
    expect(row.version).toBe(1);
    expect(row.summary).toBe("Added job a");
    expect(row.changeKind).toBe("create");
    expect(row.changeTarget).toBe("job:a");
    expect(row.savedBy).toBe("me");
  });

  it("rejects an invalid change and stores nothing", async () => {
    const { store, repo } = setup();
    const bad: Change = { kind: "upsert", target: job("a"), value: { job_name: "a", max_gap_minutes: -1 } };
    const err = await store.saveChange({ baseVersion: null, change: bad, savedBy: "me" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidError);
    expect((err as InvalidError).issues[0].message).toContain("max_gap_minutes must be a whole number");
    expect(repo.rows).toHaveLength(0);
  });

  it("turns a change error into an invalid error", async () => {
    const { store } = setup();
    await expect(store.saveChange({ baseVersion: null, change: { kind: "delete", target: job("x") }, savedBy: "me" })).rejects.toBeInstanceOf(InvalidError);
  });

  it("a missing base version is not found", async () => {
    const { store } = setup();
    await expect(store.saveChange({ baseVersion: 5, change: add("a"), savedBy: "me" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("conflicts on the same job from the same base", async () => {
    const { store } = setup();
    await store.saveChange({ baseVersion: null, change: add("a"), savedBy: "me" });
    await store.saveChange({ baseVersion: 1, change: add("a", 90), savedBy: "x" });
    const err = await store.saveChange({ baseVersion: 1, change: add("a", 120), savedBy: "y" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).latestVersion).toBe(2);
  });

  it("lets edits to different jobs both through", async () => {
    const { store } = setup();
    await store.saveChange({ baseVersion: null, change: add("a"), savedBy: "me" });
    const two = await store.saveChange({ baseVersion: 1, change: add("b"), savedBy: "x" });
    const three = await store.saveChange({ baseVersion: 1, change: add("c"), savedBy: "y" });
    expect([two.version, three.version]).toEqual([2, 3]);
    expect(three.document.jobs.map((j) => j.job_name).sort()).toEqual(["a", "b", "c"]);
  });

  it("conflicts when a delete races an edit of the same job", async () => {
    const { store } = setup();
    await store.saveChange({ baseVersion: null, change: add("a"), savedBy: "me" });
    await store.saveChange({ baseVersion: 1, change: add("b"), savedBy: "me" });
    await store.saveChange({ baseVersion: 2, change: { kind: "delete", target: job("a") }, savedBy: "x" });
    await expect(store.saveChange({ baseVersion: 2, change: add("a", 5), savedBy: "y" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("handles concurrent saves one after the other", async () => {
    const { store } = setup();
    await store.saveChange({ baseVersion: null, change: add("a"), savedBy: "me" });
    const results = await Promise.allSettled([
      store.saveChange({ baseVersion: 1, change: add("a", 1), savedBy: "x" }),
      store.saveChange({ baseVersion: 1, change: add("a", 2), savedBy: "y" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  });
});

describe("importDocument", () => {
  const doc = { jobs: [{ job_name: "a", max_gap_minutes: 5 }] };
  it("conflicts on a stale base version", async () => {
    const { store } = setup();
    await store.saveChange({ baseVersion: null, change: add("a"), savedBy: "me" });
    await expect(store.importDocument({ baseVersion: null, document: doc, savedBy: "me" })).rejects.toBeInstanceOf(ConflictError);
  });
  it("stores an import with the summary", async () => {
    const { store } = setup();
    await store.saveChange({ baseVersion: null, change: add("a"), savedBy: "me" });
    const row = await store.importDocument({ baseVersion: 1, document: doc, savedBy: "me" });
    expect(row.changeKind).toBe("import");
    expect(row.changeTarget).toBeNull();
    expect(row.summary).toBe("Imported 1 job, 0 links and 0 workspace labels from YAML");
  });
  it("rejects an invalid document", async () => {
    const { store } = setup();
    await expect(store.importDocument({ baseVersion: null, document: { jobs: [] }, savedBy: "me" })).rejects.toBeInstanceOf(InvalidError);
  });
});

describe("list", () => {
  it("lists the newest versions first, or the ones before a version", async () => {
    const { store } = setup();
    await store.saveChange({ baseVersion: null, change: add("a"), savedBy: "me" });
    await store.saveChange({ baseVersion: 1, change: add("b"), savedBy: "me" });
    await store.saveChange({ baseVersion: 2, change: add("c"), savedBy: "me" });
    const versions = (rows: { version: number }[]) => rows.map((row) => row.version);
    expect(versions(await store.list(2))).toEqual([3, 2]);
    expect(versions(await store.list(2, 3))).toEqual([2, 1]);
    expect(versions(await store.list(5, 2))).toEqual([1]);
    expect(await store.list(5, 1)).toEqual([]);
  });
});

describe("restore", () => {
  it("is not found for a missing version", async () => {
    const { store } = setup();
    await expect(store.restore({ version: 9, baseVersion: null, savedBy: "me" })).rejects.toBeInstanceOf(NotFoundError);
  });
  it("stores a restore", async () => {
    const { store } = setup();
    await store.saveChange({ baseVersion: null, change: add("a"), savedBy: "me" });
    await store.saveChange({ baseVersion: 1, change: add("b"), savedBy: "me" });
    const row = await store.restore({ version: 1, baseVersion: 2, savedBy: "me" });
    expect(row).toMatchObject({ version: 3, changeKind: "restore", changeTarget: null, summary: "Restored version 1" });
    expect(row.document.jobs).toHaveLength(1);
  });
  it("conflicts on a stale base", async () => {
    const { store } = setup();
    await store.saveChange({ baseVersion: null, change: add("a"), savedBy: "me" });
    await expect(store.restore({ version: 1, baseVersion: null, savedBy: "me" })).rejects.toBeInstanceOf(ConflictError);
  });
});

/** A JSON document as an older app stored it: YAML numbers and booleans kept as they were parsed, even in text fields. */
function legacy(json: string): JobListDocument {
  const value: unknown = JSON.parse(json);
  return value as JobListDocument;
}

describe("documents an older app stored with numbers and booleans in text fields", () => {
  function seeded() {
    const { repo, store } = setup();
    repo.rows.push({
      version: 1, savedBy: "me", savedAt: new Date(), changeKind: "import", changeTarget: null, summary: "Imported 1 job",
      document: legacy('{"jobs": [{"job_name": 2024, "max_gap_minutes": 60, "notes": true}, {"job_name": "orders_ingest", "max_gap_minutes": 60}], "dependencies": [{"job_name": 2024, "depends_on": "billing-api", "dependency_type": "service"}]}'),
    });
    return store;
  }

  it("reads them with those fields as the text the Python loader reads", async () => {
    const store = seeded();
    expect((await store.latest())?.document.jobs[0]).toEqual({ job_name: "2024", max_gap_minutes: 60, notes: "True" });
    expect((await store.get(1))?.document.dependencies?.[0].job_name).toBe("2024");
  });

  it("lets a job whose name was stored as a number be edited by its name", async () => {
    const store = seeded();
    const change: Change = { kind: "upsert", target: job("2024"), value: { job_name: "2024", max_gap_minutes: 90, notes: "True" } };
    const row = await store.saveChange({ baseVersion: 1, change, savedBy: "me" });
    expect(row.document.jobs.map((j) => j.job_name)).toEqual(["2024", "orders_ingest"]);
    expect(row.document.jobs[0]).toEqual({ job_name: "2024", max_gap_minutes: 90, notes: "True" });
    expect(row.summary).toBe("Changed max_gap_minutes on 2024 from 60 to 90");
  });

  it("lets it be deleted by its name, with its link", async () => {
    const store = seeded();
    const row = await store.saveChange({ baseVersion: 1, change: { kind: "delete", target: job("2024") }, savedBy: "me" });
    expect(row.document.jobs.map((j) => j.job_name)).toEqual(["orders_ingest"]);
    expect(row.document.dependencies).toEqual([]);
    expect(row.summary).toBe("Deleted job 2024 and 1 link");
  });

  it("restores an old version with its text fields as text", async () => {
    const store = seeded();
    const row = await store.restore({ version: 1, baseVersion: 1, savedBy: "me" });
    expect(row.document.jobs[0]).toEqual({ job_name: "2024", max_gap_minutes: 60, notes: "True" });
  });
});

describe("a change whose text fields hold numbers or booleans", () => {
  it("is stored with them as the text the Python loader reads", async () => {
    const { store } = setup();
    const value: unknown = JSON.parse('{"job_name": 2024, "max_gap_minutes": 60, "owner": 0, "notes": true}');
    const change: Change = { kind: "upsert", target: job("2024"), value: value as JobEntry };
    const row = await store.saveChange({ baseVersion: null, change, savedBy: "me" });
    expect(row.document.jobs).toEqual([{ job_name: "2024", max_gap_minutes: 60, owner: "", notes: "True" }]);
  });
});
