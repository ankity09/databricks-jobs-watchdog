# Databricks notebook source
# MAGIC %md
# MAGIC # Watchdog demo: a task that retries
# MAGIC Part of the bundle's `demo` target. The job allows two retries (`max_retries: 2`). This task fails on its first two attempts and succeeds on the third. The example config allows one retry (`max_retries: 1`), so the Watchdog should warn about a retry loop for `watchdog_demo_retries`.
# MAGIC
# MAGIC `attempt` comes from the dynamic value `{{task.execution_count}}`, the number of times this task has run, retries included.

# COMMAND ----------

dbutils.widgets.text("attempt", "1")
attempt = int(dbutils.widgets.get("attempt"))
print(f"Attempt {attempt}")
if attempt <= 2:
    raise RuntimeError(f"Watchdog demo: attempt {attempt} fails on purpose; attempt 3 succeeds")
print(f"Attempt {attempt} succeeds.")
