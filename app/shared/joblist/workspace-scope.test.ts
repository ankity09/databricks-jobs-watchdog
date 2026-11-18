import { describe, expect, it } from "vitest";
import { MemoryVersionRepo } from "../../server/joblist/memory-repo";
import { createJobListStore, InvalidError } from "../../server/joblist/store";
import { readJobListYaml } from "../../server/joblist/yaml";
import { validateDocument } from "./rules";
import type { Change, JobEntry, WorkspaceEntry } from "./types";

describe("a real workspace scope on each job", () => {
  it("imports a workspace-scoped job without a workspace-label section", () => {
    const result = readJobListYaml('jobs:\n  - job_name: orders_ingest\n    workspace_id: "1234"\n    job_ids: ["7"]\n    schedule_type: continuous\n');
    expect(result.issues).toEqual([]);
    expect(result.document.jobs[0].workspace_id).toBe("1234");
  });

  it("preserves every digit of an unquoted YAML workspace ID", () => {
    const result = readJobListYaml("jobs:\n  - job_name: orders_ingest\n    workspace_id: 9007199254740993\n    schedule_type: continuous\n");
    expect(result.issues).toEqual([]);
    expect(result.document.jobs[0].workspace_id).toBe("9007199254740993");
  });

  it.each([true, false, "", "12.5", [], Number.MAX_SAFE_INTEGER + 1])("reports an invalid workspace ID on its own field: %j", (workspace_id) => {
    const issues = validateDocument({ jobs: [{ job_name: "orders_ingest", schedule_type: "continuous", workspace_id }] });
    expect(issues.some((issue) => issue.path === "jobs[orders_ingest].workspace_id")).toBe(true);
  });

  it.each(["1234\n", "1234\r", "1234 ", "1234 "])("rejects every non-digit in a workspace ID: %j", (workspace_id) => {
    const issues = validateDocument({ jobs: [{ job_name: "orders_ingest", schedule_type: "continuous", workspace_id }] });
    expect(issues.some((issue) => issue.path === "jobs[orders_ingest].workspace_id")).toBe(true);
  });

  it("does not import a trailing newline in a quoted YAML workspace ID", () => {
    const result = readJobListYaml('jobs:\n  - job_name: orders_ingest\n    workspace_id: "1234\\n"\n    schedule_type: continuous\n');
    expect(result.issues.some((issue) => issue.path === "jobs[orders_ingest].workspace_id")).toBe(true);
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, 1e20])("rejects unsafe numeric workspace scope before a save can stringify it: %j", async (workspace_id) => {
    const repo = new MemoryVersionRepo();
    const store = createJobListStore(repo);
    const value: JobEntry = { job_name: "orders_ingest", schedule_type: "continuous" };
    // Exercise untrusted runtime input without asserting it has the stored string type.
    Reflect.set(value, "workspace_id", workspace_id);
    await expect(store.saveChange({
      baseVersion: null,
      change: { kind: "upsert", target: { type: "job", name: "orders_ingest" }, value },
      savedBy: "someone@example.com",
    })).rejects.toBeInstanceOf(InvalidError);
    expect(repo.rows).toHaveLength(0);
  });

  it.each(["job_ids", "workspace labels"] as const)("refuses unsafe numeric %s through the same normalization path", async (field) => {
    for (const id of [Number.MAX_SAFE_INTEGER + 1, 1e20]) {
      const repo = new MemoryVersionRepo();
      const store = createJobListStore(repo);
      const job: JobEntry = { job_name: "orders_ingest", schedule_type: "continuous" };
      await store.importDocument({ baseVersion: null, document: { jobs: [job] }, savedBy: "someone@example.com" });
      const invalidJob: JobEntry = { ...job };
      Reflect.set(invalidJob, "job_ids", [id]);
      const invalidWorkspace: WorkspaceEntry = { environment: "lower" };
      Reflect.set(invalidWorkspace, "workspace_id", id);
      const change: Change = field === "job_ids"
        ? { kind: "upsert", target: { type: "job", name: job.job_name }, value: invalidJob }
        : { kind: "upsert", target: { type: "workspace", key: String(id) }, value: invalidWorkspace };
      await expect(store.saveChange({ baseVersion: 1, change, savedBy: "someone@example.com" })).rejects.toBeInstanceOf(InvalidError);
      expect(repo.rows).toHaveLength(1);
    }
  });

  it.each(["9007199254740993", '"9007199254740993"'])("preserves exact bigint or text IDs in all three fields: %s", (id) => {
    const result = readJobListYaml(`workspaces:\n  - workspace_id: ${id}\n    environment: lower\njobs:\n  - job_name: orders_ingest\n    workspace_id: ${id}\n    job_ids: [${id}]\n    schedule_type: continuous\n`);
    expect(result.issues).toEqual([]);
    expect(result.document.jobs[0].workspace_id).toBe("9007199254740993");
    expect(result.document.jobs[0].job_ids).toEqual(["9007199254740993"]);
    expect(result.document.workspaces?.[0].workspace_id).toBe("9007199254740993");
  });

  it("continues to normalize safe numeric IDs for all three fields", async () => {
    const store = createJobListStore(new MemoryVersionRepo());
    const value: JobEntry = { job_name: "orders_ingest", schedule_type: "continuous" };
    Reflect.set(value, "workspace_id", 1234);
    Reflect.set(value, "job_ids", [7]);
    const saved = await store.saveChange({
      baseVersion: null,
      change: { kind: "upsert", target: { type: "job", name: value.job_name }, value },
      savedBy: "someone@example.com",
    });
    expect(saved.document.jobs[0]).toMatchObject({ workspace_id: "1234", job_ids: ["7"] });
    const label: WorkspaceEntry = { environment: "lower" };
    Reflect.set(label, "workspace_id", 1234);
    const withLabel = await store.saveChange({
      baseVersion: saved.version,
      change: { kind: "upsert", target: { type: "workspace", key: "1234" }, value: label },
      savedBy: "someone@example.com",
    });
    expect(withLabel.document.workspaces?.[0].workspace_id).toBe("1234");
  });

  it("does not allow a workspace scope in defaults", () => {
    const issues = validateDocument({ defaults: { workspace_id: "1234" }, jobs: [{ job_name: "orders_ingest", schedule_type: "continuous" }] });
    expect(issues.length).toBeGreaterThan(0);
  });

  it("lets a null scope keep the legacy regional behavior", () => {
    expect(validateDocument({ jobs: [{ job_name: "orders_ingest", schedule_type: "continuous", workspace_id: null }] })).toEqual([]);
  });
});
