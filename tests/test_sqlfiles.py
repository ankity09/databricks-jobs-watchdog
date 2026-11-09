import re

import pytest
from tests.helpers import for_parsing

from jobs_watchdog.sqlfiles import ALLOWED_PARAMS, load_sql, parameters, repo_root, run_sql

EXPECTED_FILES = [
    "sql/setup/01_create_schema.sql",
    "sql/setup/02_create_monitored_jobs.sql",
    "sql/setup/03_create_job_dependencies.sql",
    "sql/setup/04_create_findings.sql",
    "sql/setup/05_create_monitored_workspaces.sql",
    "sql/setup/06_create_monitored_job_environments.sql",
    "sql/config/01_load_monitored_jobs.sql",
    "sql/config/02_load_job_dependencies.sql",
    "sql/config/03_load_monitored_workspaces.sql",
    "sql/config/04_load_monitored_job_environments.sql",
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
    "sql/scan/31_scan_summary.sql",
    "sql/validate/40_findings_by_source.sql",
    "sql/validate/41_duplicate_keys.sql",
    "sql/validate/42_enabled_jobs_without_findings.sql",
    "sql/validate/43_open_incidents_match_latest.sql",
    "sql/maintenance/50_delete_old_findings.sql",
]

# sql/views holds CREATE VIEW templates (views cannot take parameter markers); tests/test_upgrade.py covers them.
ALL_SQL = sorted(
    str(p.relative_to(repo_root()))
    for p in (repo_root() / "sql").rglob("*.sql")
    if not p.relative_to(repo_root()).as_posix().startswith("sql/views/")
)
WATCHDOG_TABLES = ("monitored_jobs", "job_dependencies", "findings", "monitored_workspaces", "monitored_job_environments")


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


def test_scan_skips_names_matching_the_exclude_regex():
    exp, ctes = _scan_ctes()
    calls = [call for call in ctes["candidates"].find_all(exp.RegexpLike)]
    assert {call.expression.name for call in calls} >= {"job_name_regex", "job_name_exclude_regex"}
    assert any(isinstance(call.parent, exp.Not) for call in calls)


def test_scan_labels_workspaces_from_monitored_workspaces():
    exp, ctes = _scan_ctes()
    tables = {table.name for table in ctes["environments"].find_all(exp.Table)}
    assert "monitored_workspaces" in tables and "watchdog_workspace_names" in tables


def test_scan_trigger_mapping_matches_python():
    from jobs_watchdog.states import _TRIGGERS

    text = load_sql("sql/scan/21_system_table_findings.sql")
    for raw, normalized in _TRIGGERS.items():
        assert f"WHEN '{raw}' THEN '{normalized}'" in text, raw


def test_scan_reads_code_version_from_the_configured_tag():
    text = load_sql("sql/scan/21_system_table_findings.sql")
    assert "try_element_at(c.job_tags, :code_version_tag)" in text
    assert "code_version_tag" in parameters(text)


def test_resolve_query_skips_excluded_names_like_the_scans():
    sqlglot = pytest.importorskip("sqlglot")
    from sqlglot import exp

    tree = sqlglot.parse_one(for_parsing(load_sql("sql/scan/20_resolve_monitored_jobs.sql")), read="databricks")
    calls = list(tree.find_all(exp.RegexpLike))
    assert {call.expression.name for call in calls} >= {"job_name_regex", "job_name_exclude_regex"}
    assert any(isinstance(call.parent, exp.Not) for call in calls)


def test_runs_that_began_before_the_window_get_no_start_or_duration():
    exp, ctes = _scan_ctes()
    assert "started_before_window" in ctes["runs"].named_selects
    referenced = {column.name for column in ctes["checks"].find_all(exp.Column)}
    assert {"started_before_window", "newest_before_window"} <= referenced


def test_latest_view_ranks_scans_by_when_they_first_wrote():
    from jobs_watchdog.upgrade import render_view

    text = render_view("sql/views/01_findings_latest.sql", "main", "watchdog")
    assert "min(observed_at) AS first_seen" in text and "max_by(scan_id, first_seen)" in text


