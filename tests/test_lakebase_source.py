import importlib.metadata
import inspect
import json
import socket
import ssl
import struct
import subprocess
import sys
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pg8000.dbapi
import pytest
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from pg8000.exceptions import DatabaseError, InterfaceError

from jobs_watchdog import lakebase_source
from jobs_watchdog.lakebase_source import (
    GRANT_APP_ACCESS,
    PG8000_REQUIREMENT,
    LakebaseSourceError,
    LakebaseTarget,
    open_branch,
    pg8000_connect,
    read_latest_job_list,
)

ROOT = Path(__file__).resolve().parents[1]
TARGET = LakebaseTarget("jobs-watchdog", "dev-engine", "watchdog")
DATABASE_PATH = "projects/jobs-watchdog/branches/dev-engine/databases/watchdog"


def endpoints(host="ep-1.example"):
    return {"endpoints": [{"name": "projects/jobs-watchdog/branches/dev-engine/endpoints/primary",
                           "status": {"endpoint_type": "ENDPOINT_TYPE_READ_WRITE", "hosts": {"host": host}}}]}


ROW = [1, {"jobs": []}, "a@b.c", datetime(2026, 11, 5, tzinfo=timezone.utc)]


class FakeApi:
    """The SDK's api_client: the branch's endpoints, a new credential on each call, and the identity's user name."""

    def __init__(self, listed=None):
        self.calls = []
        self.listed = endpoints() if listed is None else listed

    def do(self, method, path, body=None, **_):
        self.calls.append((method, path, body))
        if path.endswith("/endpoints"):
            return self.listed
        if path.endswith("/credentials"):
            return {"token": f"tok-{sum(called.endswith('/credentials') for _, called, _ in self.calls)}"}
        return {"userName": "someone@example.com"}


def server_error(code, message):
    """What pg8000 raises for a Postgres error: one dict of the server's fields, C the SQLSTATE and M the message."""
    return DatabaseError({"S": "ERROR", "V": "ERROR", "C": code, "M": message, "P": "51", "F": "parse_relation.c",
                          "L": "1449", "R": "parserOpenTable"})


class FakeDriver:
    """pg8000.dbapi.connect, and the connection it gives. Like pg8000's, the cursor has no with block."""

    def __init__(self, row, connect_errors=(), query_error=None):
        self.row, self.connect_errors, self.query_error = row, list(connect_errors), query_error
        self.connects, self.sql, self.closed = [], None, False

    def __call__(self, **kwargs):
        self.connects.append(kwargs)
        if self.connect_errors:
            raise self.connect_errors.pop(0)
        return self

    def cursor(self):
        return SimpleNamespace(execute=self._execute, fetchone=lambda: self.row, close=lambda: None)

    def _execute(self, sql, args=()):
        self.sql = sql
        if self.query_error:
            raise self.query_error

    def close(self):
        self.closed = True


def test_reads_the_newest_version_as_the_running_identity():
    saved = datetime(2026, 11, 5, tzinfo=timezone.utc)
    driver = FakeDriver([7, {"jobs": [{"job_name": "orders_ingest", "max_gap_minutes": 60}]}, "a@b.c", saved])
    api = FakeApi()
    loaded = read_latest_job_list(api, TARGET, driver)
    assert loaded.version == 7 and loaded.document["jobs"][0]["job_name"] == "orders_ingest"
    assert loaded.saved_by == "a@b.c" and loaded.saved_at == saved
    [connected] = driver.connects
    assert connected["host"] == "ep-1.example" and connected["port"] == 5432 and connected["database"] == "watchdog"
    assert connected["user"] == "someone@example.com" and connected["password"] == "tok-1"
    assert "ORDER BY version DESC LIMIT 1" in driver.sql and "watchdog_app.job_list_versions" in driver.sql
    assert ("POST", "/api/2.0/postgres/credentials",
            {"endpoint": "projects/jobs-watchdog/branches/dev-engine/endpoints/primary"}) in api.calls
    assert driver.closed


def test_the_connection_passes_only_arguments_pg8000_takes():
    driver = FakeDriver(ROW)
    read_latest_job_list(FakeApi(), TARGET, driver)
    assert set(driver.connects[0]) <= set(inspect.signature(pg8000.dbapi.connect).parameters)


