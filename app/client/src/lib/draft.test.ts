import { describe, expect, it } from "vitest";
import type { JobListDocument } from "../../../shared/joblist/types";
import { changeIssues, draftIssues, jobIssues, linksRemovedWith, workspaceIssues } from "./draft";

const DOC: JobListDocument = {
  defaults: { owner: "platform-team", job_name_exclude_regex: "_test(_|$)" },
  workspaces: [
    { workspace_name: "example-prod", environment: "production" },
    { workspace_id: "1111111111111111", environment: "lower" },
  ],
  jobs: [
    { job_name: "orders_ingest", job_name_regex: "^orders_ingest_(prod|dev)$", schedule_type: "continuous", severity: "CRITICAL" },
    { job_name: "orders_enrich", max_gap_minutes: 90, environments: { lower: { enabled: false } } },
  ],
  dependencies: [{ job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "job" }],
};

describe("draftIssues", () => {
  it("asks a scheduled draft for max_gap_minutes, on that field", () => {
    expect(draftIssues(DOC, { job_name: "daily_revenue_report", schedule_type: "scheduled" }, "create")).toEqual([
      { path: "jobs[daily_revenue_report].max_gap_minutes", message: "job daily_revenue_report: scheduled jobs need max_gap_minutes" },
    ]);
  });

  it("refuses a gap on a triggered draft", () => {
    expect(draftIssues(DOC, { job_name: "daily_revenue_export", schedule_type: "triggered", max_gap_minutes: 60 }, "create")).toEqual([
      {
        path: "jobs[daily_revenue_export].max_gap_minutes",
        message: "job daily_revenue_export: triggered jobs have no schedule check, so remove max_gap_minutes",
      },
    ]);
  });

  it("finds nothing wrong with a valid draft", () => {
    const draft = {
      job_name: "daily_revenue_report",
      max_gap_minutes: 1500,
      max_runtime_minutes: 120,
      environments: { lower: { max_gap_minutes: 4500 } },
    };
    expect(draftIssues(DOC, draft, "create")).toEqual([]);
  });

  it("refuses a create with a name the list already has", () => {
    expect(draftIssues(DOC, { job_name: "orders_ingest", max_gap_minutes: 60 }, "create")).toEqual([
      { path: "jobs[orders_ingest]", message: "duplicate job_name 'orders_ingest' in the job list" },
    ]);
  });

  it("checks an edit in place of the saved job, so its own name is not a duplicate", () => {
    expect(draftIssues(DOC, { job_name: "orders_enrich", max_gap_minutes: 120 }, "edit")).toEqual([]);
    expect(draftIssues(DOC, { job_name: "orders_enrich", max_gap_minutes: -5 }, "edit")).toEqual([
      {
        path: "jobs[orders_enrich].max_gap_minutes",
        message: "job orders_enrich: max_gap_minutes must be a whole number of zero or more, got -5",
      },
    ]);
  });

  it("asks a draft with no name for one", () => {
    const issues = draftIssues(DOC, { job_name: "", max_gap_minutes: 60 }, "create");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("jobs[2]");
    expect(issues[0]?.message).toContain("every job needs a job_name");
  });

  it("refuses an environment that is not a workspace label", () => {
    expect(
      draftIssues(DOC, { job_name: "orders_audit", max_gap_minutes: 60, environments: { staging: { severity: "WARNING" } } }, "create"),
    ).toEqual([
      {
        path: "jobs[orders_audit].environments.staging",
        message: "job orders_audit: environment 'staging' is not a label in the workspaces section (lower, production)",
      },
    ]);
  });

  it("never changes the document it checks", () => {
    const frozen = structuredClone(DOC);
    draftIssues(frozen, { job_name: "orders_ingest", max_gap_minutes: 60 }, "create");
    draftIssues(frozen, { job_name: "orders_enrich", max_gap_minutes: 1 }, "edit");
    expect(frozen).toEqual(DOC);
  });
});

describe("jobIssues", () => {
  it("puts each issue of the job on its field, without the 'job <name>:' prefix", () => {
    const grouped = jobIssues(
      [
        { path: "jobs[orders_audit].max_gap_minutes", message: "job orders_audit: scheduled jobs need max_gap_minutes" },
        { path: "jobs[orders_audit]", message: "duplicate job_name 'orders_audit' in the job list" },
        {
          path: "jobs[orders_audit].environments.lower.max_retries",
          message: "job orders_audit: environments.lower.max_retries must be a whole number of zero or more, got -1",
        },
        {
          path: "jobs[orders_audit].environments.staging",
          message: "job orders_audit: environment 'staging' is not a label in the workspaces section (lower)",
        },
        { path: "dependencies[a->b:job]", message: "dependency a -> b: a is not a configured job" },
      ],
      "orders_audit",
      3,
    );
    expect(grouped.fields).toEqual({
      max_gap_minutes: ["scheduled jobs need max_gap_minutes"],
      job_name: ["duplicate job_name 'orders_audit' in the job list"],
    });
    expect(grouped.environments).toEqual({
      lower: { label: [], fields: { max_retries: ["environments.lower.max_retries must be a whole number of zero or more, got -1"] } },
      staging: { label: ["environment 'staging' is not a label in the workspaces section (lower)"], fields: {} },
    });
    expect(grouped.other).toEqual([{ path: "dependencies[a->b:job]", message: "dependency a -> b: a is not a configured job" }]);
  });

  it("asks for a name when the draft has none", () => {
    const grouped = jobIssues([{ path: "jobs[3]", message: "every job needs a job_name, got {'job_name': ''}" }], "", 3);
    expect(grouped.fields).toEqual({ job_name: ["Enter a job name."] });
  });
});