def test_scan_reads_pipeline_url_from_the_runs_job_parameters():
    exp, ctes = _scan_ctes()
    assert "job_parameters" in ctes["runs"].named_selects
    text = load_sql("sql/scan/21_system_table_findings.sql")
    assert "try_element_at(try_element_at(c.job_parameters, :pipeline_url_parameter), 'value')" in text
    assert "pipeline_url_parameter" in parameters(text)


def test_scan_applies_environment_overrides_and_reports_jobs_switched_off_everywhere():
    exp, ctes = _scan_ctes()
    assert "monitored_job_environments" in {t.name for t in ctes["overrides"].find_all(exp.Table)}
    assert {"all_matched", "overrides"} <= {t.name for t in ctes["matched"].find_all(exp.Table)}
    text = load_sql("sql/scan/21_system_table_findings.sql")
    assert "coalesce(o.enabled, r.enabled)" in text
    assert "switched off" in text


def test_resolve_query_shows_each_matches_environment_and_whether_it_is_checked():
    sqlglot = pytest.importorskip("sqlglot")
    tree = sqlglot.parse_one(for_parsing(load_sql("sql/scan/20_resolve_monitored_jobs.sql")), read="databricks")
    assert {"environment", "checked_here"} <= set(tree.named_selects)


def test_validation_counts_jobs_switched_on_in_any_environment():
    text = load_sql("sql/validate/42_enabled_jobs_without_findings.sql")
    assert "monitored_job_environments" in text and "o.enabled" in text


def test_scan_takes_affected_jobs_and_parent_job_from_the_impact_view():
    exp, ctes = _scan_ctes()
    assert "dependents" not in ctes
    text = load_sql("sql/scan/21_system_table_findings.sql")
    assert "LEFT JOIN watchdog_affected_jobs d ON d.job_name = c.job_name" in text
    assert "job_dependencies" not in text.split("WITH", 1)[1]
    assert "d.parent_job" in text


def test_schedule_gap_checks_scheduled_jobs_by_start_and_continuous_jobs_by_run_in_progress():
    text = load_sql("sql/scan/21_system_table_findings.sql")
    code = " ".join(text.split())
    assert "WHERE mt.schedule_type = 'scheduled' AND mt.max_gap_minutes IS NOT NULL" in text
    # continuous jobs: a run in progress is healthy; a newest run that ended more than the limit
    # (30 by default) plus 60 minutes of system table lag ago means the stream is stopped
    assert "WHERE mt.schedule_type = 'continuous'" in text
    assert "WHEN s.run_id IS NOT NULL AND s.result_state IS NULL THEN 'HEALTHY'" in code
    assert ("timestampdiff(MINUTE, s.last_seen, current_timestamp()) <= coalesce(mt.max_gap_minutes, 30) + 60"
            in code)
    assert "No run in progress for %d minutes: the newest run ended %s at %s UTC" in text
    assert text.count("CASE WHEN mt.paused THEN ' The job is paused.' ELSE '' END") == 2
    # triggered jobs still get no schedule check
    assert "mt.schedule_type = 'triggered'" not in text


def test_cleanup_deletes_whole_old_scans_but_never_a_sources_newest_scan():
    text = load_sql("sql/maintenance/50_delete_old_findings.sql")
    code = " ".join(text.split())
    assert parameters(text) == {"catalog", "schema", "retention_days"}
    # scans ranked newest first within each source, by when they first wrote; rank 1 is never deleted
    assert "PARTITION BY source ORDER BY first_seen DESC" in code
    assert "min(observed_at) AS first_seen" in code
    assert "newest_first > 1" in code
    # 0 keeps everything, and the age limit is in days
    assert "CAST(:retention_days AS INT) > 0" in code
    assert "timestampadd(DAY, -CAST(:retention_days AS INT), current_timestamp())" in code
    # whole scans go: rows are matched on source and scan_id only
    assert "ON t.source = old.source AND t.scan_id = old.scan_id WHEN MATCHED THEN DELETE" in code


