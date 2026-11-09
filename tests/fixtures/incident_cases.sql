-- Synthetic findings rows that cover every rule of the incidents view
-- (sql/views/02_incidents.sql). tests/incident_cases.py inserts them into a
-- scratch schema on a SQL warehouse, in two phases split at 02:30, and checks
-- the view against the incidents it expects.
--
-- Scans: SYSTEM_TABLES s1 to s4 (00:00 to 03:00, s4 the newest), JOBS_API
-- j1 to j3 (00:05 to 02:05) plus a re-run of j1 at 03:30, CUSTOM c1 to c3.
-- Status letters in the notes: H HEALTHY, F FAILED, W WARNING, U UNKNOWN, - absent.
--
--   case                                     key (job, check)                  scans
--   A  a new problem                          orders_ingest last_run_result     H H H F
--   B  open across 3 scans                    orders_enrich task_failures       H F F F
--   C  FAILED, WARNING, FAILED: one incident  daily_revenue_report last_run     H F W F
--   C2 WARNING only                           daily_revenue_export long_runtime H H W W
--   C3 FAILED then WARNING, newest row wins   customer_sync last_run_result     H H F W
--   D  resolved                               inventory_load last_run_result    F F H H
--   E  reopened after it resolved: two        payments_export last_run_result   F H F F
--   F  UNKNOWN in between: one incident       clickstream_load last_run_result  F U F F
--   G  absent from the newest scan            ledger_close last_run_result      H F F -
--   H  absent, then back: the same incident   ledger_post last_run_result       F - - F
--   K  no job ID                              audit_export duplicate_name       - W W W
--   M  UNKNOWN in the newest scan             fx_rates_load last_run_result     H F U U
--   N1 never a problem                        catalog_sync last_run_result      H H H H
--   N2 UNKNOWN only, no workspace or job ID   legacy_report not_found           U U U U
--   O  resolved in the newest scan            shipping_load last_run_result     H H F H
--   L  the same job from the Jobs API         orders_ingest live_run_status     j: H F F
--   J1 one name, job ID 112                   orders_api live_run_status        j: H F F
--   J2 one name, job ID 113                   orders_api live_run_status        j: H H F
--   I  a re-run of old scan j1 adds a FAILED  refund_api live_run_status        j: - H H, then F in j1 at 03:30
--   P  CUSTOM, no workspace or job ID         kafka service_connectivity        c: F F H
--   Q  CUSTOM, still open                     schema_registry service_conn.     c: H W W
--   R  a custom status keeps it open          metrics_api service_conn.         c: F SKIPPED SKIPPED
--
-- All names, IDs and hosts are made up.
SELECT
  CAST(observed_at AS TIMESTAMP) AS observed_at,
  scan_id,
  CAST(NULL AS STRING) AS account_id,
  'us-west-2' AS region,
  workspace_id,
  CASE WHEN workspace_id IS NOT NULL THEN 'analytics' END AS workspace_name,
  job_id,
  job_name,
  check_id,
  status,
  severity,
  CASE status WHEN 'HEALTHY' THEN 'NONE' WHEN 'UNKNOWN' THEN 'COVERAGE' ELSE 'FUNCTIONAL' END AS failure_category,
  CAST(NULL AS STRING) AS run_id,
  CASE WHEN job_id IS NOT NULL THEN concat('https://workspace.example.com/jobs/', job_id, '/runs/', scan_id) END
    AS run_page_url,
  CAST(NULL AS ARRAY<STRING>) AS failed_task_keys,
  error_summary,
  affected_jobs,
  owner,
  source,
  CASE WHEN workspace_id IS NOT NULL THEN 'production' END AS environment,
  CASE WHEN source <> 'CUSTOM' THEN 'scheduled' END AS schedule_type,
  CAST(NULL AS TIMESTAMP) AS run_start_time,
  CAST(NULL AS TIMESTAMP) AS run_end_time,
  CAST(NULL AS BIGINT) AS run_duration_seconds,
  CAST(NULL AS STRING) AS trigger_type,
  CAST(NULL AS STRING) AS triggered_by,
  CAST(NULL AS MAP<STRING, STRING>) AS job_tags,
  CAST(NULL AS STRING) AS code_version,
  CAST(NULL AS STRING) AS pipeline_url,
  CAST(NULL AS STRING) AS parent_job