describe("changeIssues", () => {
  it("names every job a new default breaks", () => {
    expect(changeIssues(DOC, { kind: "upsert", target: { type: "defaults" }, value: { owner: "data-team", severity: "WARNING" } })).toEqual(
      [],
    );
    // orders_enrich sets no schedule_type of its own, so a triggered default makes its own gap invalid.
    expect(changeIssues(DOC, { kind: "upsert", target: { type: "defaults" }, value: { schedule_type: "triggered" } })).toEqual([
      {
        path: "jobs[orders_enrich].max_gap_minutes",
        message: "job orders_enrich: triggered jobs have no schedule check, so remove max_gap_minutes",
      },
    ]);
    const broken = changeIssues(DOC, {
      kind: "upsert",
      target: { type: "defaults" },
      value: { owner: "platform-team", job_name_exclude_regex: "(" },
    });
    expect(broken.map((issue) => issue.path)).toEqual([
      "jobs[orders_ingest].job_name_exclude_regex",
      "jobs[orders_enrich].job_name_exclude_regex",
    ]);
  });

  it("refuses to remove a workspace label that a job still uses", () => {
    const issues = changeIssues(DOC, { kind: "delete", target: { type: "workspace", key: "1111111111111111" } });
    expect(issues[0]?.path).toBe("jobs[orders_enrich].environments.lower");
  });

  it("refuses to delete the last job", () => {
    const one: JobListDocument = { jobs: [{ job_name: "orders_ingest", max_gap_minutes: 60 }] };
    expect(changeIssues(one, { kind: "delete", target: { type: "job", name: "orders_ingest" } })).toEqual([
      { path: "jobs", message: "the job list lists no jobs" },
    ]);
  });

  it("turns a change that cannot apply into an issue", () => {
    expect(changeIssues(DOC, { kind: "delete", target: { type: "job", name: "no_such_job" } })).toEqual([
      { path: "", message: "there is nothing to delete at job:no_such_job" },
    ]);
  });
});

describe("linksRemovedWith", () => {
  it("lists the links a job delete also removes, and keeps a service link to a service of the same name", () => {
    const doc: JobListDocument = {
      jobs: [
        { job_name: "orders_ingest", max_gap_minutes: 60 },
        { job_name: "orders_enrich", max_gap_minutes: 60 },
        { job_name: "kafka_reader", max_gap_minutes: 60 },
      ],
      dependencies: [
        { job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "job" },
        { job_name: "orders_ingest", depends_on: "kafka", dependency_type: "service" },
        { job_name: "kafka_reader", depends_on: "orders_ingest", dependency_type: "service" },
      ],
    };
    expect(linksRemovedWith(doc, "orders_ingest")).toEqual([
      { job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "job" },
      { job_name: "orders_ingest", depends_on: "kafka", dependency_type: "service" },
    ]);
    expect(linksRemovedWith(doc, "no_such_job")).toEqual([]);
  });
});

describe("workspaceIssues", () => {
  it("accepts a new label, and refuses one for a workspace that already has a label", () => {
    expect(workspaceIssues(DOC, { workspace_id: "2222222222222222", environment: "lower" }, "create")).toEqual([]);
    expect(workspaceIssues(DOC, { workspace_id: "1111111111111111", environment: "production" }, "create")).toEqual([
      { path: "workspaces[2]", message: "workspace 1111111111111111 is listed twice in the job list" },
    ]);
    expect(workspaceIssues(DOC, { workspace_name: "EXAMPLE-PROD", environment: "lower" }, "create")).toEqual([
      { path: "workspaces[2]", message: "workspace example-prod is listed twice in the job list" },
    ]);
  });

  it("checks an edit in place, so moving a label away from a job's environment is caught", () => {
    expect(workspaceIssues(DOC, { workspace_id: "1111111111111111", environment: "staging" }, "edit")[0]?.path).toBe(
      "jobs[orders_enrich].environments.lower",
    );
  });

  it("asks for a workspace ID or name", () => {
    expect(workspaceIssues(DOC, { environment: "lower" }, "create")[0]?.message).toContain("set workspace_id or workspace_name");
  });
});
