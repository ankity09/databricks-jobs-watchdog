import { describe, expect, it } from "vitest";
import type { JobEntry, JobListDocument } from "../../../shared/joblist/types";
import { toEntry, toFormValues } from "./job-form";
import { draftFromRegionJob, entryJobIds, isMonitored, type RegionJobRow } from "./picker";

const PICKED: RegionJobRow = {
  workspace_id: "1234", workspace_name: "example-lower", job_id: "7", name: "orders_ingest",
  trigger_type: "CRON", paused: false, creator_user_name: "someone@example.com", change_time: "2026-11-16 00:00:00",
};
const JOB: JobEntry = { job_name: "orders_ingest", schedule_type: "continuous", job_ids: ["7"], workspace_id: "1234" };

describe("workspace scope in job forms and matching", () => {
  it("round trips a workspace ID through form values", () => {
    const values = toFormValues(JOB, []);
    expect(values.workspace_id).toBe("1234");
    expect(toEntry(values, JOB).workspace_id).toBe("1234");
  });

  it("preserves an untouched explicit null scope during unrelated edits", () => {
    const job: JobEntry = { ...JOB, workspace_id: null };
    const values = toFormValues(job, []);
    expect(toEntry(values, job)).toEqual(job);
    expect(toEntry({ ...values, owner: "platform-team" }, job)).toMatchObject({ workspace_id: null, owner: "platform-team" });
  });

  it("a blank workspace field removes the scope", () => {
    const values = { ...toFormValues(JOB, []), workspace_id: "" };
    expect(toEntry(values, JOB)).not.toHaveProperty("workspace_id");
  });

  it("picker drafts retain the selected workspace and explicit schedule type", () => {
    const draft = draftFromRegionJob(PICKED, { jobs: [] });
    expect(draft).toMatchObject({ workspace_id: "1234", job_ids: ["7"], schedule_type: "scheduled" });
  });

  it("the same job ID in another workspace is not already monitored", () => {
    const doc: JobListDocument = { jobs: [JOB] };
    expect(isMonitored({ ...PICKED, workspace_id: "5678" }, doc)).toBeNull();
    expect(isMonitored(PICKED, doc)).toBe("orders_ingest");
  });

  it("a name pattern in another workspace is not already monitored", () => {
    const doc: JobListDocument = { jobs: [{ job_name: "orders_ingest", workspace_id: "1234", job_name_regex: "^orders_ingest$", schedule_type: "continuous" }] };
    expect(isMonitored({ ...PICKED, workspace_id: "5678" }, doc)).toBeNull();
  });

  it("matching previews carry the entry's actual workspace scope", () => {
    expect(entryJobIds(JOB)).toMatchObject({ workspaceId: "1234", jobIds: ["7"] });
  });
});
