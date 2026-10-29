"""Write the monitored-jobs file into the two config tables, and read it back.

Notebook 02 loads the YAML file into the temp views watchdog_config_jobs and
watchdog_config_dependencies, then sql/config/01 and 02 replace the rows of
monitored_jobs and job_dependencies. The scans read the tables, so both scans
always use the config that was loaded last.
"""

from jobs_watchdog.config import Dependency, MonitoredJob
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
)
DEPENDENCY_COLUMNS = (
    ("job_name", "STRING"),
    ("depends_on", "STRING"),
    ("dependency_type", "STRING"),
    ("notes", "STRING"),
)
JOBS_VIEW = "watchdog_config_jobs"
DEPENDENCIES_VIEW = "watchdog_config_dependencies"


def _ddl(columns):
    return ", ".join(f"{name} {data_type}" for name, data_type in columns)


def write_config(spark, jobs, dependencies, catalog, schema):
    """Replace the rows of both config tables with these jobs and dependencies."""
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    for items, columns, view in ((jobs, JOB_COLUMNS, JOBS_VIEW), (dependencies, DEPENDENCY_COLUMNS, DEPENDENCIES_VIEW)):
        data = [tuple(getattr(item, name) for name, _ in columns) for item in items]
        spark.createDataFrame(data, schema=_ddl(columns)).createOrReplaceTempView(view)
    run_sql(spark, "sql/config/01_load_monitored_jobs.sql", catalog=catalog, schema=schema)
    run_sql(spark, "sql/config/02_load_job_dependencies.sql", catalog=catalog, schema=schema)


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
