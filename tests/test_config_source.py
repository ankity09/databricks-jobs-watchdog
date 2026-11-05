from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from jobs_watchdog import config_source
from jobs_watchdog.config import ConfigError
from jobs_watchdog.lakebase_source import LoadedJobList
from jobs_watchdog.sqlfiles import repo_root

EXAMPLE = repo_root() / "config" / "monitored_jobs.example.yml"
DATABASE_PATH = "projects/jobs-watchdog/branches/production/databases/watchdog"


def settings(source, path=EXAMPLE):
    return SimpleNamespace(config_source=source, monitored_jobs_path=path, lakebase_project_id="jobs-watchdog",
                           lakebase_branch="production", lakebase_database="watchdog")


def loaded_list(document, version=4):
    return LoadedJobList(version, document, "a@b.c", datetime(2026, 11, 5, tzinfo=timezone.utc))


def test_yaml_reads_the_file_as_before():
    loaded = config_source.load_config(settings("yaml"))
    assert loaded.source == "yaml" and loaded.source_ref == str(EXAMPLE) and loaded.version is None
    assert loaded.jobs and isinstance(loaded.workspaces, list)


def test_lakebase_reads_the_newest_version(monkeypatch):
    document = {"jobs": [{"job_name": "orders_ingest", "max_gap_minutes": 60}],
                "workspaces": [{"workspace_id": 123, "environment": "lower"}]}
    seen = {}

    def fake_read(api, target, connect):
        seen.update(api=api, target=target, connect=connect)
        return loaded_list(document)

    monkeypatch.setattr(config_source, "read_latest_job_list", fake_read)
    loaded = config_source.load_config(settings("lakebase"), api="api", connect="connect")
    assert loaded.source == "lakebase" and loaded.source_ref == DATABASE_PATH and loaded.version == 4
    assert [j.job_name for j in loaded.jobs] == ["orders_ingest"]
    assert loaded.workspaces[0].workspace_id == "123"
    assert seen["api"] == "api" and seen["target"].database_path == DATABASE_PATH


def test_a_rule_error_in_the_document_names_the_version(monkeypatch):
    monkeypatch.setattr(config_source, "read_latest_job_list", lambda *a: loaded_list({"jobs": []}))
    with pytest.raises(ConfigError, match="Lakebase job list version 4 lists no jobs"):
        config_source.load_config(settings("lakebase"), api="api", connect="connect")


def test_lakebase_needs_the_api_and_a_connect_function():
    with pytest.raises(ValueError, match="api and connect"):
        config_source.load_config(settings("lakebase"))


def test_source_ref_works_even_when_the_load_would_fail():
    assert config_source.source_ref_for(settings("yaml", "/no/such/file.yml")) == "/no/such/file.yml"
    assert config_source.source_ref_for(settings("lakebase")) == DATABASE_PATH
    broken = settings("lakebase")
    broken.lakebase_project_id = "Bad_Id"
    assert "Bad_Id" in config_source.source_ref_for(broken)