def test_the_connection_checks_the_server_certificate_and_its_host_name():
    # pg8000 reads ssl_context None or True as TLS without any check, so it must get a context that verifies.
    driver = FakeDriver(ROW)
    read_latest_job_list(FakeApi(), TARGET, driver)
    context = driver.connects[0]["ssl_context"]
    assert isinstance(context, ssl.SSLContext)
    assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname


def test_a_json_string_document_is_loaded():
    driver = FakeDriver([2, json.dumps({"jobs": []}), "a", datetime.now(timezone.utc)])
    assert read_latest_job_list(FakeApi(), TARGET, driver).document == {"jobs": []}


def test_an_empty_list_says_to_import_it_in_the_app_first():
    with pytest.raises(LakebaseSourceError, match="import your job list in the Watchdog app first"):
        read_latest_job_list(FakeApi(), TARGET, FakeDriver(None))


def test_a_missing_table_says_to_open_the_app_first():
    driver = FakeDriver(None, query_error=server_error("42P01", 'relation "watchdog_app.job_list_versions" does not exist'))
    with pytest.raises(LakebaseSourceError, match=f"has not created its tables in {DATABASE_PATH} yet: deploy and "
                                                  "open the app first"):
        read_latest_job_list(FakeApi(), TARGET, driver)
    assert driver.closed


def test_a_failed_query_gives_postgres_s_message_once_and_closes_the_connection():
    driver = FakeDriver(None, query_error=server_error("42501", "permission denied for schema watchdog_app"))
    with pytest.raises(LakebaseSourceError) as err:
        read_latest_job_list(FakeApi(), TARGET, driver, wait_seconds=0)
    assert str(err.value) == (f"could not read the job list from {DATABASE_PATH}: DatabaseError: permission denied "
                              "for schema watchdog_app (SQLSTATE 42501)")
    assert len(driver.connects) == 1 and driver.closed


def test_a_connection_that_is_gone_does_not_hide_the_query_s_error():
    driver = FakeDriver(None, query_error=InterfaceError("network error"))

    def close():
        raise InterfaceError("connection is closed")
    driver.close = close
    with pytest.raises(LakebaseSourceError, match="could not read the job list from .*: InterfaceError: network error"):
        read_latest_job_list(FakeApi(), TARGET, driver, wait_seconds=0)


def test_a_failed_first_connect_gets_one_retry_with_a_fresh_credential():
    # A Lakebase compute that scaled to zero wakes up in about a second, and can refuse the first connection.
    waking = server_error("57P03", "the database system is starting up")
    driver = FakeDriver(ROW, connect_errors=[waking])
    assert read_latest_job_list(FakeApi(), TARGET, driver, wait_seconds=0).version == 1
    assert [connected["password"] for connected in driver.connects] == ["tok-1", "tok-2"]


def test_notebook_11_s_connection_gets_the_same_one_retry(monkeypatch):
    # Notebook 11 connects through open_branch itself, after a teardown, when the kept project's compute may be asleep.
    monkeypatch.setattr(lakebase_source.time, "sleep", lambda seconds: None)
    driver = FakeDriver(ROW, connect_errors=[server_error("57P03", "the database system is starting up")])
    with open_branch(FakeApi(), TARGET, driver) as connection:
        assert connection is driver
    assert [connected["password"] for connected in driver.connects] == ["tok-1", "tok-2"] and driver.closed


def test_a_second_failed_connect_says_why_on_one_line():
    refused = InterfaceError("Can't create a connection to host ep-1.example and port 5432 (timeout is 30 and "
                             "source_address is None).")
    refused.__cause__ = ConnectionRefusedError(61, "Connection refused")
    driver = FakeDriver(ROW, connect_errors=[server_error("57P03", "the database system is starting up"), refused])
    with pytest.raises(LakebaseSourceError) as err:
        read_latest_job_list(FakeApi(), TARGET, driver, wait_seconds=0)
    text = str(err.value)
    assert text.startswith(f"could not connect to {DATABASE_PATH} as someone@example.com: InterfaceError: Can't "
                           "create a connection to host ep-1.example and port 5432")
    assert text.endswith("(ConnectionRefusedError: [Errno 61] Connection refused)") and "\n" not in text
    assert len(driver.connects) == 2