def test_scan_matches_by_job_id_where_job_ids_apply_and_by_name_elsewhere():
    exp, ctes = _scan_ctes()
    assert {"monitored", "overrides"} <= {t.name for t in ctes["candidates"].find_all(exp.Table)}
    text = load_sql("sql/scan/21_system_table_findings.sql")
    assert "explode(job_ids)" in text
    assert "array_contains(coalesce(o.job_ids, m.job_ids), c.job_id)" in text
    assert "(c.matched_by = 'job_id') = (coalesce(size(coalesce(o.job_ids, m.job_ids)), 0) > 0)" in text
    assert "matched_by" in ctes["all_matched"].named_selects


def test_scan_reports_listed_job_ids_it_cannot_find():
    exp, ctes = _scan_ctes()
    assert "environments" in {t.name for t in ctes["expected_ids"].find_all(exp.Table)}
    assert {"expected", "missing"} <= set(ctes["id_check"].named_selects)
    text = load_sql("sql/scan/21_system_table_findings.sql")
    assert "listed job IDs were not found in this region" in text
    assert "OR coalesce(size(i.missing), 0) > 0" in text


def test_scan_warns_about_jobs_sharing_one_name_when_matched_by_name():
    exp, ctes = _scan_ctes()
    assert "matched_by = 'name'" in ctes["same_name"].sql(dialect="databricks")
    assert ctes["same_name"].args.get("having") is not None
    text = load_sql("sql/scan/21_system_table_findings.sql")
    assert "'duplicate_name'," in text and "WHEN c.check_id = 'duplicate_name' THEN 'COVERAGE'" in text


def test_resolve_query_shows_how_each_job_matched():
    sqlglot = pytest.importorskip("sqlglot")
    tree = sqlglot.parse_one(for_parsing(load_sql("sql/scan/20_resolve_monitored_jobs.sql")), read="databricks")
    assert {"job_ids", "matched_by", "same_name_jobs"} <= set(tree.named_selects)
    text = load_sql("sql/scan/20_resolve_monitored_jobs.sql")
    assert "array_contains(coalesce(o.job_ids, m.job_ids), c.job_id)" in text


def test_config_loads_carry_job_ids():
    assert "job_ids" in load_sql("sql/config/01_load_monitored_jobs.sql")
    assert "job_ids" in load_sql("sql/config/04_load_monitored_job_environments.sql")


def test_incident_validation_compares_findings_latest_with_open_incidents():
    text = load_sql("sql/validate/43_open_incidents_match_latest.sql")
    code = " ".join(text.split())
    assert parameters(text) == {"catalog", "schema"}
    assert "IDENTIFIER(:catalog || '.' || :schema || '.findings_latest')" in text
    assert "IDENTIFIER(:catalog || '.' || :schema || '.incidents')" in text
    assert "WHERE state = 'OPEN'" in code
    # keys can have no workspace or job ID, so every key comparison is NULL-safe
    for column in ("source", "workspace_id", "job_id", "job_name", "check_id"):
        assert f"i.{column} <=> l.{column}" in code, column
    assert "l.status IN ('FAILED', 'WARNING')" in code
    # an OPEN incident is flagged only when its key is absent from the newest scan, HEALTHY there,
    # or a problem there that is not its newest problem row; any other status (UNKNOWN, or a
    # custom check's own status) neither opens nor ends an incident, so it stays OPEN
    open_part = code.split("UNION ALL", 1)[1]
    assert ("WHERE l.scan_id IS NULL OR l.status = 'HEALTHY' OR (l.status IN ('FAILED', 'WARNING') "
            "AND l.scan_id <> i.last_seen_scan_id)") in open_part
    assert "UNKNOWN" not in open_part.split("WHERE", 1)[1]

