"""Read the newest monitored-jobs list from the Watchdog app's Lakebase project.

The Watchdog app keeps the list as versioned JSON documents in the table
watchdog_app.job_list_versions. Notebook 02 reads the newest version here when
config_source is lakebase. The run connects as the identity it runs as, with a
short-lived database credential, so it needs no stored password.

The caller passes in the Databricks API client (WorkspaceClient().api_client)
and the connect function (pg8000.dbapi.connect, from pg8000_connect), so this
module needs neither package and the tests run without a workspace.
"""

import importlib
import json
import re
import ssl
import subprocess
import sys
import time
from contextlib import closing, contextmanager
from dataclasses import dataclass
from datetime import datetime

APP_SCHEMA = "watchdog_app"
_ID = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
_DATABASE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
_QUERY = f"SELECT version, document, saved_by, saved_at FROM {APP_SCHEMA}.job_list_versions ORDER BY version DESC LIMIT 1"
_UNDEFINED_TABLE = "42P01"  # the SQLSTATE of a missing table
_CANNOT_CONNECT_NOW = "57P03"  # the database system is starting up
_TIMEOUT_SECONDS = 30  # pg8000's socket timeout, for connecting and for each statement


class LakebaseSourceError(Exception):
    """Raised when the job list cannot be read from Lakebase."""


# pg8000 is a pure-Python Postgres driver: its TLS is Python's own ssl module, on the system's OpenSSL. A driver
# wheel that bundles its own OpenSSL can abort this Python process as it loads, on hosts where that OpenSSL fails
# its FIPS self-test, and then notebook 02 cannot record the failed load. pip picks 1.31.5 on Python 3.10 and
# 1.31.6 on 3.11 and later, and both are checked. pg8000 has changed its API in minor releases, so 1.32 is left
# out until it is checked.
PG8000_REQUIREMENT = "pg8000>=1.31,<1.32"

# What each notebook needs pg8000 for, and what to do when it cannot be installed.
READ_JOB_LIST = ("reading the job list from Lakebase", "until then the scans use the last job list that loaded")
GRANT_APP_ACCESS = ("giving the app access to its job list",
                    "then run the watchdog_app_access job again, as a deploy runs it only when the app gets a new "
                    "service principal")


