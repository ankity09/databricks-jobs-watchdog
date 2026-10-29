import re
from datetime import datetime, timezone

import pytest

from jobs_watchdog.config import Dependency, MonitoredJob
from jobs_watchdog.findings import (
    FINDINGS_COLUMNS,
    FINDINGS_SCHEMA,
    NEW_FINDINGS_VIEW,
    finalize_rows,
    new_scan_id,
    write_findings,
)
from jobs_watchdog.jobs_api import Target, collect_target
from jobs_watchdog.sqlfiles import load_sql
from tests.helpers import for_parsing

NOW = datetime(2026, 10, 28, 12, 0, 5, tzinfo=timezone.utc)


def job(name, severity="CRITICAL", owner="data-team"):
    return MonitoredJob(name, f"^{name}$", "scheduled", 90, 60, 1, severity, owner, True, "")


JOBS = [job("orders_ingest"), job("orders_enrich", severity="WARNING", owner="enrich-team"), job("revenue")]
DEPENDENCIES = [
    Dependency("orders_enrich", "orders_ingest", "job", ""),
    Dependency("revenue", "orders_ingest", "child_job", ""),
    Dependency("orders_ingest", "kafka", "service", ""),
]


def api_row(job_name, status, check_id="live_run_status", summary="text"):
    return {"workspace_id": "1001", "workspace_name": None, "job_id": "7", "job_name": job_name,
            "check_id": check_id, "status": status, "failure_category": "NONE", "run_id": "70",
            "run_page_url": None, "failed_task_keys": None, "error_summary": summary, "source": "JOBS_API"}


def finalize(rows):
    return finalize_rows(rows, "20261028T120005Z", NOW, "us-east-1", "acct", JOBS, DEPENDENCIES)


def test_ddl_columns_and_types_match_the_schema():
    ddl = load_sql("sql/setup/04_create_findings.sql")
    body = ddl[ddl.index("(") + 1:ddl.rindex(")")]
    columns = re.findall(r"^\s+(\w+)\s+([A-Z]+(?:<[A-Z]+>)?)", body, flags=re.MULTILINE)
    assert tuple(columns) == FINDINGS_SCHEMA
    assert FINDINGS_COLUMNS == tuple(name for name, _ in FINDINGS_SCHEMA)


def test_system_scan_returns_findings_columns_in_order():
    sqlglot = pytest.importorskip("sqlglot")
    tree = sqlglot.parse_one(for_parsing(load_sql("sql/scan/21_system_table_findings.sql")), read="databricks")
    assert tuple(tree.named_selects) == FINDINGS_COLUMNS


def test_collector_rows_only_use_findings_columns():
    class Down:
        def get_workspace_id(self):
            raise RuntimeError("down")

    rows = collect_target(Down(), Target("1001", None, None), JOBS[:1], NOW)
    assert set(rows[0]) <= set(FINDINGS_COLUMNS)


def test_new_scan_id_is_utc_compact():
    assert new_scan_id(NOW) == "20261028T120005Z"


def test_new_scan_id_converts_other_timezones_to_utc():
    from zoneinfo import ZoneInfo

    pacific = datetime(2026, 10, 28, 5, 0, 5, tzinfo=ZoneInfo("America/Los_Angeles"))
    assert new_scan_id(pacific) == "20261028T120005Z"


def test_new_scan_id_needs_a_timezone():
    with pytest.raises(ValueError, match="timezone"):
        new_scan_id(datetime(2026, 10, 28, 12, 0))


def test_failed_rows_list_direct_job_dependents_only():
    row = finalize([api_row("orders_ingest", "FAILED")])[0]
    assert row["affected_jobs"] == ["orders_enrich", "revenue"]
    assert row["severity"] == "CRITICAL"
    assert row["owner"] == "data-team"


def test_failed_row_without_dependents_gets_an_empty_list():
    assert finalize([api_row("revenue", "FAILED")])[0]["affected_jobs"] == []


def test_healthy_rows_have_no_severity_or_affected_jobs():
    row = finalize([api_row("orders_ingest", "HEALTHY")])[0]
    assert row["severity"] is None
    assert row["affected_jobs"] is None
    assert row["owner"] == "data-team"


def test_warning_rows_take_the_job_severity_but_no_affected_jobs():
    row = finalize([api_row("orders_enrich", "WARNING", check_id="live_long_runtime")])[0]
    assert row["severity"] == "WARNING"
    assert row["affected_jobs"] is None
    assert row["owner"] == "enrich-team"


def test_scan_columns_are_filled_and_every_column_present():
    row = finalize([api_row("orders_ingest", "HEALTHY")])[0]
    assert tuple(row) == FINDINGS_COLUMNS
    assert (row["scan_id"], row["observed_at"], row["region"], row["account_id"]) == (
        "20261028T120005Z", NOW, "us-east-1", "acct")


def test_error_summary_is_cut_to_1000_characters():
    row = finalize([api_row("orders_ingest", "FAILED", summary="x" * 5000)])[0]
    assert len(row["error_summary"]) == 1000


class FakeFrame:
    def __init__(self, spark, data, schema):
        self.spark, self.data, self.schema = spark, data, schema

    def createOrReplaceTempView(self, name):
        self.spark.views[name] = self


class FakeSpark:
    def __init__(self):
        self.frames, self.views, self.calls = [], {}, []

    def createDataFrame(self, data, schema=None):
        frame = FakeFrame(self, data, schema)
        self.frames.append(frame)
        return frame

    def sql(self, text, args=None):
        self.calls.append((text, args))
        return "merge result"


def test_write_findings_registers_the_view_and_merges():
    spark = FakeSpark()
    rows = finalize([api_row("orders_ingest", "FAILED")])
    assert write_findings(spark, rows, "main", "watchdog") == 1
    frame = spark.frames[0]
    assert frame.data == [tuple(rows[0][column] for column in FINDINGS_COLUMNS)]
    assert frame.schema.startswith("observed_at TIMESTAMP, scan_id STRING, account_id STRING")
    assert "failed_task_keys ARRAY<STRING>" in frame.schema
    assert spark.views[NEW_FINDINGS_VIEW] is frame
    text, args = spark.calls[0]
    assert text.lstrip().startswith("--") and "MERGE INTO" in text
    assert args == {"catalog": "main", "schema": "watchdog"}


def test_write_findings_checks_identifiers_before_writing():
    spark = FakeSpark()
    with pytest.raises(ValueError, match="schema"):
        write_findings(spark, finalize([api_row("orders_ingest", "HEALTHY")]), "main", "watch-dog")
    assert spark.frames == [] and spark.calls == []


def test_write_findings_with_no_rows_does_nothing():
    spark = FakeSpark()
    assert write_findings(spark, [], "main", "watchdog") == 0
    assert spark.frames == [] and spark.calls == []
