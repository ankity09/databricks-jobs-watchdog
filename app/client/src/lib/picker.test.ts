import { describe, expect, it } from "vitest";
import type { JobListDocument } from "../../../shared/joblist/types";
import {
  RegionJobRow,
  draftFromRegionJob,
  entryJobIds,
  idUse,
  isMonitored,
  jobNameFromRealName,
  queryFailure,
  scheduleTypeOf,
  triggerLabel,
} from "./picker";

function row(overrides: Partial<RegionJobRow> = {}): RegionJobRow {
  return {
    workspace_id: "1111111111111111",
    workspace_name: "example-prod",
    job_id: "9007199254740993",
    name: "orders_ingest_prod",
    trigger_type: "CRON",
    paused: false,
    creator_user_name: "dana@example.com",
    change_time: "2026-11-04T10:00:00.000Z",
    ...overrides,
  };
}

const EMPTY: JobListDocument = { jobs: [] };

describe("scheduleTypeOf", () => {
  it.each([
    ["CRON", "scheduled"],
    ["PERIODIC", "scheduled"],
    ["cron", "scheduled"],
    ["CONTINUOUS", "continuous"],
    ["FILE_ARRIVAL", "triggered"],
    ["TABLE", "triggered"],
    ["MULTIPLE", "triggered"],
    ["", "triggered"],
    [null, "triggered"],
  ] as const)("reads trigger_type %s as %s", (trigger, expected) => {
    expect(scheduleTypeOf(trigger)).toBe(expected);
  });
});

describe("triggerLabel", () => {
  it("names each trigger type, and shows an unknown one as it came", () => {
    expect(triggerLabel("CRON")).toBe("Cron schedule");
    expect(triggerLabel("FILE_ARRIVAL")).toBe("File arrival");
    expect(triggerLabel(null)).toBe("None");
    expect(triggerLabel("MODEL")).toBe("MODEL");
    expect(triggerLabel("constructor")).toBe("constructor");
  });
});

describe("jobNameFromRealName", () => {
  it.each([
    ["orders_ingest_prod", "orders_ingest_prod"],
    ["Daily Revenue Report (EU)", "daily_revenue_report_eu"],
    ["orders-ingest.prod", "orders_ingest_prod"],
    ["Orders   Ingest", "orders_ingest"],
    ["[dev dana_lee] watchdog_demo_fails", "watchdog_demo_fails"],
    ["[DEV dana.lee] My Job!", "my_job"],
    ["_private_job", "_private_job"],
  ])("turns %s into %s", (real, expected) => {
    expect(jobNameFromRealName(real)).toBe(expected);
  });

  it("gives null when nothing usable is left", () => {
    expect(jobNameFromRealName("!!!")).toBeNull();
    expect(jobNameFromRealName("[dev dana] ")).toBeNull();
  });
});

describe("draftFromRegionJob", () => {
  it("fills in the name, the exact job ID and the schedule type, and leaves the gap for the form", () => {
    expect(draftFromRegionJob(row(), EMPTY)).toEqual({
      job_name: "orders_ingest_prod",
      job_ids: ["9007199254740993"],
      schedule_type: "scheduled",
    });
  });

  it("never sets max_gap_minutes, whatever the trigger", () => {
    for (const trigger_type of ["CRON", "CONTINUOUS", "FILE_ARRIVAL", null]) {
      expect(draftFromRegionJob(row({ trigger_type }), EMPTY)).not.toHaveProperty("max_gap_minutes");
    }
    expect(draftFromRegionJob(row({ trigger_type: "CONTINUOUS" }), EMPTY).schedule_type).toBe("continuous");
    expect(draftFromRegionJob(row({ trigger_type: null }), EMPTY).schedule_type).toBe("triggered");
  });

  it("picks a name that is not taken yet", () => {
    const taken: JobListDocument = { jobs: [{ job_name: "orders_ingest_prod" }, { job_name: "orders_ingest_prod_2" }] };
    expect(draftFromRegionJob(row(), taken).job_name).toBe("orders_ingest_prod_3");
  });

  it("falls back to the job ID when the real name has no usable characters", () => {
    expect(draftFromRegionJob(row({ name: "???" }), EMPTY).job_name).toBe("job_9007199254740993");
  });
});

