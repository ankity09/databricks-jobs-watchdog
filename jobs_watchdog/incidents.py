"""The incidents view, and the two lines a scan prints.

Every scan writes a row for every check into findings. That is the history,
so a problem that lasts shows up again in each scan. The view incidents
(sql/views/02_incidents.sql, created by notebook 01) lists each problem once:
a run of FAILED or WARNING rows for one check of one job, from the scan that
found it until a HEALTHY row clears it.

scan_summary builds the lines notebooks 05 and 06 print after they write:
how many rows the scan wrote, and how many problems are new, still open and
resolved, from sql/scan/31_scan_summary.sql.
"""

from jobs_watchdog.identifiers import validate_identifier
from jobs_watchdog.sqlfiles import run_sql

# The columns of the incidents view, in order (a test checks the view selects exactly these).
INCIDENT_COLUMNS = (
    "incident_id",
    "state",
    "source",
    "check_id",
    "workspace_id",
    "workspace_name",
    "job_id",
    "job_name",
    "environment",
    "owner",
    "schedule_type",
    "parent_job",
    "severity",
    "failure_category",
    "opened_at",
    "opened_scan_id",
    "last_seen_at",
    "last_seen_scan_id",
    "scans_seen",
    "worst_status",
    "current_status",
    "resolved_at",
    "resolved_scan_id",
    "error_summary",
    "run_page_url",
    "affected_jobs",
    "is_new",
)
INCIDENT_STATES = ("OPEN", "RESOLVED", "NOT_CHECKED")
SUMMARY_SQL = "sql/scan/31_scan_summary.sql"


def summary_text(scan_id, rows_written, new, still_open, resolved):
    """The two lines a scan prints: what it wrote, and how its problems moved."""
    rows = "row" if rows_written == 1 else "rows"
    return (
        f"Wrote {rows_written} {rows} for scan {scan_id}, one per check. Running the same scan again adds nothing.\n"
        f"Problems: {new} new, {still_open} still open, {resolved} resolved. "
        "The incidents view lists each problem once until it clears."
    )


def scan_summary(spark, catalog, schema, source, scan_id):
    """summary_text for one source's scan, read from findings and the incidents view.

    new: incidents that opened in this scan. still open: OPEN incidents that
    opened in an earlier scan. resolved: incidents a HEALTHY row in this scan
    cleared. A source that wrote nothing in this scan gets zeros.
    """
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    counts = {}
    for row in run_sql(spark, SUMMARY_SQL, catalog=catalog, schema=schema, scan_id=scan_id).collect():
        values = row.asDict()
        if values["source"] == source:
            counts = values
    return summary_text(
        scan_id,
        counts.get("rows_written") or 0,
        counts.get("new_problems") or 0,
        counts.get("still_open") or 0,
        counts.get("resolved") or 0,
    )
