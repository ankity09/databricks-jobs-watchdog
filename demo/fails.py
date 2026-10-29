# Databricks notebook source
# MAGIC %md
# MAGIC # Watchdog demo: a task that fails
# MAGIC Part of the bundle's `demo` target. The Watchdog should report the `load` task of `watchdog_demo_fails` as FAILED, with this error text in `error_summary`.

# COMMAND ----------

raise ValueError("Watchdog demo: the load task fails on purpose")
