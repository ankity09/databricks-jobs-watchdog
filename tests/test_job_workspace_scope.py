"""The optional job workspace ID is a real scope, not display-only metadata."""
import ast
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobs_watchdog.config import ConfigError, parse_monitored_jobs
from jobs_watchdog.config_tables import JOB_COLUMNS, JOBS_VIEW, read_config, write_config
from jobs_watchdog.upgrade import add_columns_statement, ddl_columns, missing_columns
from tests.test_config_tables import FakeSpark


def job_config(**extra):
    return {"job_name": "orders_ingest", "schedule_type": "continuous", **extra}


def parse_job(**extra):
    return parse_monitored_jobs({"jobs": [job_config(**extra)]}, "scope test")[0][0]


@pytest.mark.parametrize("raw,expected", [("1234", "1234"), (1234, "1234"), (9007199254740993, "9007199254740993")])
def test_job_workspace_id_preserves_exact_digits_without_workspace_labels(raw, expected):
    job = parse_job(workspace_id=raw)
    assert job.workspace_id == expected
    assert job.applies_to(expected)
    assert not job.applies_to("5678")
    assert not job.applies_to(None)


@pytest.mark.parametrize("raw", [True, False, 1234.5, "", "workspace-one", "1234.0", [1234]])
def test_invalid_job_workspace_id_never_silently_broadens_scope(raw):
    with pytest.raises(ConfigError, match="workspace_id must be digits"):
        parse_job(workspace_id=raw)


@pytest.mark.parametrize("extra", [{}, {"workspace_id": None}])
def test_legacy_unscoped_job_keeps_regional_matching(extra):
    job = parse_job(**extra)
    assert job.workspace_id is None
    assert job.applies_to("1234")
    assert job.applies_to("5678")


def test_workspace_scope_cannot_be_inherited_from_defaults():
    with pytest.raises(ConfigError, match="defaults.*workspace_id"):
        parse_monitored_jobs({"defaults": {"workspace_id": "1234"}, "jobs": [job_config()]}, "scope test")


def test_workspace_scope_is_not_an_environment_override():
    config = {
        "workspaces": [{"workspace_id": "1234", "environment": "lower"}],
        "jobs": [job_config(environments={"lower": {"workspace_id": "1234"}})],
    }
    with pytest.raises(ConfigError, match="unknown keys"):
        parse_monitored_jobs(config, "scope test")


def test_workspace_scope_does_not_change_logical_job_name_uniqueness():
    with pytest.raises(ConfigError, match="duplicate job_name"):
        parse_monitored_jobs({"jobs": [job_config(workspace_id="1234"), job_config(workspace_id="5678")]}, "scope test")


def test_workspace_scope_survives_config_table_write_and_read():
    job = parse_job(workspace_id="9007199254740993", job_ids=["111"])
    spark = FakeSpark()
    write_config(spark, [job], [], "main", "watchdog")
    frame = spark.views[JOBS_VIEW]
    row = dict(zip((name for name, _ in JOB_COLUMNS), frame.data[0]))
    assert row["workspace_id"] == "9007199254740993"
    loaded = FakeSpark({
        "main.watchdog.monitored_jobs": [row],
        "main.watchdog.job_dependencies": [],
        "main.watchdog.monitored_job_environments": [],
    })
    restored, _ = read_config(loaded, "main", "watchdog")
    assert restored[0].workspace_id == "9007199254740993"
    assert restored[0].job_ids == ("111",)


def test_old_monitored_jobs_table_gets_only_the_nullable_workspace_column():
    previous = [
        "job_name", "job_name_regex", "schedule_type", "max_gap_minutes", "max_runtime_minutes", "max_retries",
        "severity", "owner", "enabled", "notes", "loaded_at", "job_name_exclude_regex", "min_attempt_minutes", "job_ids",
    ]
    missing = missing_columns(previous, ddl_columns("sql/setup/02_create_monitored_jobs.sql"))
    assert [column.name for column in missing] == ["workspace_id"]
    statement = add_columns_statement("monitored_jobs", missing)
    assert "workspace_id STRING" in statement
    assert "DROP" not in statement.upper()


def test_notebook_enabled_summary_counts_environment_only_jobs():
    config = {
        "defaults": {"enabled": False},
        "workspaces": [{"workspace_id": "1234", "environment": "lower"}],
        "jobs": [job_config(environments={"lower": {"enabled": True}})],
    }
    jobs, _ = parse_monitored_jobs(config, "scope test")
    text = (Path(__file__).resolve().parents[1] / "notebooks/02_load_config.py").read_text()
    tree = ast.parse(text)
    assignment = next(
        node for node in ast.walk(tree)
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "enabled" for target in node.targets)
    )
    expression = ast.Expression(body=assignment.value)
    count = eval(compile(expression, "notebook enabled summary", "eval"), {"loaded": SimpleNamespace(jobs=jobs)})
    assert count == 1
