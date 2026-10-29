import re

import pytest
from tests.helpers import for_parsing

from jobs_watchdog.sqlfiles import ALLOWED_PARAMS, load_sql, parameters, repo_root, run_sql

EXPECTED_FILES = [
    "sql/setup/01_create_schema.sql",
    "sql/setup/02_create_monitored_jobs.sql",
    "sql/setup/03_create_job_dependencies.sql",
    "sql/setup/04_create_findings.sql",
    "sql/explore/10_workspaces_in_region.sql",
    "sql/explore/11_workspace_names.sql",
    "sql/explore/12_job_inventory.sql",
    "sql/explore/13_runs_in_window.sql",
    "sql/explore/14_failed_runs.sql",
    "sql/explore/15_task_failures.sql",
    "sql/explore/16_long_runs.sql",
    "sql/explore/17_last_run_per_job.sql",
    "sql/scan/20_resolve_monitored_jobs.sql",
    "sql/scan/21_system_table_findings.sql",
    "sql/scan/30_merge_findings.sql",
    "sql/validate/40_findings_by_source.sql",
    "sql/validate/41_duplicate_keys.sql",
    "sql/validate/42_enabled_jobs_without_findings.sql",
]

ALL_SQL = sorted(str(p.relative_to(repo_root())) for p in (repo_root() / "sql").rglob("*.sql"))
WATCHDOG_TABLES = ("monitored_jobs", "job_dependencies", "findings")


class FakeSpark:
    def __init__(self):
        self.calls = []

    def sql(self, text, args=None):
        self.calls.append((text, args))
        return "dataframe"


def test_expected_sql_files_exist():
    missing = [f for f in EXPECTED_FILES if not (repo_root() / f).is_file()]
    assert missing == []


@pytest.mark.parametrize("relpath", ALL_SQL)
def test_each_file_is_one_statement(relpath):
    assert load_sql(relpath).strip()


@pytest.mark.parametrize("relpath", ALL_SQL)
def test_only_allowed_parameters(relpath):
    assert parameters(load_sql(relpath)) <= ALLOWED_PARAMS


@pytest.mark.parametrize("relpath", ALL_SQL)
def test_watchdog_tables_only_through_identifier(relpath):
    text = load_sql(relpath)
    for table in WATCHDOG_TABLES:
        assert not re.search(rf"\b\w+\.\w+\.{table}\b", text), f"{table} named directly in {relpath}"
        if f"'.{table}'" in text:
            assert "IDENTIFIER(" in text


@pytest.mark.parametrize("relpath", ALL_SQL)
def test_sql_parses_as_databricks_sql(relpath):
    sqlglot = pytest.importorskip("sqlglot")
    sqlglot.parse_one(for_parsing(load_sql(relpath)), read="databricks")


def test_load_sql_rejects_two_statements(tmp_path, monkeypatch):
    monkeypatch.setattr("jobs_watchdog.sqlfiles.repo_root", lambda: tmp_path)
    (tmp_path / "two.sql").write_text("SELECT 1; SELECT 2;")
    with pytest.raises(ValueError, match="one statement"):
        load_sql("two.sql")


def test_load_sql_ignores_semicolons_in_comments_and_strings(tmp_path, monkeypatch):
    monkeypatch.setattr("jobs_watchdog.sqlfiles.repo_root", lambda: tmp_path)
    (tmp_path / "ok.sql").write_text("-- a comment; with a semicolon\nSELECT 'a;b' AS x;\n")
    assert load_sql("ok.sql").startswith("-- a comment")


def test_parameters_ignore_comments_strings_and_casts():
    text = "-- see :catalog\nSELECT ':nope', x::INT, :scan_id FROM t"
    assert parameters(text) == {"scan_id"}


def test_run_sql_rejects_bad_identifier():
    with pytest.raises(ValueError, match="catalog"):
        run_sql(FakeSpark(), "sql/setup/01_create_schema.sql", catalog="bad-name", schema="watchdog")


def test_run_sql_rejects_unknown_parameter():
    with pytest.raises(ValueError, match="unknown"):
        run_sql(FakeSpark(), "sql/setup/01_create_schema.sql", catalog="main", schema="watchdog", table="x")


def test_run_sql_requires_every_used_parameter():
    with pytest.raises(ValueError, match="schema"):
        run_sql(FakeSpark(), "sql/setup/01_create_schema.sql", catalog="main")


def test_run_sql_passes_only_used_parameters():
    spark = FakeSpark()
    run_sql(spark, "sql/setup/01_create_schema.sql", catalog="main", schema="watchdog", lookback_hours=48)
    text, args = spark.calls[0]
    assert args == {"catalog": "main", "schema": "watchdog"}
    assert "CREATE SCHEMA" in text


def _scan_ctes():
    sqlglot = pytest.importorskip("sqlglot")
    from sqlglot import exp

    tree = sqlglot.parse_one(for_parsing(load_sql("sql/scan/21_system_table_findings.sql")), read="databricks")
    return exp, {cte.alias: cte.this for cte in tree.find_all(exp.CTE)}


def test_task_failures_judge_each_tasks_newest_attempt_in_the_newest_run():
    exp, ctes = _scan_ctes()
    windows = list(ctes["task_attempts"].find_all(exp.Window))
    partitions = [{column.name for column in window.args.get("partition_by") or []} for window in windows]
    assert {"workspace_id", "job_id", "job_run_id", "task_key"} in partitions
    joined = {table.name for table in ctes["failed_tasks"].find_all(exp.Table)}
    assert {"task_attempts", "newest_run"} <= joined


def test_continuous_jobs_are_judged_by_their_newest_run():
    exp, ctes = _scan_ctes()
    comparisons = [
        node for node in ctes["last_runs"].find_all(exp.EQ)
        if node.this.name == "schedule_type" and node.expression.name == "continuous"
    ]
    assert comparisons
    assert "newest_run" in {table.name for table in ctes["last_runs"].find_all(exp.Table)}


def test_open_runs_are_measured_to_their_newest_system_table_record():
    exp, ctes = _scan_ctes()
    assert ctes["over_limit"].find(exp.CurrentTimestamp) is None
