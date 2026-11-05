import { describe, expect, it } from "vitest";
import { CheckRow, FreshnessRow, HistoryRow, JobStatusRow, parseRows } from "./rows";

/** A job_status row as AppKit sends it: arrays as JSON text, times as ISO strings, NULL as null. */
function statusRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_name: "orders_ingest",
    workspace_id: "1234567890123456",
    job_id: "987654321012345",
    workspace_name: "example-prod",
    environment: "production",
    owner: "platform-team",
    schedule_type: "scheduled",
    parent_job: null,
    status: "FAILED",
    severity: "CRITICAL",
    failing_checks: '["last_run_result","task_failures"]',
    top_error: "load: ValueError: bad input",
    last_run_start: "2026-11-05T10:00:02.489Z",
    last_run_url: "https://workspace.example.com/jobs/987654321012345/runs/1",
    observed_at: "2026-11-05T10:05:12.345Z",
    ...overrides,
  };
}

function checkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_name: "orders_ingest",
    workspace_id: "1234567890123456",
    workspace_name: "example-prod",
    job_id: "987654321012345",
    environment: "production",
    owner: "platform-team",
    schedule_type: "scheduled",
    parent_job: null,
    check_id: "live_task_failures",
    source: "JOBS_API",
    status: "FAILED",
    severity: "CRITICAL",
    failure_category: "FUNCTIONAL",
    error_summary: "load: ValueError: bad input",
    run_id: "222222222222222",
    run_page_url: "https://workspace.example.com/jobs/987654321012345/runs/222222222222222",
    failed_task_keys: '["load"]',
    affected_jobs: '["daily_revenue_report"]',
    code_version: "main@f6509ec",
    pipeline_url: "https://git.example.com/pipelines/42",
    trigger_type: "SCHEDULE",
    triggered_by: null,
    run_start_time: "2026-11-05T10:00:02.489Z",
    run_end_time: "2026-11-05T10:00:33.912Z",
    run_duration_seconds: "31",
    observed_at: "2026-11-05T10:05:12.345Z",
    ...overrides,
  };
}

describe("parseRows", () => {
  it("parses a not_found row, which has no workspace and no job ID", () => {
    const notFound = statusRow({
      workspace_id: null,
      job_id: null,
      workspace_name: null,
      status: "UNKNOWN",
      failing_checks: '["not_found"]',
      top_error: "No job named orders_ingest was found in any workspace.",
      last_run_start: null,
      last_run_url: null,
    });
    const { rows, bad } = parseRows(JobStatusRow, [notFound]);
    expect(bad).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspace_id).toBeNull();
    expect(rows[0]?.job_id).toBeNull();
    expect(rows[0]?.status).toBe("UNKNOWN");
    expect(rows[0]?.failing_checks).toEqual(["not_found"]);
  });

  it("counts a row with an unknown status as bad, and keeps the others", () => {
    const { rows, bad } = parseRows(JobStatusRow, [statusRow(), statusRow({ job_name: "odd_job", status: "BROKEN" })]);
    expect(bad).toBe(1);
    expect(rows.map((row) => row.job_name)).toEqual(["orders_ingest"]);
  });

  it("keeps a row whose severity is new to the app, with no severity", () => {
    const { rows, bad } = parseRows(JobStatusRow, [statusRow({ severity: "INFO" }), statusRow({ job_name: "b", severity: null })]);
    expect(bad).toBe(0);
    expect(rows.map((row) => row.severity)).toEqual([null, null]);
  });

  it("keeps timestamps as the strings they arrive as, and rejects a time that is not one", () => {
    const { rows } = parseRows(JobStatusRow, [statusRow()]);
    expect(rows[0]?.observed_at).toBe("2026-11-05T10:05:12.345Z");
    expect(rows[0]?.last_run_start).toBe("2026-11-05T10:00:02.489Z");
    expect(parseRows(JobStatusRow, [statusRow({ observed_at: "yesterday" })]).bad).toBe(1);
  });

  it("reads arrays sent as JSON text, and an empty or missing array as []", () => {
    const { rows } = parseRows(JobStatusRow, [
      statusRow({ failing_checks: "[]" }),
      statusRow({ job_name: "b", failing_checks: null }),
      statusRow({ job_name: "c", failing_checks: ["schedule_gap"] }),
    ]);
    expect(rows.map((row) => row.failing_checks)).toEqual([[], [], ["schedule_gap"]]);
    expect(parseRows(JobStatusRow, [statusRow({ failing_checks: "[not json" })]).bad).toBe(1);
  });

  it("turns error text that AppKit read as JSON back into text", () => {
    // AppKit JSON-parses STRING values that start with { or [, so an error message can arrive as an object.
    const { rows } = parseRows(CheckRow, [checkRow({ error_summary: { error_code: "RESOURCE_EXHAUSTED" } })]);
    expect(rows[0]?.error_summary).toBe('{"error_code":"RESOURCE_EXHAUSTED"}');
  });

  it("parses a check row: lists from JSON text, the duration from a BIGINT string", () => {
    const { rows, bad } = parseRows(CheckRow, [checkRow(), checkRow({ check_id: "schedule_gap", status: "HEALTHY", severity: null, failed_task_keys: null, affected_jobs: null, run_duration_seconds: null })]);
    expect(bad).toBe(0);
    expect(rows[0]?.failed_task_keys).toEqual(["load"]);
    expect(rows[0]?.affected_jobs).toEqual(["daily_revenue_report"]);
    expect(rows[0]?.run_duration_seconds).toBe(31);
    expect(rows[1]?.affected_jobs).toEqual([]);
    expect(rows[1]?.run_duration_seconds).toBeNull();
    expect(parseRows(CheckRow, [checkRow({ run_duration_seconds: "thirty" })]).bad).toBe(1);
  });

  it("parses history and freshness rows", () => {
    const history = parseRows(HistoryRow, [
      { job_name: "orders_ingest", workspace_id: null, job_id: null, scan_id: "101", observed_at: "2026-11-05T09:05:00Z", status: "UNKNOWN" },
      { job_name: "orders_ingest", workspace_id: "1", job_id: "2", scan_id: "102", observed_at: "2026-11-05T10:05:00Z", status: "NOPE" },
    ]);
    expect(history.rows).toHaveLength(1);
    expect(history.bad).toBe(1);
    const freshness = parseRows(FreshnessRow, [
      { source: "SYSTEM_TABLES", last_observed_at: "2026-11-05T10:05:00Z", scan_id: "102" },
      { source: "JOBS_API", last_observed_at: null, scan_id: null },
    ]);
    expect(freshness).toEqual({
      rows: [
        { source: "SYSTEM_TABLES", last_observed_at: "2026-11-05T10:05:00Z", scan_id: "102" },
        { source: "JOBS_API", last_observed_at: null, scan_id: null },
      ],
      bad: 0,
    });
  });

  it("treats an answer that is not a list as one bad row", () => {
    expect(parseRows(JobStatusRow, { rows: [] })).toEqual({ rows: [], bad: 1 });
    expect(parseRows(JobStatusRow, [])).toEqual({ rows: [], bad: 0 });
  });
});