def test_a_refused_login_gives_postgres_s_message_not_pg8000_s_field_dict():
    # The Lakebase proxy's own errors carry only S, C and M.
    bad_token = DatabaseError({"S": "ERROR", "C": "28P01", "M": "Provided authentication token is not a valid JWT "
                                                                "encoding"})
    driver = FakeDriver(ROW, connect_errors=[bad_token, bad_token])
    with pytest.raises(LakebaseSourceError) as err:
        read_latest_job_list(FakeApi(), TARGET, driver, wait_seconds=0)
    assert str(err.value).endswith(": DatabaseError: Provided authentication token is not a valid JWT encoding "
                                   "(SQLSTATE 28P01)")


def test_a_branch_without_a_read_write_endpoint_is_explained():
    api = FakeApi({"endpoints": [{"name": "x/endpoints/ro", "status": {"endpoint_type": "ENDPOINT_TYPE_READ_ONLY",
                                                                       "hosts": {"host": "h"}}}]})
    driver = FakeDriver(None)
    with pytest.raises(LakebaseSourceError, match="no read-write endpoint"):
        read_latest_job_list(api, TARGET, driver)
    assert driver.connects == []


def test_ids_are_checked():
    with pytest.raises(LakebaseSourceError, match="lakebase_project_id"):
        LakebaseTarget("Jobs_Watchdog")
    with pytest.raises(LakebaseSourceError, match="lakebase_branch"):
        LakebaseTarget("jobs-watchdog", "Prod")


def test_paths_name_the_branch_and_database():
    assert TARGET.branch_path == "projects/jobs-watchdog/branches/dev-engine"
    assert TARGET.database_path == DATABASE_PATH


# The TLS check with the real driver, against a stand-in endpoint on this machine. It answers Postgres's TLS
# request with a certificate from a throwaway CA, then refuses the login, so a refused login means TLS went
# through. SSL_CERT_FILE makes this Python trust the CA, the way the system's CA bundle trusts Lakebase's.


def certificates(folder, host):
    """A throwaway CA and a server certificate for host that it signed, as PEM files: (CA, certificate, key)."""
    x509 = pytest.importorskip("cryptography.x509")
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = datetime.now(timezone.utc)
    ca_key, key = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Watchdog test CA")])

    def signed(subject, public_key, ca):
        built = (x509.CertificateBuilder().subject_name(subject).issuer_name(ca_name).public_key(public_key)
                 .serial_number(x509.random_serial_number())
                 .not_valid_before(now - timedelta(hours=1)).not_valid_after(now + timedelta(hours=1))
                 .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
                 .add_extension(x509.SubjectKeyIdentifier.from_public_key(public_key), critical=False)
                 .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
                                critical=False))
        if ca:
            signs = x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                  data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                                  encipher_only=False, decipher_only=False)
            built = built.add_extension(signs, critical=True)
        else:
            built = (built.add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
                     .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False))
        return built.sign(ca_key, hashes.SHA256())

    files = folder / "ca.pem", folder / "server.pem", folder / "server.key"
    files[0].write_bytes(signed(ca_name, ca_key.public_key(), ca=True).public_bytes(serialization.Encoding.PEM))
    files[1].write_bytes(signed(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)]), key.public_key(), ca=False)
                         .public_bytes(serialization.Encoding.PEM))
    files[2].write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    return files


@contextmanager
def stand_in_endpoint(certificate, key):
    """A Postgres endpoint on localhost that answers TLS with the certificate, then refuses every login. Yields its port."""
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(certificate, key)
    listener = socket.create_server(("127.0.0.1", 0))

    def serve():
        while True:
            try:
                connection, _ = listener.accept()
            except OSError:
                return
            with connection:
                try:
                    connection.recv(8)  # SSLRequest
                    connection.sendall(b"S")
                    with tls.wrap_socket(connection, server_side=True) as secured:
                        secured.recv(4096)  # the startup message
                        fields = b"SFATAL\0C28000\0Mthe stand-in endpoint refuses every login\0\0"
                        secured.sendall(b"E" + struct.pack("!i", len(fields) + 4) + fields)
                except OSError:  # the client refused the certificate
                    pass

    threading.Thread(target=serve, daemon=True).start()
    try:
        yield listener.getsockname()[1]
    finally:
        listener.close()


def connect_to(port):
    """The real pg8000.dbapi.connect, sent to the stand-in endpoint's port."""
    return lambda **arguments: pg8000.dbapi.connect(**{**arguments, "port": port})


