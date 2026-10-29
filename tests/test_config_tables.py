import re

from jobs_watchdog.config import Dependency, MonitoredJob
from jobs_watchdog.config_tables import (
    DEPENDENCIES_VIEW,
    DEPENDENCY_COLUMNS,
    JOB_COLUMNS,
    JOBS_VIEW,
    read_config,
    write_config,
)
from jobs_watchdog.sqlfiles import load_sql

JOB = MonitoredJob("orders", "^orders$", "scheduled", 90, 60, 1, "CRITICAL", "data-team", True, "hourly")
DEP = Dependency("orders", "kafka", "service", "events")


def ddl_columns(relpath):
    ddl = load_sql(relpath)
    body = ddl[ddl.index("(") + 1:ddl.rindex(")")]
    return re.findall(r"^\s+(\w+)\s+([A-Z]+)", body, flags=re.MULTILINE)


def test_config_columns_match_the_table_ddl_without_loaded_at():
    assert ddl_columns("sql/setup/02_create_monitored_jobs.sql") == [*JOB_COLUMNS, ("loaded_at", "TIMESTAMP")]
    assert ddl_columns("sql/setup/03_create_job_dependencies.sql") == [*DEPENDENCY_COLUMNS, ("loaded_at", "TIMESTAMP")]


class FakeFrame:
    def __init__(self, spark, data, schema):
        self.spark, self.data, self.schema = spark, data, schema

    def createOrReplaceTempView(self, name):
        self.spark.views[name] = self

    def collect(self):
        return self.data


class FakeSpark:
    def __init__(self, tables=None):
        self.views, self.calls, self.tables = {}, [], tables or {}

    def createDataFrame(self, data, schema=None):
        return FakeFrame(self, data, schema)

    def sql(self, text, args=None):
        self.calls.append((text, args))

    def table(self, name):
        return FakeFrame(self, self.tables[name], None)


def test_write_config_loads_both_views_then_both_tables():
    spark = FakeSpark()
    write_config(spark, [JOB], [DEP], "main", "watchdog")
    assert spark.views[JOBS_VIEW].data == [("orders", "^orders$", "scheduled", 90, 60, 1, "CRITICAL", "data-team",
                                            True, "hourly")]
    assert spark.views[JOBS_VIEW].schema.startswith("job_name STRING, job_name_regex STRING")
    assert spark.views[DEPENDENCIES_VIEW].data == [("orders", "kafka", "service", "events")]
    assert [("INSERT OVERWRITE" in text, args) for text, args in spark.calls] == [
        (True, {"catalog": "main", "schema": "watchdog"}),
        (True, {"catalog": "main", "schema": "watchdog"}),
    ]
    assert "monitored_jobs" in spark.calls[0][0] and "job_dependencies" in spark.calls[1][0]


def test_read_config_rebuilds_jobs_and_dependencies():
    job_row = {name: getattr(JOB, name) for name, _ in JOB_COLUMNS} | {"loaded_at": None, "owner": None,
                                                                       "notes": None}
    dep_row = {"job_name": "orders", "depends_on": "kafka", "dependency_type": "service", "notes": None,
               "loaded_at": None}
    spark = FakeSpark({"main.watchdog.monitored_jobs": [job_row], "main.watchdog.job_dependencies": [dep_row]})
    jobs, deps = read_config(spark, "main", "watchdog")
    assert jobs == [MonitoredJob("orders", "^orders$", "scheduled", 90, 60, 1, "CRITICAL", "", True, "")]
    assert deps == [Dependency("orders", "kafka", "service", "")]
