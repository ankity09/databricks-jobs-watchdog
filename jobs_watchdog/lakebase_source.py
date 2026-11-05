"""Read the newest monitored-jobs list from the Watchdog app's Lakebase project.

The Watchdog app keeps the list as versioned JSON documents in the table
watchdog_app.job_list_versions. Notebook 02 reads the newest version here when
config_source is lakebase. The run connects as the identity it runs as, with a
short-lived database credential, so it needs no stored password.

The caller passes in the Databricks API client (WorkspaceClient().api_client)
and the connect function (psycopg.connect, from psycopg_connect), so this
module needs neither package and the tests run without a workspace.
"""

import importlib
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime

APP_SCHEMA = "watchdog_app"
_ID = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
_DATABASE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
_QUERY = f"SELECT version, document, saved_by, saved_at FROM {APP_SCHEMA}.job_list_versions ORDER BY version DESC LIMIT 1"


class LakebaseSourceError(Exception):
    """Raised when the job list cannot be read from Lakebase."""


PSYCOPG_REQUIREMENT = "psycopg[binary]>=3.2,<4"


def psycopg_connect(run=subprocess.run, import_module=importlib.import_module):
    """psycopg.connect, installing psycopg into this Python first when it is missing.

    Only the Lakebase source needs psycopg, so a YAML load never reaches PyPI.
    A failed install raises LakebaseSourceError on one line, which notebook 02
    records as a FAILED config_loads row; the config tables keep their rows.
    """
    try:
        return import_module("psycopg").connect
    except ImportError:
        pass
    argv = [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", PSYCOPG_REQUIREMENT]
    try:
        done = run(argv, capture_output=True, text=True)
        lines = [line.strip() for line in (done.stderr or done.stdout or "").splitlines() if line.strip()]
        # pip's last ERROR line says why; a WARNING may come after it
        errors = [line for line in lines if line.startswith("ERROR:")]
        problem = None if done.returncode == 0 else (errors or lines or [f"pip exit code {done.returncode}"])[-1]
    except OSError as err:
        problem = str(err)
    if problem is not None:
        detail = " ".join(problem.removeprefix("ERROR:").split())[:160]
        raise LakebaseSourceError(f"could not install {PSYCOPG_REQUIREMENT}, which reading the job list from Lakebase "
                                  f"needs ({detail}). Let serverless compute reach PyPI or your package mirror; until "
                                  "then the scans use the last job list that loaded")
    importlib.invalidate_caches()
    return import_module("psycopg").connect


@dataclass(frozen=True)
class LakebaseTarget:
    """Which Lakebase project, branch and database hold the job list."""

    project_id: str
    branch: str = "production"
    database: str = "watchdog"

    def __post_init__(self):
        for widget, value in (("lakebase_project_id", self.project_id), ("lakebase_branch", self.branch)):
            if not _ID.match(value):
                raise LakebaseSourceError(f"{widget} must be lowercase letters, digits and - and start with a "
                                          f"letter, got {value!r}")
        if not _DATABASE.match(self.database):
            raise LakebaseSourceError(f"lakebase_database must be letters, digits and _, got {self.database!r}")

    @property
    def branch_path(self):
        return f"projects/{self.project_id}/branches/{self.branch}"

    @property
    def database_path(self):
        return f"{self.branch_path}/databases/{self.database}"


@dataclass(frozen=True)
class LoadedJobList:
    version: int
    document: dict
    saved_by: str
    saved_at: datetime


def read_write_endpoint(api, target):
    """(endpoint name, host) of the branch's read-write endpoint."""
    response = api.do("GET", f"/api/2.0/postgres/{target.branch_path}/endpoints")
    for endpoint in (response or {}).get("endpoints") or []:
        status = endpoint.get("status") or {}
        host = (status.get("hosts") or {}).get("host")
        if status.get("endpoint_type") == "ENDPOINT_TYPE_READ_WRITE" and host:
            return endpoint["name"], host
    raise LakebaseSourceError(f"{target.branch_path} has no read-write endpoint with a host: check that the "
                              "branch exists and its compute is set up")


def database_credential(api, endpoint_name):
    """A short-lived password for the endpoint, for the identity the API client runs as."""
    token = (api.do("POST", "/api/2.0/postgres/credentials", body={"endpoint": endpoint_name}) or {}).get("token")
    if not token:
        raise LakebaseSourceError(f"no database credential came back for {endpoint_name}")
    return token


def current_username(api):
    """The user name the API client runs as, which is also its Postgres role."""
    name = (api.do("GET", "/api/2.0/preview/scim/v2/Me") or {}).get("userName")
    if not name:
        raise LakebaseSourceError("could not read the user name of the identity running this notebook")
    return name


def open_branch(api, target, connect):
    """A connection to the target's database as the identity the API client runs as (a context manager, as psycopg's is)."""
    endpoint_name, host = read_write_endpoint(api, target)
    password = database_credential(api, endpoint_name)
    user = current_username(api)
    return connect(host=host, port=5432, dbname=target.database, user=user, password=password,
                   sslmode="require", connect_timeout=30)


def _fetch_latest(api, target, connect):
    with open_branch(api, target, connect) as connection:
        with connection.cursor() as cursor:
            cursor.execute(_QUERY)
            return cursor.fetchone()


def read_latest_job_list(api, target, connect, attempts=2, wait_seconds=3.0):
    """The newest saved version of the job list.

    A Lakebase compute that is waking up refuses the first connection, so a
    connection error gets one more try with a fresh credential.
    """
    for attempt in range(1, attempts + 1):
        try:
            row = _fetch_latest(api, target, connect)
            break
        except LakebaseSourceError:
            raise
        except Exception as err:
            name = type(err).__name__
            if name == "UndefinedTable":
                raise LakebaseSourceError(f"the Watchdog app has not created its tables in {target.database_path} "
                                          "yet: deploy and open the app first") from err
            if name != "OperationalError" or attempt == attempts:
                raise LakebaseSourceError(f"could not read the job list from {target.database_path}: "
                                          f"{name}: {str(err).strip()[:300]}") from err
            time.sleep(wait_seconds)
    if row is None:
        raise LakebaseSourceError(f"the job list in {target.database_path} is empty: import your job list in the "
                                  "Watchdog app first")
    version, document, saved_by, saved_at = row
    if isinstance(document, (str, bytes)):
        document = json.loads(document)
    return LoadedJobList(int(version), document, saved_by, saved_at)
