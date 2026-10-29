# Databricks notebook source
# MAGIC %md
# MAGIC # 04 · Explore the Jobs API
# MAGIC
# MAGIC **What it does.** Walks one job through the three Jobs API calls the Watchdog makes, and shows the fields it reads from each. Nothing is written. `docs/jobs-api.md` explains every field.
# MAGIC
# MAGIC 1. `list_runs(job_id, limit=2)`: the two newest runs, newest first.
# MAGIC 2. `get_run(run_id)`: the newest run with every task, following `next_page_token` when a run has more than 100 tasks.
# MAGIC 3. `get_run_output(task_run_id)`: the error text of each failed task.
# MAGIC
# MAGIC Unlike system tables, the Jobs API is live: a run that started a minute ago is already here.
# MAGIC
# MAGIC **Inputs (widgets).** `catalog`, `schema` (to read your monitored jobs), and `job_id`. With `job_id` empty, the notebook uses the first enabled monitored job it finds in this workspace. The input boxes appear at the top of the notebook after you run the first two code cells; when the notebook runs as a job, its parameters fill them in.
# MAGIC
# MAGIC **What to look for.** The newest run's states, its tasks, and for a failed task, the error text the Watchdog writes to `error_summary`.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
define_widgets("catalog", "schema")
dbutils.widgets.text("job_id", "", "job_id")

# COMMAND ----------

s = settings("catalog", "schema")

# COMMAND ----------

from databricks.sdk import WorkspaceClient

from jobs_watchdog.config_tables import read_config
from jobs_watchdog.jobs_api import explain_job, resolve_jobs

client = WorkspaceClient()
job_id = dbutils.widgets.get("job_id").strip()
if not job_id:
    jobs, _ = read_config(spark, s.catalog, s.schema)
    found = [hit for hit in resolve_jobs(client, [job for job in jobs if job.enabled]) if hit[1] is not None]
    if not found:
        dbutils.notebook.exit("No enabled monitored job matches a job in this workspace. Set the job_id widget.")
    job, job_id, real_name, _tags = found[0]
    print(f"Using monitored job {job.job_name}: job {job_id}, named {real_name!r}")
explained = explain_job(client, int(job_id))

# COMMAND ----------

import pandas as pd


def show(rows, empty):
    if rows:
        display(pd.DataFrame(rows))
    else:
        print(empty)

# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. `list_runs`: the newest runs
# MAGIC `life_cycle_state` says where a run is (QUEUED, PENDING, RUNNING, TERMINATING, TERMINATED, SKIPPED, INTERNAL_ERROR). `result_state` is set when it ends (SUCCESS, FAILED, TIMEDOUT, CANCELED, and others). The Watchdog's `live_run_status` check reads these from the newest run.

# COMMAND ----------

show(explained["runs"], "This job has no runs.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. `get_run`: every task of the newest run
# MAGIC A retried task appears once per attempt; `attempt_number` starts at 0. The `live_task_failures` check reads each task's newest attempt, and `retry_loop` compares `attempt_number` with `max_retries`. `termination_type` sorts failures into functional (`CLIENT_ERROR`) and infrastructure (`INTERNAL_ERROR`, `CLOUD_FAILURE`).

# COMMAND ----------

show(explained["tasks"], "The newest run has no tasks yet.")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. `get_run_output`: error text of failed tasks
# MAGIC The first part of this text becomes `error_summary`. Reading output needs CAN VIEW on the job; without it the Watchdog keeps the task's state message instead.

# COMMAND ----------

show(explained["errors"], "No failed tasks in the newest run.")