def open_stand_in(port):
    with open_branch(FakeApi(endpoints("localhost")), TARGET, connect_to(port), wait_seconds=0):
        pass


@pytest.fixture
def ca_bundle(monkeypatch):
    """Point this Python's CA bundle at a file, or leave the system's when given None."""
    def use(path):
        monkeypatch.delenv("SSL_CERT_DIR", raising=False)
        if path is None:
            monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        else:
            monkeypatch.setenv("SSL_CERT_FILE", str(path))
    return use


def test_tls_with_a_trusted_certificate_for_the_host_goes_through(tmp_path, ca_bundle):
    ca, certificate, key = certificates(tmp_path, "localhost")
    ca_bundle(ca)
    with stand_in_endpoint(certificate, key) as port:
        with pytest.raises(LakebaseSourceError) as err:
            open_stand_in(port)
    assert str(err.value).endswith("DatabaseError: the stand-in endpoint refuses every login (SQLSTATE 28000)")


def test_a_certificate_from_a_ca_this_python_does_not_trust_is_refused(tmp_path, ca_bundle):
    ca, certificate, key = certificates(tmp_path, "localhost")
    ca_bundle(None)
    with stand_in_endpoint(certificate, key) as port:
        with pytest.raises(LakebaseSourceError, match="SSLCertVerificationError: .*certificate verify failed"):
            open_stand_in(port)


def test_a_trusted_certificate_for_another_host_is_refused(tmp_path, ca_bundle):
    ca, certificate, key = certificates(tmp_path, "ep-other.example")
    ca_bundle(ca)
    with stand_in_endpoint(certificate, key) as port:
        with pytest.raises(LakebaseSourceError, match="certificate verify failed: Hostname mismatch"):
            open_stand_in(port)


# Installing pg8000 at run time, only for the Lakebase source and the app access grant.

PG8000 = SimpleNamespace(connect=object())


def importer(missing_times):
    """import_module that raises ImportError for pg8000 the first missing_times calls."""
    calls = []

    def import_module(name):
        calls.append(name)
        if len(calls) <= missing_times:
            raise ImportError(f"No module named {name!r}")
        return PG8000
    import_module.calls = calls
    return import_module


def pip(returncode, stderr=""):
    runs = []

    def run(argv, **kwargs):
        runs.append(argv)
        return SimpleNamespace(returncode=returncode, stdout="", stderr=stderr)
    run.runs = runs
    return run


def test_an_installed_pg8000_is_used_without_pip():
    run, import_module = pip(0), importer(0)
    assert pg8000_connect(run=run, import_module=import_module) is PG8000.connect
    assert run.runs == [] and import_module.calls == ["pg8000.dbapi"]


def test_a_missing_pg8000_is_installed_into_this_python_then_imported():
    run, import_module = pip(0), importer(1)
    assert pg8000_connect(run=run, import_module=import_module) is PG8000.connect
    assert run.runs == [[sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
                         PG8000_REQUIREMENT]]
    assert import_module.calls == ["pg8000.dbapi", "pg8000.dbapi"]


def test_a_failed_install_says_why_on_one_line_and_that_the_scans_keep_the_last_list():
    run = pip(1, "ERROR: Could not find a version that satisfies the requirement pg8000<1.32,>=1.31\n"
                 "ERROR: No matching distribution found for pg8000<1.32,>=1.31\n")
    with pytest.raises(LakebaseSourceError) as err:
        pg8000_connect(run=run, import_module=importer(9))
    text = str(err.value)
    assert text.startswith(f"could not install {PG8000_REQUIREMENT}, which reading the job list from Lakebase needs")
    assert "No matching distribution found" in text and "last job list that loaded" in text
    assert "\n" not in text  # config_loads keeps the first line of the error


def test_the_detail_is_pip_s_error_line_not_a_warning_after_it():
    run = pip(1, "ERROR: No matching distribution found for pg8000<1.32,>=1.31\n"
                 "WARNING: There was an error checking the latest version of pip.\n")
    with pytest.raises(LakebaseSourceError) as err:
        pg8000_connect(run=run, import_module=importer(9))
    assert "No matching distribution found" in str(err.value) and "WARNING" not in str(err.value)


