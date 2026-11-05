import json
import sys
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from jobs_watchdog.lakebase_source import (
    PSYCOPG_REQUIREMENT,
    LakebaseSourceError,
    LakebaseTarget,
    psycopg_connect,
    read_latest_job_list,
)

TARGET = LakebaseTarget("jobs-watchdog", "dev-engine", "watchdog")
ENDPOINTS = {"endpoints": [{"name": "projects/jobs-watchdog/branches/dev-engine/endpoints/primary",
                            "status": {"endpoint_type": "ENDPOINT_TYPE_READ_WRITE", "hosts": {"host": "ep-1.example"}}}]}


class FakeApi:
    def __init__(self, endpoints=ENDPOINTS):
        self.calls = []
        self.endpoints = endpoints

    def do(self, method, path, body=None, **_):
        self.calls.append((method, path, body))
        if path.endswith("/endpoints"):
            return self.endpoints
        if path.endswith("/credentials"):
            return {"token": "tok"}
        return {"userName": "someone@example.com"}


class FakeConnection:
    def __init__(self, row, error=None):
        self.row, self.error, self.sql, self.kwargs = row, error, None, None

    def __call__(self, **kwargs):
        if self.error:
            error, self.error = self.error, None
            raise error
        self.kwargs = kwargs
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def cursor(self):
        return self

    def execute(self, sql):
        self.sql = sql
        if self.error_on_execute:
            raise self.error_on_execute

    error_on_execute = None

    def fetchone(self):
        return self.row


def test_reads_the_newest_version_as_the_running_identity():
    saved = datetime(2026, 11, 5, tzinfo=timezone.utc)
    connect = FakeConnection((7, {"jobs": [{"job_name": "orders_ingest", "max_gap_minutes": 60}]}, "a@b.c", saved))
    api = FakeApi()
    loaded = read_latest_job_list(api, TARGET, connect)
    assert loaded.version == 7 and loaded.document["jobs"][0]["job_name"] == "orders_ingest"
    assert loaded.saved_by == "a@b.c" and loaded.saved_at == saved
    assert connect.kwargs["host"] == "ep-1.example" and connect.kwargs["dbname"] == "watchdog"
    assert connect.kwargs["user"] == "someone@example.com" and connect.kwargs["password"] == "tok"
    assert connect.kwargs["sslmode"] == "require" and connect.kwargs["port"] == 5432
    assert "ORDER BY version DESC LIMIT 1" in connect.sql and "watchdog_app.job_list_versions" in connect.sql
    assert ("POST", "/api/2.0/postgres/credentials",
            {"endpoint": "projects/jobs-watchdog/branches/dev-engine/endpoints/primary"}) in api.calls


def test_a_json_string_document_is_loaded():
    connect = FakeConnection((2, json.dumps({"jobs": []}), "a", datetime.now(timezone.utc)))
    assert read_latest_job_list(FakeApi(), TARGET, connect).document == {"jobs": []}


def test_an_empty_list_says_to_import_it_in_the_app_first():
    with pytest.raises(LakebaseSourceError, match="import your job list in the Watchdog app first"):
        read_latest_job_list(FakeApi(), TARGET, FakeConnection(None))


def test_a_missing_table_says_to_open_the_app_first():
    class UndefinedTable(Exception):
        pass
    connect = FakeConnection(None)
    connect.error_on_execute = UndefinedTable("relation does not exist")
    with pytest.raises(LakebaseSourceError, match="has not created its tables in projects/jobs-watchdog/branches/"
                                                  "dev-engine/databases/watchdog yet: deploy and open the app first"):
        read_latest_job_list(FakeApi(), TARGET, connect)


def test_a_waking_compute_gets_one_retry():
    class OperationalError(Exception):
        pass
    connect = FakeConnection((1, {"jobs": []}, "a", datetime.now(timezone.utc)), error=OperationalError("timeout"))
    assert read_latest_job_list(FakeApi(), TARGET, connect, wait_seconds=0).version == 1