FROM VALUES
  -- SYSTEM_TABLES scan s1
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '101', 'orders_ingest', 'last_run_result', 'HEALTHY', NULL, 'ingestion-team', 'A s1 ok', CAST(NULL AS ARRAY<STRING>)),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '102', 'orders_enrich', 'task_failures', 'HEALTHY', NULL, 'ingestion-team', 'B s1 ok', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '103', 'daily_revenue_report', 'last_run_result', 'HEALTHY', NULL, 'finance-team', 'C s1 ok', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '104', 'daily_revenue_export', 'long_runtime', 'HEALTHY', NULL, 'finance-team', 'C2 s1 ok', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '105', 'customer_sync', 'last_run_result', 'HEALTHY', NULL, 'crm-team', 'C3 s1 ok', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '106', 'inventory_load', 'last_run_result', 'FAILED', 'CRITICAL', 'ingestion-team', 'D s1 failed', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '107', 'payments_export', 'last_run_result', 'FAILED', 'CRITICAL', 'finance-team', 'E s1 failed', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '108', 'clickstream_load', 'last_run_result', 'FAILED', 'CRITICAL', 'ingestion-team', 'F s1 failed', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '109', 'ledger_close', 'last_run_result', 'HEALTHY', NULL, 'finance-team', 'G s1 ok', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '110', 'ledger_post', 'last_run_result', 'FAILED', 'CRITICAL', 'finance-team', 'H s1 failed', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '114', 'fx_rates_load', 'last_run_result', 'HEALTHY', NULL, 'finance-team', 'M s1 ok', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '116', 'catalog_sync', 'last_run_result', 'HEALTHY', NULL, 'platform-team', 'N1 s1 ok', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', NULL, NULL, 'legacy_report', 'not_found', 'UNKNOWN', NULL, 'platform-team', 'N2 s1 not found', NULL),
  ('2026-11-01 00:00:00', '20261101T000000Z', 'SYSTEM_TABLES', '1111111111111111', '115', 'shipping_load', 'last_run_result', 'HEALTHY', NULL, 'ingestion-team', 'O s1 ok', NULL),
  -- SYSTEM_TABLES scan s2
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '101', 'orders_ingest', 'last_run_result', 'HEALTHY', NULL, 'ingestion-team', 'A s2 ok', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '102', 'orders_enrich', 'task_failures', 'FAILED', 'CRITICAL', 'ingestion-team', 'B s2 failed', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '103', 'daily_revenue_report', 'last_run_result', 'FAILED', 'CRITICAL', 'finance-team', 'C s2 failed', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '104', 'daily_revenue_export', 'long_runtime', 'HEALTHY', NULL, 'finance-team', 'C2 s2 ok', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '105', 'customer_sync', 'last_run_result', 'HEALTHY', NULL, 'crm-team', 'C3 s2 ok', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '106', 'inventory_load', 'last_run_result', 'FAILED', 'CRITICAL', 'ingestion-team', 'D s2 failed', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '107', 'payments_export', 'last_run_result', 'HEALTHY', NULL, 'finance-team', 'E s2 ok', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '108', 'clickstream_load', 'last_run_result', 'UNKNOWN', NULL, 'ingestion-team', 'F s2 no finished run', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '109', 'ledger_close', 'last_run_result', 'FAILED', 'CRITICAL', 'finance-team', 'G s2 failed', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', NULL, 'audit_export', 'duplicate_name', 'WARNING', 'WARNING', 'platform-team', 'K s2 two jobs share a name', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '114', 'fx_rates_load', 'last_run_result', 'FAILED', 'CRITICAL', 'finance-team', 'M s2 failed', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '116', 'catalog_sync', 'last_run_result', 'HEALTHY', NULL, 'platform-team', 'N1 s2 ok', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', NULL, NULL, 'legacy_report', 'not_found', 'UNKNOWN', NULL, 'platform-team', 'N2 s2 not found', NULL),
  ('2026-11-01 01:00:00', '20261101T010000Z', 'SYSTEM_TABLES', '1111111111111111', '115', 'shipping_load', 'last_run_result', 'HEALTHY', NULL, 'ingestion-team', 'O s2 ok', NULL),
  -- SYSTEM_TABLES scan s3
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '101', 'orders_ingest', 'last_run_result', 'HEALTHY', NULL, 'ingestion-team', 'A s3 ok', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '102', 'orders_enrich', 'task_failures', 'FAILED', 'CRITICAL', 'ingestion-team', 'B s3 failed', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '103', 'daily_revenue_report', 'last_run_result', 'WARNING', 'WARNING', 'finance-team', 'C s3 cancelled', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '104', 'daily_revenue_export', 'long_runtime', 'WARNING', 'WARNING', 'finance-team', 'C2 s3 long', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '105', 'customer_sync', 'last_run_result', 'FAILED', 'CRITICAL', 'crm-team', 'C3 s3 failed', array('orders_enrich')),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '106', 'inventory_load', 'last_run_result', 'HEALTHY', NULL, 'ingestion-team', 'D s3 ok', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '107', 'payments_export', 'last_run_result', 'FAILED', 'CRITICAL', 'finance-team', 'E s3 failed', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '108', 'clickstream_load', 'last_run_result', 'FAILED', 'CRITICAL', 'ingestion-team', 'F s3 failed', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '109', 'ledger_close', 'last_run_result', 'FAILED', 'CRITICAL', 'finance-team', 'G s3 failed', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', NULL, 'audit_export', 'duplicate_name', 'WARNING', 'WARNING', 'platform-team', 'K s3 two jobs share a name', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '114', 'fx_rates_load', 'last_run_result', 'UNKNOWN', NULL, 'finance-team', 'M s3 no finished run', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '116', 'catalog_sync', 'last_run_result', 'HEALTHY', NULL, 'platform-team', 'N1 s3 ok', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', NULL, NULL, 'legacy_report', 'not_found', 'UNKNOWN', NULL, 'platform-team', 'N2 s3 not found', NULL),
  ('2026-11-01 02:00:00', '20261101T020000Z', 'SYSTEM_TABLES', '1111111111111111', '115', 'shipping_load', 'last_run_result', 'FAILED', 'CRITICAL', 'ingestion-team', 'O s3 failed', NULL),
  -- SYSTEM_TABLES scan s4, the newest (phase 2)
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '101', 'orders_ingest', 'last_run_result', 'FAILED', 'CRITICAL', 'ingestion-team', 'A s4 failed', array('orders_enrich')),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '102', 'orders_enrich', 'task_failures', 'FAILED', 'CRITICAL', 'ingestion-team', 'B s4 failed', NULL),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '103', 'daily_revenue_report', 'last_run_result', 'FAILED', 'CRITICAL', 'finance-team', 'C s4 failed', array('daily_revenue_export')),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '104', 'daily_revenue_export', 'long_runtime', 'WARNING', 'WARNING', 'finance-team', 'C2 s4 long', NULL),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '105', 'customer_sync', 'last_run_result', 'WARNING', 'WARNING', 'crm-oncall', 'C3 s4 cancelled', NULL),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '106', 'inventory_load', 'last_run_result', 'HEALTHY', NULL, 'ingestion-team', 'D s4 ok', NULL),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '107', 'payments_export', 'last_run_result', 'FAILED', 'CRITICAL', 'finance-team', 'E s4 failed', NULL),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '108', 'clickstream_load', 'last_run_result', 'FAILED', 'CRITICAL', 'ingestion-team', 'F s4 failed', NULL),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '110', 'ledger_post', 'last_run_result', 'FAILED', 'CRITICAL', 'finance-team', 'H s4 failed', NULL),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', NULL, 'audit_export', 'duplicate_name', 'WARNING', 'WARNING', 'platform-team', 'K s4 two jobs share a name', NULL),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '114', 'fx_rates_load', 'last_run_result', 'UNKNOWN', NULL, 'finance-team', 'M s4 no finished run', NULL),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '116', 'catalog_sync', 'last_run_result', 'HEALTHY', NULL, 'platform-team', 'N1 s4 ok', NULL),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', NULL, NULL, 'legacy_report', 'not_found', 'UNKNOWN', NULL, 'platform-team', 'N2 s4 not found', NULL),
  ('2026-11-01 03:00:00', '20261101T030000Z', 'SYSTEM_TABLES', '1111111111111111', '115', 'shipping_load', 'last_run_result', 'HEALTHY', NULL, 'ingestion-team', 'O s4 ok', NULL),
  -- JOBS_API scans j1 to j3
  ('2026-11-01 00:05:00', '20261101T000500Z', 'JOBS_API', '1111111111111111', '101', 'orders_ingest', 'live_run_status', 'HEALTHY', NULL, 'ingestion-team', 'L j1 ok', NULL),
  ('2026-11-01 00:05:00', '20261101T000500Z', 'JOBS_API', '1111111111111111', '112', 'orders_api', 'live_run_status', 'HEALTHY', NULL, 'api-team', 'J1 j1 ok', NULL),
  ('2026-11-01 00:05:00', '20261101T000500Z', 'JOBS_API', '1111111111111111', '113', 'orders_api', 'live_run_status', 'HEALTHY', NULL, 'api-team', 'J2 j1 ok', NULL),
  ('2026-11-01 01:05:00', '20261101T010500Z', 'JOBS_API', '1111111111111111', '101', 'orders_ingest', 'live_run_status', 'FAILED', 'CRITICAL', 'ingestion-team', 'L j2 failed', NULL),
  ('2026-11-01 01:05:00', '20261101T010500Z', 'JOBS_API', '1111111111111111', '112', 'orders_api', 'live_run_status', 'FAILED', 'CRITICAL', 'api-team', 'J1 j2 failed', NULL),
  ('2026-11-01 01:05:00', '20261101T010500Z', 'JOBS_API', '1111111111111111', '113', 'orders_api', 'live_run_status', 'HEALTHY', NULL, 'api-team', 'J2 j2 ok', NULL),
  ('2026-11-01 01:05:00', '20261101T010500Z', 'JOBS_API', '1111111111111111', '117', 'refund_api', 'live_run_status', 'HEALTHY', NULL, 'api-team', 'I j2 ok', NULL),
  ('2026-11-01 02:05:00', '20261101T020500Z', 'JOBS_API', '1111111111111111', '101', 'orders_ingest', 'live_run_status', 'FAILED', 'CRITICAL', 'ingestion-team', 'L j3 failed', NULL),
  ('2026-11-01 02:05:00', '20261101T020500Z', 'JOBS_API', '1111111111111111', '112', 'orders_api', 'live_run_status', 'FAILED', 'CRITICAL', 'api-team', 'J1 j3 failed', NULL),
  ('2026-11-01 02:05:00', '20261101T020500Z', 'JOBS_API', '1111111111111111', '113', 'orders_api', 'live_run_status', 'FAILED', 'CRITICAL', 'api-team', 'J2 j3 failed', NULL),
  ('2026-11-01 02:05:00', '20261101T020500Z', 'JOBS_API', '1111111111111111', '117', 'refund_api', 'live_run_status', 'HEALTHY', NULL, 'api-team', 'I j3 ok', NULL),
  -- a re-run of the old scan j1 at 03:30 adds a row for a key j1 did not have (phase 2)
  ('2026-11-01 03:30:00', '20261101T000500Z', 'JOBS_API', '1111111111111111', '117', 'refund_api', 'live_run_status', 'FAILED', 'CRITICAL', 'api-team', 'I j1 re-run failed', NULL),
  -- CUSTOM scans c1 to c3: service checks have no workspace or job ID
  ('2026-11-01 00:10:00', '20261101T001000Z', 'CUSTOM', NULL, NULL, 'kafka', 'service_connectivity', 'FAILED', 'WARNING', 'platform-team', 'P c1 unreachable', array('orders_ingest')),
  ('2026-11-01 00:10:00', '20261101T001000Z', 'CUSTOM', NULL, NULL, 'schema_registry', 'service_connectivity', 'HEALTHY', NULL, 'platform-team', 'Q c1 reachable', NULL),
  ('2026-11-01 01:10:00', '20261101T011000Z', 'CUSTOM', NULL, NULL, 'kafka', 'service_connectivity', 'FAILED', 'WARNING', 'platform-team', 'P c2 unreachable', array('orders_ingest')),
  ('2026-11-01 01:10:00', '20261101T011000Z', 'CUSTOM', NULL, NULL, 'schema_registry', 'service_connectivity', 'WARNING', 'WARNING', 'platform-team', 'Q c2 slow handshake', NULL),
  ('2026-11-01 02:10:00', '20261101T021000Z', 'CUSTOM', NULL, NULL, 'kafka', 'service_connectivity', 'HEALTHY', NULL, 'platform-team', 'P c3 reachable', NULL),
  ('2026-11-01 02:10:00', '20261101T021000Z', 'CUSTOM', NULL, NULL, 'schema_registry', 'service_connectivity', 'WARNING', 'WARNING', 'platform-team', 'Q c3 slow handshake', NULL),
  -- a custom check may write a status of its own: like UNKNOWN, it neither opens nor ends an incident
  ('2026-11-01 00:10:00', '20261101T001000Z', 'CUSTOM', NULL, NULL, 'metrics_api', 'service_connectivity', 'FAILED', 'WARNING', 'platform-team', 'R c1 unreachable', NULL),
  ('2026-11-01 01:10:00', '20261101T011000Z', 'CUSTOM', NULL, NULL, 'metrics_api', 'service_connectivity', 'SKIPPED', NULL, 'platform-team', 'R c2 probe skipped', NULL),
  ('2026-11-01 02:10:00', '20261101T021000Z', 'CUSTOM', NULL, NULL, 'metrics_api', 'service_connectivity', 'SKIPPED', NULL, 'platform-team', 'R c3 probe skipped', NULL)
AS cases(observed_at, scan_id, source, workspace_id, job_id, job_name, check_id, status, severity, owner, error_summary,
         affected_jobs)
