import type { JobListDocument } from "../../../shared/joblist/types";

/**
 * config/monitored_jobs.example.yml as the app stores it (job IDs as strings),
 * for client tests. Four demo jobs, four pipeline jobs, three services.
 */
export const EXAMPLE_DOCUMENT: JobListDocument = {
  defaults: { schedule_type: "scheduled", severity: "WARNING", owner: "platform-team", job_name_exclude_regex: "_test(_|$)" },
  workspaces: [
    { workspace_name: "example-prod", environment: "production" },
    { workspace_name: "example-prod-eu", environment: "production", notes: "Production in a second region; that region runs its own Watchdog" },
    { workspace_name: "example-staging", environment: "lower" },
    { workspace_id: "1111111111111111", environment: "lower", notes: "Development, given by workspace ID instead of name" },
  ],
  jobs: [
    { job_name: "watchdog_demo_succeeds", job_name_regex: "watchdog_demo_succeeds", max_gap_minutes: 1440, max_runtime_minutes: 30, max_retries: 1 },
    { job_name: "watchdog_demo_fails", job_name_regex: "watchdog_demo_fails", max_gap_minutes: 1440, max_runtime_minutes: 30, max_retries: 1, severity: "CRITICAL" },
    { job_name: "watchdog_demo_slow", job_name_regex: "watchdog_demo_slow", max_gap_minutes: 300, max_runtime_minutes: 1, max_retries: 1 },
    { job_name: "watchdog_demo_retries", job_name_regex: "watchdog_demo_retries", max_gap_minutes: 420, max_runtime_minutes: 30, max_retries: 1 },
    {
      job_name: "orders_ingest",
      job_name_regex: "^orders_ingest(_[a-z]+)?_(prod|dev)$",
      schedule_type: "continuous",
      max_retries: 3,
      min_attempt_minutes: 10,
      severity: "CRITICAL",
      owner: "ingestion-team",
      enabled: false,
      environments: { lower: { severity: "WARNING" } },
    },
    {
      job_name: "orders_enrich",
      job_name_regex: "^orders_enrich_(web|mobile)(_(eu|us))?_(prod|dev)$",
      max_gap_minutes: 90,
      max_runtime_minutes: 45,
      max_retries: 2,
      owner: "ingestion-team",
      enabled: false,
      environments: { lower: { enabled: false }, production: { job_ids: ["123456789012345", "234567890123456"] } },
    },
    {
      job_name: "daily_revenue_report",
      job_name_regex: "^daily_revenue_report(_(eu|us))?_(prod|dev)$",
      max_gap_minutes: 1500,
      max_runtime_minutes: 120,
      max_retries: 1,
      owner: "analytics-team",
      enabled: false,
      environments: { lower: { max_gap_minutes: 4500, owner: "analytics-dev" } },
    },
    {
      job_name: "daily_revenue_export",
      job_name_regex: "^daily_revenue_export(_(eu|us))?_(prod|dev)$",
      schedule_type: "triggered",
      max_runtime_minutes: 30,
      owner: "analytics-team",
      enabled: false,
    },
  ],
  dependencies: [
    { job_name: "watchdog_demo_succeeds", depends_on: "watchdog_demo_fails", dependency_type: "job" },
    { job_name: "orders_enrich", depends_on: "orders_ingest", dependency_type: "job" },
    { job_name: "daily_revenue_report", depends_on: "orders_enrich", dependency_type: "job" },
    { job_name: "daily_revenue_export", depends_on: "daily_revenue_report", dependency_type: "child_job", notes: "daily_revenue_report starts it as its last task." },
    { job_name: "orders_ingest", depends_on: "kafka", dependency_type: "service", notes: "Reads order events from Kafka." },
    { job_name: "orders_enrich", depends_on: "config_api", dependency_type: "service", notes: "Looks up customer settings from a config service." },
    { job_name: "daily_revenue_export", depends_on: "object_storage", dependency_type: "service", notes: "Writes the export files to a storage bucket." },
  ],
};