def test_a_second_failure_is_reported():
    class OperationalError(Exception):
        pass

    def always_fails(**_):
        raise OperationalError("still asleep")
    with pytest.raises(LakebaseSourceError, match="still asleep"):
        read_latest_job_list(FakeApi(), TARGET, always_fails, wait_seconds=0)


def test_a_branch_without_a_read_write_endpoint_is_explained():
    api = FakeApi({"endpoints": [{"name": "x/endpoints/ro", "status": {"endpoint_type": "ENDPOINT_TYPE_READ_ONLY",
                                                                       "hosts": {"host": "h"}}}]})
    with pytest.raises(LakebaseSourceError, match="no read-write endpoint"):
        read_latest_job_list(api, TARGET, FakeConnection(None))


def test_ids_are_checked():
    with pytest.raises(LakebaseSourceError, match="lakebase_project_id"):
        LakebaseTarget("Jobs_Watchdog")
    with pytest.raises(LakebaseSourceError, match="lakebase_branch"):
        LakebaseTarget("jobs-watchdog", "Prod")


def test_paths_name_the_branch_and_database():
    assert TARGET.branch_path == "projects/jobs-watchdog/branches/dev-engine"
    assert TARGET.database_path == "projects/jobs-watchdog/branches/dev-engine/databases/watchdog"


PSYCOPG = SimpleNamespace(connect=object())


def importer(missing_times):
    """import_module that raises ImportError for psycopg the first missing_times calls."""
    calls = []

    def import_module(name):
        calls.append(name)
        if len(calls) <= missing_times:
            raise ImportError(f"No module named {name!r}")
        return PSYCOPG
    import_module.calls = calls
    return import_module


def pip(returncode, stderr=""):
    runs = []

    def run(argv, **kwargs):
        runs.append(argv)
        return SimpleNamespace(returncode=returncode, stdout="", stderr=stderr)
    run.runs = runs
    return run


def test_an_installed_psycopg_is_used_without_pip():
    run = pip(0)
    assert psycopg_connect(run=run, import_module=importer(0)) is PSYCOPG.connect
    assert run.runs == []


def test_a_missing_psycopg_is_installed_into_this_python_then_imported():
    run, import_module = pip(0), importer(1)
    assert psycopg_connect(run=run, import_module=import_module) is PSYCOPG.connect
    assert run.runs == [[sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
                         PSYCOPG_REQUIREMENT]]
    assert import_module.calls == ["psycopg", "psycopg"]


def test_a_failed_install_says_why_on_one_line_and_that_the_scans_keep_the_last_list():
    run = pip(1, "ERROR: Could not find a version that satisfies the requirement psycopg[binary]<4,>=3.2\n"
                 "ERROR: No matching distribution found for psycopg[binary]<4,>=3.2\n")
    with pytest.raises(LakebaseSourceError) as err:
        psycopg_connect(run=run, import_module=importer(9))
    text = str(err.value)
    assert text.startswith(f"could not install {PSYCOPG_REQUIREMENT}, which reading the job list from Lakebase needs")
    assert "No matching distribution found" in text and "last job list that loaded" in text
    assert "\n" not in text  # config_loads keeps the first line of the error


def test_the_detail_is_pip_s_error_line_not_a_warning_after_it():
    run = pip(1, "ERROR: No matching distribution found for psycopg[binary]<4,>=3.2\n"
                 "WARNING: There was an error checking the latest version of pip.\n")
    with pytest.raises(LakebaseSourceError) as err:
        psycopg_connect(run=run, import_module=importer(9))
    assert "No matching distribution found" in str(err.value) and "WARNING" not in str(err.value)


def test_an_install_that_cannot_start_is_a_lakebase_source_error_too():
    def run(argv, **kwargs):
        raise OSError("No such file or directory")
    with pytest.raises(LakebaseSourceError, match="could not install"):
        psycopg_connect(run=run, import_module=importer(9))
