# Databricks notebook source
# MAGIC %md
# MAGIC # Watchdog demo: a task that runs long
# MAGIC Part of the bundle's `demo` target. The task waits about three minutes, then succeeds. The example config allows one minute (`max_runtime_minutes: 1`), so the Watchdog should warn that `watchdog_demo_slow` ran too long.

# COMMAND ----------

import time

time.sleep(180)
print("This task waited about three minutes, then succeeded.")
