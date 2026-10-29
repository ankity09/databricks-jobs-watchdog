from jobs_watchdog.config import Dependency, MonitoredJob, MonitoredWorkspace
from jobs_watchdog.config_tables import (
    DEPENDENCIES_VIEW,
    DEPENDENCY_COLUMNS,
    JOB_COLUMNS,
    JOBS_VIEW,
    ENVIRONMENT_COLUMNS,
    ENVIRONMENTS_VIEW,
    WORKSPACE_COLUMNS,
    WORKSPACES_VIEW,
    read_config,
    read_workspaces,
    write_config,
)
from jobs_watchdog.sqlfiles import load_sql
from jobs_watchdog.upgrade import ddl_columns

JOB = MonitoredJob("orders", "^orders$", "scheduled", 90, 60, 1, "CRITICAL", "data-team", True, "hourly", "test", 10,
                  {"lower": {"severity": "WARNING", "enabled": False}})
DEP = Dependency("orders", "kafka", "service", "events")
WS = MonitoredWorkspace("1234", None, "production", "main one")


def without_loaded_at(relpath):
    return [(c.name, c.data_type) for c in ddl_columns(relpath) if c.name != "loaded_at"]


def test_config_columns_match_the_table_ddl_without_loaded_at():
    assert without_loaded_at("sql/setup/02_create_monitored_jobs.sql") == list(JOB_COLUMNS)
    assert without_loaded_at("sql/setup/03_create_job_dependencies.sql") == list(DEPENDENCY_COLUMNS)
    assert without_loaded_at("sql/setup/05_create_monitored_workspaces.sql") == list(WORKSPACE_COLUMNS)
    assert without_loaded_at("sql/setup/06_create_monitored_job_environments.sql") == list(ENVIRONMENT_COLUMNS)


def test_load_files_select_columns_in_table_order():
    for load, setup in (("sql/config/01_load_monitored_jobs.sql", "sql/setup/02_create_monitored_jobs.sql"),
                        ("sql/config/03_load_monitored_workspaces.sql", "sql/setup/05_create_monitored_workspaces.sql"),
                        ("sql/config/04_load_monitored_job_environments.sql",
                         "sql/setup/06_create_monitored_job_environments.sql")):
        sqlglot = __import__("pytest").importorskip("sqlglot")
        from tests.helpers import for_parsing

        selected = sqlglot.parse_one(for_parsing(load_sql(load)), read="databricks").expression.named_selects
        assert selected == [c.name for c in ddl_columns(setup)], load


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


def test_write_config_loads_the_views_then_the_tables():
    spark = FakeSpark()
    write_config(spark, [JOB], [DEP], "main", "watchdog", [WS])
    assert spark.views[JOBS_VIEW].data == [("orders", "^orders$", "scheduled", 90, 60, 1, "CRITICAL", "data-team",
                                            True, "hourly", "test", 10)]
    assert spark.views[ENVIRONMENTS_VIEW].data == [("orders", "lower", "WARNING", None, False, None, None, None, None)]
    assert spark.views[JOBS_VIEW].schema.startswith("job_name STRING, job_name_regex STRING")
    assert spark.views[DEPENDENCIES_VIEW].data == [("orders", "kafka", "service", "events")]
    assert spark.views[WORKSPACES_VIEW].data == [("1234", None, "production", "main one")]
    assert [("INSERT OVERWRITE" in text, args) for text, args in spark.calls] == [
        (True, {"catalog": "main", "schema": "watchdog"})] * 4
    tables = ("monitored_jobs", "job_dependencies", "monitored_workspaces", "monitored_job_environments")
    assert [table in text for table, (text, _) in zip(tables, spark.calls)] == [True] * 4


def test_write_config_without_workspaces_empties_that_table():
    spark = FakeSpark()
    write_config(spark, [JOB], [DEP], "main", "watchdog")
    assert spark.views[WORKSPACES_VIEW].data == []
    assert len(spark.calls) == 4


def test_read_config_rebuilds_jobs_and_dependencies():
    job_row = {name: getattr(JOB, name) for name, _ in JOB_COLUMNS} | {"loaded_at": None, "owner": None,
                                                                       "notes": None}
    dep_row = {"job_name": "orders", "depends_on": "kafka", "dependency_type": "service", "notes": None,
               "loaded_at": None}
    env_row = {"job_name": "orders", "environment": "lower", "severity": "WARNING", "owner": None, "enabled": False,
               "max_gap_minutes": None, "max_runtime_minutes": None, "max_retries": None, "min_attempt_minutes": None,
               "loaded_at": None}
    spark = FakeSpark({"main.watchdog.monitored_jobs": [job_row], "main.watchdog.job_dependencies": [dep_row],
                       "main.watchdog.monitored_job_environments": [env_row]})
    jobs, deps = read_config(spark, "main", "watchdog")
    assert jobs == [MonitoredJob("orders", "^orders$", "scheduled", 90, 60, 1, "CRITICAL", "", True, "", "test", 10,
                                 {"lower": {"severity": "WARNING", "enabled": False}})]
    assert deps == [Dependency("orders", "kafka", "service", "")]


def test_read_workspaces():
    row = {"workspace_id": "1234", "workspace_name": None, "environment": "production", "notes": None,
           "loaded_at": None}
    spark = FakeSpark({"main.watchdog.monitored_workspaces": [row]})
    assert read_workspaces(spark, "main", "watchdog") == [MonitoredWorkspace("1234", None, "production", "")]
