"""Build findings rows and add them to the findings table, once per key.

The Jobs API collector returns partial rows. finalize_rows fills the columns
that come from the scan and the config: scan_id, observed_at, region,
account_id, severity, owner and affected_jobs. write_findings puts the rows in
the temp view watchdog_new_findings and runs sql/scan/30_merge_findings.sql,
which skips any key already in the table. The system table scan builds its
rows in SQL and merges through the same view and file.
"""

from collections import defaultdict
from datetime import timezone

from jobs_watchdog.identifiers import validate_identifier
from jobs_watchdog.sqlfiles import run_sql

# Same order and types as sql/setup/04_create_findings.sql (a test checks).
FINDINGS_SCHEMA = (
    ("observed_at", "TIMESTAMP"),
    ("scan_id", "STRING"),
    ("account_id", "STRING"),
    ("region", "STRING"),
    ("workspace_id", "STRING"),
    ("workspace_name", "STRING"),
    ("job_id", "STRING"),
    ("job_name", "STRING"),
    ("check_id", "STRING"),
    ("status", "STRING"),
    ("severity", "STRING"),
    ("failure_category", "STRING"),
    ("run_id", "STRING"),
    ("run_page_url", "STRING"),
    ("failed_task_keys", "ARRAY<STRING>"),
    ("error_summary", "STRING"),
    ("affected_jobs", "ARRAY<STRING>"),
    ("owner", "STRING"),
    ("source", "STRING"),
)
FINDINGS_COLUMNS = tuple(name for name, _ in FINDINGS_SCHEMA)
NEW_FINDINGS_VIEW = "watchdog_new_findings"
MERGE_SQL = "sql/scan/30_merge_findings.sql"
SUMMARY_CHARS = 1000
_JOB_DEPENDENCIES = {"job", "child_job"}


def new_scan_id(now):
    """A scan ID from a timezone-aware time, for example 20261028T120005Z."""
    if now.tzinfo is None:
        raise ValueError("now must include a timezone")
    return now.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def direct_dependents(dependencies):
    """For each job, the jobs (and child jobs) that depend on it directly."""
    dependents = defaultdict(set)
    for dependency in dependencies:
        if dependency.dependency_type in _JOB_DEPENDENCIES:
            dependents[dependency.depends_on].add(dependency.job_name)
    return dependents


def finalize_rows(rows, scan_id, observed_at, region, account_id, jobs, dependencies):
    """Complete partial rows so each holds every findings column, in order.

    severity is set on rows that are not HEALTHY, owner on every row, and
    affected_jobs (direct dependents) on FAILED rows only.
    """
    by_name = {job.job_name: job for job in jobs}
    dependents = direct_dependents(dependencies)
    complete = []
    for row in rows:
        job = by_name.get(row["job_name"])
        status = row["status"]
        summary = row.get("error_summary")
        filled = dict(
            row,
            scan_id=scan_id,
            observed_at=observed_at,
            region=region or None,
            account_id=account_id,
            severity=job.severity if job is not None and status != "HEALTHY" else None,
            owner=job.owner if job is not None else None,
            affected_jobs=sorted(dependents.get(row["job_name"], ())) if status == "FAILED" else None,
            error_summary=None if summary is None else str(summary)[:SUMMARY_CHARS],
        )
        complete.append({column: filled.get(column) for column in FINDINGS_COLUMNS})
    return complete


def schema_ddl():
    """The findings schema as a DDL string for spark.createDataFrame."""
    return ", ".join(f"{name} {data_type}" for name, data_type in FINDINGS_SCHEMA)


def write_findings(spark, rows, catalog, schema):
    """Add finalized rows to <catalog>.<schema>.findings; returns how many were offered."""
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    if not rows:
        return 0
    data = [tuple(row.get(column) for column in FINDINGS_COLUMNS) for row in rows]
    spark.createDataFrame(data, schema=schema_ddl()).createOrReplaceTempView(NEW_FINDINGS_VIEW)
    run_sql(spark, MERGE_SQL, catalog=catalog, schema=schema)
    return len(data)