def pg8000_connect(purpose=READ_JOB_LIST, run=subprocess.run, import_module=importlib.import_module):
    """pg8000.dbapi.connect, installing pg8000 into this Python first when it is missing.

    Only the Lakebase source (notebook 02) and the app access grant (notebook 11)
    need pg8000, so a YAML load never reaches PyPI. Being pure Python, it is
    imported right after the install, in the same process. A failed install
    raises LakebaseSourceError on one line that says what purpose, one of the
    pairs above, needs it: notebook 02 records it as a FAILED config_loads row,
    and the config tables keep their rows.
    """
    try:
        return import_module("pg8000.dbapi").connect
    except ImportError:
        pass
    needed_for, meanwhile = purpose
    argv = [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", PG8000_REQUIREMENT]
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
        raise LakebaseSourceError(f"could not install {PG8000_REQUIREMENT}, which {needed_for} needs ({detail}). "
                                  f"Let serverless compute reach PyPI or your package mirror; {meanwhile}")
    importlib.invalidate_caches()
    try:
        return import_module("pg8000.dbapi").connect
    except ImportError as err:
        detail = " ".join(str(err).split())[:160]
        raise LakebaseSourceError(f"installed {PG8000_REQUIREMENT}, which {needed_for} needs, but could not import "
                                  f"it ({detail}); {meanwhile}") from err


def tls_context():
    """TLS that checks the server's certificate and host name against this Python's CA certificates.

    A Lakebase endpoint presents a certificate for its host name from a public
    CA, which the system's CA bundle trusts. pg8000 reads ssl_context None or
    True as TLS without any check, so every connection gets this context.
    """
    return ssl.create_default_context()


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


def _server_fields(err):
    """The fields of an error the Postgres server sent: pg8000 raises it with one dict, C the SQLSTATE, M the message."""
    return err.args[0] if err.args and isinstance(err.args[0], dict) else {}


def error_line(err):
    """The error's type and text on one line: for a server error, Postgres's message and SQLSTATE.

    pg8000 keeps the socket's own error of a failed connection in __cause__, so that is named too.
    """
    fields = _server_fields(err)
    if fields.get("M"):
        text = f"{fields['M']} (SQLSTATE {fields['C']})" if fields.get("C") else fields["M"]
    else:
        text = str(err)
    cause = err.__cause__
    if cause is not None:
        text += f" ({type(cause).__name__}: {cause})" if str(cause) else f" ({type(cause).__name__})"
    return " ".join(f"{type(err).__name__}: {text}".split())[:300]


def _certificate_failure(err):
    """Whether the server's certificate did not verify, in this error or one it was raised from."""
    seen = set()
    while err is not None and id(err) not in seen:
        if isinstance(err, ssl.SSLCertVerificationError):
            return True
        seen.add(id(err))
        err = err.__cause__ or err.__context__
    return False


def _waking(err):
    """Whether a failed connection is what a compute that is waking up gives, so that one more try can work.

    That is a socket error, pg8000's InterfaceError for one (or for a server
    that closed the connection), or a server error of class 08 (connection
    exception) or 57P03 (cannot connect now). A certificate that does not
    verify, a refused login (class 28) and any other error do not heal.
    """
    if _certificate_failure(err):
        return False
    code = _server_fields(err).get("C")
    if code:
        return code.startswith("08") or code == _CANNOT_CONNECT_NOW
    if isinstance(err, OSError):
        return True
    if type(err).__name__ == "InterfaceError":  # pg8000's; this module does not import pg8000
        return isinstance(err.__cause__, OSError) or str(err) == "network error"
    return False


@contextmanager
def open_branch(api, target, connect, attempts=2, wait_seconds=3.0):
    """A pg8000 connection to the target's database as the identity the API client runs as, for a with block.

    TLS checks the server's certificate and host name (tls_context). A Lakebase
    compute that scaled to zero wakes up in about a second and can refuse the
    first connection, so a connection that fails that way (_waking) gets one
    more try with a fresh credential. Any other failure, or a second one,
    raises LakebaseSourceError with the reason.
    The with block closes the connection and does not commit. A connection
    that is gone already does not hide the block's own error.
    """
    endpoint_name, host = read_write_endpoint(api, target)
    user = current_username(api)
    for attempt in range(1, attempts + 1):
        password = database_credential(api, endpoint_name)
        try:
            connection = connect(user=user, host=host, port=5432, database=target.database, password=password,
                                 ssl_context=tls_context(), timeout=_TIMEOUT_SECONDS)
            break
        except Exception as err:
            if attempt == attempts or not _waking(err):
                raise LakebaseSourceError(f"could not connect to {target.database_path} as {user}: "
                                          f"{error_line(err)}") from err
            time.sleep(wait_seconds)
    try:
        yield connection
    finally:
        try:
            connection.close()
        except Exception:
            pass  # gone already: the block's own error, if any, says why


def read_latest_job_list(api, target, connect, attempts=2, wait_seconds=3.0):
    """The newest saved version of the job list. A connection a waking compute refused gets one more try (open_branch)."""
    try:
        with open_branch(api, target, connect, attempts, wait_seconds) as connection:
            with closing(connection.cursor()) as cursor:
                cursor.execute(_QUERY)
                row = cursor.fetchone()
    except LakebaseSourceError:
        raise
    except Exception as err:
        if _server_fields(err).get("C") == _UNDEFINED_TABLE:
            raise LakebaseSourceError(f"the Watchdog app has not created its tables in {target.database_path} "
                                      "yet: deploy and open the app first") from err
        raise LakebaseSourceError(f"could not read the job list from {target.database_path}: "
                                  f"{error_line(err)}") from err
    if row is None:
        raise LakebaseSourceError(f"the job list in {target.database_path} is empty: import your job list in the "
                                  "Watchdog app first")
    version, document, saved_by, saved_at = row
    if isinstance(document, (str, bytes)):
        document = json.loads(document)
    return LoadedJobList(int(version), document, saved_by, saved_at)
