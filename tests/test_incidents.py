"""The incidents view template and the two lines the scans print."""

import pytest

from jobs_watchdog.findings import FINDINGS_COLUMNS
from jobs_watchdog.incidents import INCIDENT_COLUMNS, INCIDENT_STATES, SUMMARY_SQL, scan_summary, summary_text
from jobs_watchdog.sqlfiles import load_sql, parameters
from jobs_watchdog.upgrade import VIEW_TEMPLATES, render_view, view_names, view_version
from tests.helpers import for_parsing

VIEW = "sql/views/02_incidents.sql"
KEY = {"source", "workspace_id", "job_id", "job_name", "check_id"}
# the columns the incidents view must have, in this order
EXPECTED_COLUMNS = (
    "incident_id", "state", "source", "check_id", "workspace_id", "workspace_name", "job_id", "job_name",
    "environment", "owner", "schedule_type", "parent_job", "severity", "failure_category",
    "opened_at", "opened_scan_id", "last_seen_at", "last_seen_scan_id", "scans_seen", "worst_status",
    "current_status", "resolved_at", "resolved_scan_id", "error_summary", "run_page_url", "affected_jobs", "is_new",
)


def _code(text):
    """The text without its -- comment lines, with whitespace collapsed."""
    return " ".join(" ".join(line.split("--", 1)[0] for line in text.splitlines()).split())


def _tree():
    sqlglot = pytest.importorskip("sqlglot")
    from sqlglot import exp

    return exp, sqlglot.parse_one(for_parsing(render_view(VIEW, "main", "watchdog")), read="databricks")


def test_notebook_01_creates_the_view_like_findings_latest():
    assert VIEW in VIEW_TEMPLATES
    assert view_names() == ("findings_latest", "incidents")
    assert view_version(VIEW) == "1"
    text = load_sql(VIEW)
    assert "CREATE OR REPLACE VIEW {schema}.incidents\nCOMMENT '" in text


def test_the_view_selects_exactly_the_incident_columns():
    exp, tree = _tree()
    assert INCIDENT_COLUMNS == EXPECTED_COLUMNS
    assert tuple(tree.expression.named_selects) == INCIDENT_COLUMNS


def test_the_view_reads_only_findings_and_copies_only_columns_findings_has():
    exp, tree = _tree()
    ctes = {cte.alias for cte in tree.find_all(exp.CTE)}
    tables = {table.name for table in tree.expression.find_all(exp.Table)} - ctes
    assert tables == {"findings"}
    copied = set(INCIDENT_COLUMNS) & set(FINDINGS_COLUMNS)
    assert copied == KEY | {"workspace_name", "environment", "owner", "schedule_type", "parent_job", "severity",
                            "failure_category", "error_summary", "run_page_url", "affected_jobs"}


def test_scans_are_ordered_by_when_they_first_wrote_as_in_findings_latest():
    code = _code(load_sql(VIEW))
    assert "min(observed_at) AS scan_time" in code and "GROUP BY source, scan_id" in code
    assert "PARTITION BY source ORDER BY scan_time, scan_id" in code


def test_rows_are_grouped_by_the_whole_key_so_null_ids_group_too():
    exp, tree = _tree()
    keyed = [w for w in tree.find_all(exp.Window)
             if {c.name for c in w.args.get("partition_by") or []} != {"source"}]
    assert keyed
    for window in keyed:
        assert {column.name for column in window.args["partition_by"]} == KEY
    incidents = next(cte.this for cte in tree.find_all(exp.CTE) if cte.alias == "incident_rows")
    grouped = {column.name for column in incidents.args["group"].expressions}
    assert grouped == KEY | {"healthy_before"}
    # the view never joins on the key, so no NULL-unsafe = can split a key with no job ID
    code = _code(load_sql(VIEW))
    assert "workspace_id =" not in code and "job_id =" not in code


def test_only_a_healthy_row_ends_an_incident():
    code = _code(load_sql(VIEW))
    assert "WHERE status IN ('FAILED', 'WARNING')" in code
    assert "sum(CASE WHEN status = 'HEALTHY' THEN 1 ELSE 0 END) OVER" in code
    assert "min(CASE WHEN status = 'HEALTHY' THEN" in code
    # UNKNOWN rows are neither problems nor HEALTHY, so they never open or end one
    assert "UNKNOWN" not in code


def test_states_and_the_retention_note():
    text = load_sql(VIEW)
    code = _code(text)
    assert set(INCIDENT_STATES) == {"OPEN", "RESOLVED", "NOT_CHECKED"}
    for state in INCIDENT_STATES:
        assert f"'{state}'" in code
    assert "count_if(status = 'FAILED') > 0 THEN 'FAILED' ELSE 'WARNING'" in code
    assert "sha2(" in code
    assert "open since at least" in text and "retention_days" in text


class Row(dict):
    def asDict(self):
        return dict(self)


class Frame:
    def __init__(self, rows):
        self.rows = rows

    def collect(self):
        return self.rows


class FakeSpark:
    def __init__(self, rows):
        self.rows, self.calls = rows, []

    def sql(self, text, args=None):
        self.calls.append((text, args))
        return Frame(self.rows)


def test_summary_text_says_what_the_scan_wrote_and_how_its_problems_moved():
    assert summary_text("20261109T040000Z", 12, 2, 3, 1) == (
        "Wrote 12 rows for scan 20261109T040000Z, one per check. Running the same scan again adds nothing.\n"
        "Problems: 2 new, 3 still open, 1 resolved. The incidents view lists each problem once until it clears."
    )


def test_summary_text_counts_one_row_without_a_plural():
    assert summary_text("20261109T040000Z", 1, 0, 0, 0).startswith("Wrote 1 row for scan 20261109T040000Z, one")


def test_scan_summary_reports_its_own_source():
    spark = FakeSpark([
        Row(source="SYSTEM_TABLES", rows_written=5, new_problems=1, still_open=0, resolved=0),
        Row(source="JOBS_API", rows_written=12, new_problems=2, still_open=3, resolved=1),
    ])
    assert scan_summary(spark, "main", "watchdog", "JOBS_API", "20261109T040000Z") == (
        summary_text("20261109T040000Z", 12, 2, 3, 1))
    text, args = spark.calls[0]
    assert text == load_sql(SUMMARY_SQL)
    assert args == {"catalog": "main", "schema": "watchdog", "scan_id": "20261109T040000Z"}


def test_scan_summary_says_zero_when_the_source_wrote_nothing():
    spark = FakeSpark([Row(source="JOBS_API", rows_written=12, new_problems=2, still_open=3, resolved=1)])
    assert scan_summary(spark, "main", "watchdog", "SYSTEM_TABLES", "s1") == summary_text("s1", 0, 0, 0, 0)


def test_scan_summary_checks_the_names_before_any_sql():
    spark = FakeSpark([])
    with pytest.raises(ValueError, match="schema"):
        scan_summary(spark, "main", "bad-schema", "JOBS_API", "s1")
    assert spark.calls == []


def test_summary_query_counts_rows_from_findings_and_problems_from_the_view():
    text = load_sql(SUMMARY_SQL)
    assert parameters(text) == {"catalog", "schema", "scan_id"}
    assert "IDENTIFIER(:catalog || '.' || :schema || '.findings')" in text
    assert "IDENTIFIER(:catalog || '.' || :schema || '.incidents')" in text
    code = _code(text)
    assert "count_if(opened_scan_id = :scan_id) AS new_problems" in code
    assert "count_if(state = 'OPEN' AND opened_scan_id <> :scan_id) AS still_open" in code
    assert "count_if(resolved_scan_id = :scan_id) AS resolved" in code