describe("isMonitored", () => {
  it("matches a job ID listed on the entry", () => {
    const doc: JobListDocument = { jobs: [{ job_name: "orders", job_ids: ["123", "9007199254740993"] }] };
    expect(isMonitored(row(), doc)).toBe("orders");
    expect(isMonitored(row({ job_id: "9007199254740992" }), doc)).toBeNull();
  });

  it("matches a name pattern anywhere in the name, as the scan does", () => {
    const doc: JobListDocument = { jobs: [{ job_name: "orders_ingest", job_name_regex: "ingest_(prod|dev)$" }] };
    expect(isMonitored(row({ name: "orders_ingest_prod" }), doc)).toBe("orders_ingest");
    expect(isMonitored(row({ name: "orders_ingest_staging" }), doc)).toBeNull();
  });

  it("leaves out names the exclusion matches, including an exclusion from the defaults", () => {
    const doc: JobListDocument = {
      defaults: { job_name_exclude_regex: "_test(_|$)" },
      jobs: [{ job_name: "orders_ingest", job_name_regex: "^orders_ingest(_[a-z]+)?_(prod|dev)$" }],
    };
    expect(isMonitored(row({ name: "orders_ingest_test_prod" }), doc)).toBeNull();
    expect(isMonitored(row({ name: "orders_ingest_eu_prod" }), doc)).toBe("orders_ingest");
  });

  it("lets a job turn the default exclusion off with null", () => {
    const doc: JobListDocument = {
      defaults: { job_name_exclude_regex: "_test(_|$)" },
      jobs: [{ job_name: "orders_ingest", job_name_regex: "^orders_ingest", job_name_exclude_regex: null }],
    };
    expect(isMonitored(row({ name: "orders_ingest_test_prod" }), doc)).toBe("orders_ingest");
  });

  it("matches the exact job name when the entry has no pattern", () => {
    const doc: JobListDocument = { jobs: [{ job_name: "daily_report" }] };
    expect(isMonitored(row({ name: "daily_report" }), doc)).toBe("daily_report");
    expect(isMonitored(row({ name: "daily_report_v2" }), doc)).toBeNull();
  });

  it("uses an environment's job IDs in that environment's workspaces, and the pattern elsewhere", () => {
    const doc: JobListDocument = {
      workspaces: [{ workspace_name: "Example-Prod", environment: "production" }],
      jobs: [{ job_name: "orders_enrich", job_name_regex: "^orders_enrich_", environments: { production: { job_ids: ["555"] } } }],
    };
    expect(isMonitored(row({ workspace_name: "example-prod", job_id: "555", name: "renamed" }), doc)).toBe("orders_enrich");
    expect(isMonitored(row({ workspace_name: "example-prod", job_id: "777", name: "orders_enrich_web_prod" }), doc)).toBeNull();
    expect(isMonitored(row({ workspace_name: "example-staging", job_id: "777", name: "orders_enrich_web_dev" }), doc)).toBe(
      "orders_enrich",
    );
  });

  it("finds a workspace's label by ID before its name", () => {
    const doc: JobListDocument = {
      workspaces: [
        { workspace_name: "example-prod", environment: "production" },
        { workspace_id: "1111111111111111", environment: "lower" },
      ],
      jobs: [{ job_name: "orders", job_name_regex: "^orders_", environments: { production: { job_ids: ["555"] } } }],
    };
    // By ID the workspace is lower, where no job IDs apply, so the name pattern decides.
    expect(isMonitored(row({ name: "orders_ingest_prod" }), doc)).toBe("orders");
  });

  it("ignores a pattern that does not compile, and a row without a name", () => {
    const doc: JobListDocument = { jobs: [{ job_name: "broken", job_name_regex: "(" }, { job_name: "any", job_name_regex: "." }] };
    expect(isMonitored(row({ name: "x" }), doc)).toBe("any");
    expect(isMonitored(row({ name: null }), doc)).toBeNull();
  });
});