def test_an_install_that_cannot_start_is_a_lakebase_source_error_too():
    def run(argv, **kwargs):
        raise OSError("No such file or directory")
    with pytest.raises(LakebaseSourceError, match="could not install"):
        pg8000_connect(run=run, import_module=importer(9))


def test_an_install_that_still_cannot_be_imported_is_a_lakebase_source_error():
    with pytest.raises(LakebaseSourceError) as err:
        pg8000_connect(run=pip(0), import_module=importer(9))
    text = str(err.value)
    assert text.startswith(f"installed {PG8000_REQUIREMENT}, which reading the job list from Lakebase needs, but "
                           "could not import it (No module named 'pg8000.dbapi')")
    assert "last job list that loaded" in text and "\n" not in text


def test_notebook_11_s_failed_install_is_about_the_app_s_access_not_the_scans():
    run = pip(1, "ERROR: No matching distribution found for pg8000<1.32,>=1.31\n")
    with pytest.raises(LakebaseSourceError) as err:
        pg8000_connect(GRANT_APP_ACCESS, run=run, import_module=importer(9))
    text = str(err.value)
    assert text.startswith(f"could not install {PG8000_REQUIREMENT}, which giving the app access to its job list needs")
    assert "No matching distribution found" in text and "watchdog_app_access" in text
    assert "scans" not in text and "\n" not in text


def test_pg8000_and_everything_it_needs_are_pure_python():
    # The notebook imports the driver in its own Python right after pip installs it. Compiled code could bring
    # its own OpenSSL, and on some serverless hosts that OpenSSL fails its FIPS self-test and aborts the Python
    # process before notebook 02 can record a FAILED load. pg8000's TLS is Python's ssl module.
    wanted = Requirement(PG8000_REQUIREMENT)
    assert wanted.name == "pg8000" and not wanted.extras
    assert importlib.metadata.version("pg8000") in wanted.specifier, "pip install -r requirements-dev.txt"
    compiled, todo = {}, [wanted]
    while todo:
        requirement = todo.pop()
        name = canonicalize_name(requirement.name)
        if name in compiled:
            continue
        distribution = importlib.metadata.distribution(name)
        compiled[name] = [str(file) for file in distribution.files or []
                          if file.suffix in {".so", ".pyd", ".dylib", ".dll"}]
        todo += [needed for needed in map(Requirement, distribution.requires or [])
                 if needed.marker is None or needed.marker.evaluate({"extra": ""})]
    assert {"pg8000", "scramp"} <= set(compiled)
    assert {name: files for name, files in compiled.items() if files} == {}


def test_the_engine_never_imports_psycopg():
    # psycopg's binary wheel bundles an OpenSSL that aborts Python on some serverless hosts. Import every engine
    # module and the driver, as the notebooks do, and record any attempt to import psycopg, even one that fails.
    code = "\n".join([
        "import importlib, pkgutil, sys",
        "tried = []",
        "class Spy:",
        "    def find_spec(self, name, path=None, target=None):",
        "        if name.split('.')[0].startswith('psycopg'):",
        "            tried.append(name)",
        "sys.meta_path.insert(0, Spy())",
        "import jobs_watchdog",
        "for module in pkgutil.iter_modules(jobs_watchdog.__path__):",
        "    importlib.import_module('jobs_watchdog.' + module.name)",
        "from jobs_watchdog.lakebase_source import pg8000_connect",
        "connect = pg8000_connect(run=None)",
        "print(connect.__module__, tried, sorted(name for name in sys.modules if name.startswith('psycopg')))",
    ])
    done = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr
    assert done.stdout.split() == ["pg8000.dbapi", "[]", "[]"]


def test_no_notebook_job_or_script_names_psycopg():
    # The notebooks and jobs install their own packages (a %pip line, a job environment), which no import shows.
    files = [path for folder in ("jobs_watchdog", "notebooks", "scripts", "resources", "sql")
             for path in (ROOT / folder).rglob("*") if path.suffix in {".py", ".yml", ".yaml", ".sql", ".sh"}]
    files += [ROOT / name for name in ("databricks.yml", "accelerator.yaml", "requirements-dev.txt", "pyproject.toml",
                                       "teardown.sh")]
    hits = [f"{path.relative_to(ROOT)}:{number}" for path in files
            for number, line in enumerate(path.read_text().splitlines(), 1) if "psycopg" in line.lower()]
    assert hits == []
