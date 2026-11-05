/** Rows as the Monitoring queries send them (arrays as JSON text, times as ISO strings), for the page's tests. */

export function statusRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    job_name: "orders_ingest",
    workspace_id: "1001",
    job_id: "11",
    workspace_name: "example-prod",
    environment: "production",
    owner: "platform-team",
    schedule_type: "scheduled",
    parent_job: null,
    status: "HEALTHY",
    severity: null,
    failing_checks: "[]",
    top_error: "Newest run ended SUCCESS.",
    last_run_start: "2026-11-05T09:58:00.000Z",
    last_run_url: "https://workspace.example.com/jobs/11/runs/500",
    observed_at: "2026-11-05T10:05:00.000Z",
    ...overrides,
  };
}

/**
 * Seven jobs in two workspaces, and one the scan could not find. archive_cleanup
 * sorts first by name but has the lower severity, so only severity puts it third.
 * audit_rollup last ran two days before the others; inventory_snapshot never ran.
 */
export const STATUS_ROWS = [
  statusRow({ job_name: "customer_sync", workspace_id: "2002", workspace_name: "example-stage", job_id: "22", environment: "lower" }),
  statusRow({
    job_name: "archive_cleanup",
    workspace_id: "2002",
    workspace_name: "example-stage",
    job_id: "23",
    environment: "lower",
    owner: "security-ops",
    status: "FAILED",
    severity: "WARNING",
    failing_checks: '["last_run_result"]',
    top_error: "Newest finished run ended FAILED.",
  }),
  statusRow({
    job_name: "orders_ingest",
    status: "FAILED",
    severity: "CRITICAL",
    failing_checks: '["last_run_result","task_failures"]',
    top_error: "load: ValueError: bad input in prod",
  }),
  statusRow({ job_name: "audit_rollup", job_id: "14", owner: "security-ops", last_run_start: "2026-11-03T09:58:00.000Z" }),
  statusRow({
    job_name: "inventory_snapshot",
    workspace_id: null,
    job_id: null,
    workspace_name: null,
    environment: null,
    status: "UNKNOWN",
    severity: "CRITICAL",
    failing_checks: '["not_found"]',
    top_error: "No job named inventory_snapshot was found in any workspace.",
    last_run_start: null,
    last_run_url: null,
  }),
  statusRow({
    job_name: "daily_revenue_report",
    job_id: "12",
    owner: "finance-data",
    status: "WARNING",
    severity: "WARNING",
    failing_checks: '["long_runtime"]',
    top_error: "The newest finished run took 6 minutes. The limit is 3.",
  }),
  statusRow({
    job_name: "orders_ingest",
    workspace_id: "2002",
    workspace_name: "example-stage",
    job_id: "21",
    environment: "lower",
    status: "FAILED",
    severity: "WARNING",
    failing_checks: '["task_failures"]',
    top_error: "load: ValueError: bad input in stage",
    last_run_url: "https://workspace.example.com/jobs/21/runs/600",
  }),
  statusRow({
    job_name: "billing_export",
    job_id: "13",
    owner: "finance-data",
    status: "FAILED",
    severity: "CRITICAL",
    failing_checks: '["schedule_gap"]',
    top_error: "No run started in the last 48 hours.",
  }),
];

export function checkRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    job_name: "orders_ingest",
    workspace_id: "2002",
    workspace_name: "example-stage",
    job_id: "21",
    environment: "lower",
    owner: "platform-team",
    schedule_type: "scheduled",
    parent_job: null,
    check_id: "task_failures",
    source: "SYSTEM_TABLES",
    status: "FAILED",
    severity: "WARNING",
    failure_category: "FUNCTIONAL",
    error_summary: "load: ValueError: bad input in stage",
    run_id: "600",
    run_page_url: "https://workspace.example.com/jobs/21/runs/600",
    failed_task_keys: '["load"]',
    affected_jobs: '["daily_revenue_report"]',
    code_version: "main@f6509ec",
    pipeline_url: "https://git.example.com/pipelines/42",
    trigger_type: "SCHEDULE",
    triggered_by: null,
    run_start_time: "2026-11-05T10:00:02.000Z",
    run_end_time: "2026-11-05T10:00:33.000Z",
    run_duration_seconds: "31",
    observed_at: "2026-11-05T10:05:00.000Z",
    ...overrides,
  };
}

/** orders_ingest's checks in both workspaces: the panel for one workspace must show only that workspace's. */
export const ORDERS_INGEST_CHECKS = [
  checkRow({}),
  checkRow({ check_id: "last_run_result", workspace_id: "1001", workspace_name: "example-prod", job_id: "11", error_summary: "Only in the prod workspace" }),
  checkRow({
    check_id: "schedule_gap",
    status: "HEALTHY",
    severity: null,
    failure_category: "NONE",
    error_summary: "Newest run started 5 minutes ago.",
    failed_task_keys: null,
    affected_jobs: null,
  }),
];