describe("RegionJobRow", () => {
  it("reads the warehouse's JSON strings: paused as a boolean, nulls as nulls", () => {
    const parsed = RegionJobRow.parse({
      workspace_id: "1111111111111111",
      workspace_name: null,
      job_id: "9007199254740993",
      name: "orders_ingest_prod",
      trigger_type: null,
      paused: "true",
      creator_user_name: null,
      change_time: "2026-11-04T10:00:00.000Z",
    });
    expect(parsed.paused).toBe(true);
    expect(parsed.workspace_name).toBeNull();
    expect(parsed.job_id).toBe("9007199254740993");
    expect(RegionJobRow.parse({ ...parsed, paused: "false" }).paused).toBe(false);
    expect(RegionJobRow.parse({ ...parsed, paused: false }).paused).toBe(false);
    expect(RegionJobRow.parse({ ...parsed, paused: null }).paused).toBeNull();
  });

  it("turns a name AppKit parsed as JSON back into text", () => {
    // AppKit JSON-parses STRING values that start with [ or {, so a job named [1] arrives as an array.
    expect(RegionJobRow.parse({ ...row(), name: [1] }).name).toBe("[1]");
  });

  it("rejects a row of the wrong shape", () => {
    expect(RegionJobRow.safeParse({ ...row(), paused: "maybe" }).success).toBe(false);
    expect(RegionJobRow.safeParse({ workspace_id: "1" }).success).toBe(false);
  });
});

describe("queryFailure", () => {
  it("reads a named permission error as no access", () => {
    expect(queryFailure("Query execution failed", "PERMISSION_DENIED")).toBe("no_access");
    expect(queryFailure("[INSUFFICIENT_PERMISSIONS] Insufficient privileges", null)).toBe("no_access");
  });

  it("reads a statement the warehouse refused as rejected", () => {
    // What a missing grant and a bad regex both look like once AppKit hides the message.
    expect(queryFailure("Query execution failed", "BAD_REQUEST")).toBe("rejected");
  });

  it("reads anything else as another failure", () => {
    expect(queryFailure("Network error. Please check your connection.", null)).toBe("other");
    expect(queryFailure("Query execution failed", "WAREHOUSE_UNAVAILABLE")).toBe("other");
  });
});

describe("entryJobIds", () => {
  it("takes the job's IDs, and each environment's own list where it sets one, an empty one too", () => {
    expect(
      entryJobIds({
        job_name: "orders_ingest",
        job_ids: ["9007199254740993"],
        environments: { lower: { job_ids: [] }, production: { job_ids: ["123"] }, staging: { enabled: false } },
      }),
    ).toEqual({ jobIds: ["9007199254740993"], environments: { lower: [], production: ["123"] } });
    expect(entryJobIds({ job_name: "orders_ingest" })).toEqual({ jobIds: [], environments: {} });
  });
});

describe("idUse", () => {
  it("finds the job by ID everywhere when it has IDs and no environment says otherwise", () => {
    expect(idUse({ jobIds: ["123"], environments: { production: ["456"] } })).toEqual({ byId: true, except: [] });
  });

  it("finds the job by name everywhere when no list has an ID", () => {
    expect(idUse({ jobIds: [], environments: { lower: [] } })).toEqual({ byId: false, except: [] });
  });

  it("names the environments whose own list turns the answer around, as the scan's coalesce does", () => {
    // An environment's empty list falls back to the name; its own IDs win over none.
    expect(idUse({ jobIds: ["123"], environments: { staging: [], lower: [] } })).toEqual({ byId: true, except: ["lower", "staging"] });
    expect(idUse({ jobIds: [], environments: { production: ["456"] } })).toEqual({ byId: false, except: ["production"] });
  });
});
