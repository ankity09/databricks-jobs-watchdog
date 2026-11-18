import { describe, expect, it } from "vitest";
import type { JobListDocument } from "../../shared/joblist/types";
import { parseJobListYaml, toJobListYaml } from "./yaml";

const META = { version: 1, savedAt: "2026-11-16T00:00:00Z", savedBy: "someone@example.com" };


describe("explicit schedule types in exported YAML", () => {
  it("writes an inherited continuous type without freezing the stored job", () => {
    const document: JobListDocument = { defaults: { schedule_type: "continuous" }, jobs: [{ job_name: "orders_ingest" }] };
    const before = JSON.stringify(document);
    const exported = parseJobListYaml(toJobListYaml(document, META));
    expect(exported.jobs[0].schedule_type).toBe("continuous");
    expect(JSON.stringify(document)).toBe(before);
    expect(document.jobs[0]).not.toHaveProperty("schedule_type");
  });

  it("writes the built-in scheduled type for an old job that omitted it", () => {
    const document: JobListDocument = { jobs: [{ job_name: "daily_report", max_gap_minutes: 1500 }] };
    expect(parseJobListYaml(toJobListYaml(document, META)).jobs[0].schedule_type).toBe("scheduled");
  });

  it("keeps an explicit child type and its exact workspace ID", () => {
    const document: JobListDocument = {
      defaults: { schedule_type: "continuous" },
      jobs: [{ job_name: "report_export", workspace_id: "9007199254740993", schedule_type: "triggered" }],
    };
    const job = parseJobListYaml(toJobListYaml(document, META)).jobs[0];
    expect(job.schedule_type).toBe("triggered");
    expect(job.workspace_id).toBe("9007199254740993");
  });
});
