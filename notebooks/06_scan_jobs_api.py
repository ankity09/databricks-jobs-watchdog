# Databricks notebook source
# MAGIC %md
# MAGIC # 06 · Scan with the Jobs API
# MAGIC
# MAGIC **What it does.** Reads live state from the Jobs API for every enabled monitored job and adds the results to `findings`, with `source = JOBS_API`:
# MAGIC
# MAGIC | check_id | What it checks |
# MAGIC |---|---|
# MAGIC | `live_run_status` | the newest run's state: running or succeeded is HEALTHY |
# MAGIC | `live_task_failures` | failed tasks in the newest run, with the error text, even while the run continues |
# MAGIC | `live_long_runtime` | a run still going past `max_runtime_minutes` |
# MAGIC | `retry_loop` | a task retried more than `max_retries` times |
# MAGIC | `not_found` | no job matches the regex in the workspaces checked |
# MAGIC | `api_unreachable` | a workspace or job could not be read; the scan carries on with the rest |
# MAGIC
# MAGIC With `auth_mode = current_workspace`, it checks only this workspace, as you. With `service_principal`, it checks every workspace in the region that has jobs, signing in with the OAuth secret in `secret_scope`.
# MAGIC
# MAGIC **Inputs (widgets).** `catalog`, `schema`, `region`, `lookback_hours`, `scan_id`, `auth_mode`, `secret_scope`, `client_id_key`, `client_secret_key`, `code_version_tag` (the job tag that holds the deployed code version), `pipeline_url_parameter` (the job parameter that holds the CI pipeline link). Use the same `scan_id` as notebook 05 to make one scan across both sources; the bundle job does this for you. The input boxes appear at the top of the notebook after you run the first two code cells; when the notebook runs as a job, its parameters fill them in.
# MAGIC
# MAGIC **What to look for.** Rows for each matched job. `api_unreachable` rows say which permission or URL is missing.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
NAMES = ("catalog", "schema", "region", "lookback_hours", "scan_id", "auth_mode", "secret_scope", "client_id_key",
         "client_secret_key", "code_version_tag", "pipeline_url_parameter")
define_widgets(*NAMES)

# COMMAND ----------

s = settings(*NAMES)

# COMMAND ----------

from datetime import datetime, timezone

from databricks.sdk import WorkspaceClient
from pyspark.sql import functions as F

from jobs_watchdog.config_tables import read_config, read_workspaces
from jobs_watchdog.findings import finalize_rows, new_scan_id, write_findings
from jobs_watchdog.jobs_api import collect_target, make_client, merge_not_found, unreachable_rows
from jobs_watchdog.sqlfiles import run_sql
from jobs_watchdog.upgrade import require_current_tables
from jobs_watchdog.workspaces import build_targets, register_workspace_names

now = datetime.now(timezone.utc)
scan_id = s.scan_id or new_scan_id(now)
print(f"scan_id: {scan_id}")

require_current_tables(spark, s.catalog, s.schema)
jobs, dependencies = read_config(spark, s.catalog, s.schema)
labels = read_workspaces(spark, s.catalog, s.schema)
enabled = [job for job in jobs if job.enabled]
names, names_error = register_workspace_names(spark)
region_workspaces = [
    row.asDict()
    for row in run_sql(spark, "sql/explore/10_workspaces_in_region.sql", lookback_hours=s.lookback_hours).collect()
]
here = WorkspaceClient()
current_workspace_id = str(here.get_workspace_id())
targets, missing = build_targets(s.auth_mode, current_workspace_id, region_workspaces, names, labels)
if s.auth_mode == "service_principal" and names_error:
    print(f"Service principal mode needs workspace URLs from system.access.workspaces_latest: {names_error}")
print(f"Checking {len(enabled)} enabled jobs in {len(targets)} workspace(s)")

# COMMAND ----------

if s.auth_mode == "service_principal":
    client_id = dbutils.secrets.get(s.secret_scope, s.client_id_key)
    client_secret = dbutils.secrets.get(s.secret_scope, s.client_secret_key)

rows = []
for target in targets:
    if s.auth_mode == "current_workspace":
        client = here
    else:
        try:
            client = make_client("service_principal", target.host, client_id, client_secret)
        except Exception as err:
            rows.extend(unreachable_rows(target, enabled, short_error(err)))
            continue
    rows.extend(collect_target(client, target, enabled, now, code_version_tag=s.code_version_tag,
                               pipeline_url_parameter=s.pipeline_url_parameter))
for target in missing:
    rows.extend(unreachable_rows(target, enabled, "No URL for this workspace in system.access.workspaces_latest"))
rows = merge_not_found(rows, enabled)

account_ids = {row["workspace_id"]: row["account_id"] for row in region_workspaces}
account_id = account_ids.get(current_workspace_id) or next(iter(account_ids.values()), None)
written = write_findings(
    spark, finalize_rows(rows, scan_id, now, s.region, account_id, jobs, dependencies), s.catalog, s.schema
)
print(f"Offered {written} rows to findings (rows already there for this scan_id are skipped)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## This scan's Jobs API findings

# COMMAND ----------

findings = spark.table(f"{s.catalog}.{s.schema}.findings")
display(
    findings.where((F.col("scan_id") == scan_id) & (F.col("source") == "JOBS_API"))
    .orderBy("job_name", "workspace_id", "check_id")
)
