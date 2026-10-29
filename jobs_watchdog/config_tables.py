"""Write the monitored-jobs file into the config tables, and read it back.

Notebook 02 loads the YAML file into the temp views watchdog_config_jobs,
watchdog_config_dependencies and watchdog_config_workspaces, then
sql/config/01 to 03 replace the rows of monitored_jobs, job_dependencies and
monitored_workspaces. The scans read the tables, so both scans always use the
config that was loaded last.
"""

from jobs_watchdog.config import Dependency, MonitoredJob, MonitoredWorkspace
from jobs_watchdog.identifiers import validate_identifier
from jobs_watchdog.sqlfiles import run_sql

JOB_COLUMNS = (
    ("job_name", "STRING"),
    ("job_name_regex", "STRING"),
    ("schedule_type", "STRING"),
    ("max_gap_minutes", "INT"),
    ("max_runtime_minutes", "INT"),
    ("max_retries", "INT"),
    ("severity", "STRING"),
    ("owner", "STRING"),
    ("enabled", "BOOLEAN"),
    ("notes", "STRING"),
    ("job_name_exclude_regex", "STRING"),
)
DEPENDENCY_COLUMNS = (
    ("job_name", "STRING"),
    ("depends_on", "STRING"),
    ("dependency_type", "STRING"),
    ("notes", "STRING"),
)
WORKSPACE_COLUMNS = (
    ("workspace_id", "STRING"),
    ("workspace_name", "STRING"),
    ("environment", "STRING"),
    ("notes", "STRING"),
)
JOBS_VIEW = "watchdog_config_jobs"
DEPENDENCIES_VIEW = "watchdog_config_dependencies"
WORKSPACES_VIEW = "watchdog_config_workspaces"
_LOADS = (
    "sql/config/01_load_monitored_jobs.sql",
    "sql/config/02_load_job_dependencies.sql",
    "sql/config/03_load_monitored_workspaces.sql",
)


def _ddl(columns):
    return ", ".join(f"{name} {data_type}" for name, data_type in columns)


def write_config(spark, jobs, dependencies, catalog, schema, workspaces=()):
    """Replace the rows of the three config tables with these jobs, dependencies and workspaces."""
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    sets = ((jobs, JOB_COLUMNS, JOBS_VIEW), (dependencies, DEPENDENCY_COLUMNS, DEPENDENCIES_VIEW),
            (workspaces, WORKSPACE_COLUMNS, WORKSPACES_VIEW))
    for items, columns, view in sets:
        data = [tuple(getattr(item, name) for name, _ in columns) for item in items]
        spark.createDataFrame(data, schema=_ddl(columns)).createOrReplaceTempView(view)
    for relpath in _LOADS:
        run_sql(spark, relpath, catalog=catalog, schema=schema)


def read_config(spark, catalog, schema):
    """(jobs, dependencies) as loaded into the config tables."""
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    jobs = []
    for row in spark.table(f"{catalog}.{schema}.monitored_jobs").collect():
        values = {name: row[name] for name, _ in JOB_COLUMNS}
        values["owner"] = values["owner"] or ""
        values["notes"] = values["notes"] or ""
        jobs.append(MonitoredJob(**values))
    dependencies = []
    for row in spark.table(f"{catalog}.{schema}.job_dependencies").collect():
        values = {name: row[name] for name, _ in DEPENDENCY_COLUMNS}
        values["notes"] = values["notes"] or ""
        dependencies.append(Dependency(**values))
    return jobs, dependencies


def read_workspaces(spark, catalog, schema):
    """The environment labels loaded into monitored_workspaces."""
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    workspaces = []
    for row in spark.table(f"{catalog}.{schema}.monitored_workspaces").collect():
        values = {name: row[name] for name, _ in WORKSPACE_COLUMNS}
        values["notes"] = values["notes"] or ""
        workspaces.append(MonitoredWorkspace(**values))
    return workspaces
