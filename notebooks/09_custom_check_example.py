# Databricks notebook source
# MAGIC %md
# MAGIC # 09 · Custom check example: service connectivity
# MAGIC
# MAGIC **What it does.** Probes each service in `SERVICES` with a TCP connection, then a TLS handshake. It adds one row per service to `findings`, with `source = CUSTOM` and `check_id = service_connectivity`. The row's `job_name` is the service name. When a probe fails, `affected_jobs` lists the monitored jobs that depend on that service.
# MAGIC
# MAGIC **Inputs (widgets).** `catalog`, `schema`, `region`, `scan_id`. Use the same `scan_id` as notebooks 05 and 06; the `watchdog_scan` job passes it for you.
# MAGIC
# MAGIC **What to look for.** One row per service: HEALTHY, or FAILED with `error_summary` saying why (for example DNS, refused, timed out, or a certificate error). Hosts ending in `.example.com` are placeholders and are skipped, so this example writes nothing until you replace them.
# MAGIC
# MAGIC **Where it must run.** Serverless compute cannot reach private endpoints. Run this notebook on a job cluster whose network can reach the services. The commented task in `resources/watchdog_scan.job.yml` shows how, with its own cluster and `policy_id`.
# MAGIC
# MAGIC **Add your own checks.** Build rows with the same keys (`job_name`, `check_id`, `status`, `severity`, `owner`, `error_summary`, `source`), then pass them to `finalize_rows` and `write_findings`, as the last code cells do. Give each kind of check its own `check_id`. `finalize_rows` fills `failure_category` and `affected_jobs`; a row about a configured job takes that job's severity and owner instead of its own.

# COMMAND ----------

# MAGIC %run ./_setup

# COMMAND ----------

# Shows the input boxes (widgets) at the top of the notebook. Fill them in, then run the cells below.
NAMES = ("catalog", "schema", "region", "scan_id")
define_widgets(*NAMES)

# COMMAND ----------

s = settings(*NAMES)

# COMMAND ----------

import os
import shutil
import socket
import ssl
import tempfile
from datetime import datetime, timezone

from jobs_watchdog.config_tables import read_config
from jobs_watchdog.findings import finalize_rows, new_scan_id, write_findings

# Services to probe. The names match the service dependencies in the example
# monitored-jobs file, so affected_jobs is filled in for them.
SERVICES = [
    {"name": "config_api", "host": "config-api.internal.example.com", "port": 443, "mtls": False,
     "severity": "WARNING", "owner": "platform-team"},
    {"name": "kafka", "host": "kafka.internal.example.com", "port": 9093, "mtls": False,
     "severity": "CRITICAL", "owner": "platform-team"},
]
# each name is one findings key per scan, so two entries must not share a name
# (name two brokers kafka_1 and kafka_2, and list both as dependencies)
duplicates = sorted({s["name"] for s in SERVICES if [x["name"] for x in SERVICES].count(s["name"]) > 1})
if duplicates:
    raise ValueError(f"SERVICES lists these names more than once: {', '.join(duplicates)}")
PLACEHOLDER_SUFFIX = ".example.com"  # skips placeholder hosts; remove it when you add your own
TIMEOUT_SECONDS = 5

# mTLS only: the secret scope and keys that hold the client certificate and its key, as PEM text.
# Create them yourself, and let the identity that runs the job read the scope.
MTLS_SECRET_SCOPE = "your-secret-scope"
MTLS_CERT_KEY = "client_cert_pem"
MTLS_KEY_KEY = "client_key_pem"

# COMMAND ----------


def client_context(mtls):
    """A TLS context that checks the server certificate. With mtls, it also presents a client certificate.

    ssl loads certificates from files, so the PEM text is written to a new temp
    folder on the driver (mkdtemp makes it readable by this user only), loaded,
    and deleted again. For a private CA, pass its PEM file as cafile to
    ssl.create_default_context.
    """
    context = ssl.create_default_context()
    if mtls:
        folder = tempfile.mkdtemp()
        try:
            cert_file = os.path.join(folder, "client.crt")
            key_file = os.path.join(folder, "client.key")
            with open(cert_file, "w") as handle:
                handle.write(dbutils.secrets.get(MTLS_SECRET_SCOPE, MTLS_CERT_KEY))
            with open(key_file, "w") as handle:
                handle.write(dbutils.secrets.get(MTLS_SECRET_SCOPE, MTLS_KEY_KEY))
            context.load_cert_chain(certfile=cert_file, keyfile=key_file)
        finally:
            shutil.rmtree(folder, ignore_errors=True)
    return context


def probe(host, port, context):
    """(ok, detail): a TCP connection, then a TLS handshake that checks the certificate."""
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT_SECONDS) as tcp:
            with context.wrap_socket(tcp, server_hostname=host) as tls:
                return True, f"TLS {tls.version()}"
    except OSError as err:  # ssl.SSLError is a kind of OSError
        return False, short_error(err)

# COMMAND ----------

now = datetime.now(timezone.utc)
scan_id = s.scan_id or new_scan_id(now)
print(f"scan_id: {scan_id}")

rows = []
for service in SERVICES:
    if service["host"].endswith(PLACEHOLDER_SUFFIX):
        print(f"Skipped {service['name']}: replace the placeholder host in SERVICES")
        continue
    try:
        ok, detail = probe(service["host"], service["port"], client_context(service["mtls"]))
    except Exception as err:  # for example an unreadable client certificate secret
        ok, detail = False, short_error(err)
    rows.append({
        "job_name": service["name"],  # the service name, not a job name
        "check_id": "service_connectivity",
        "status": "HEALTHY" if ok else "FAILED",
        "severity": service.get("severity", "WARNING"),  # used when the status is not HEALTHY
        "owner": service.get("owner"),
        "error_summary": f"{service['host']}:{service['port']}: {'reachable' if ok else detail}",
        "source": "CUSTOM",
    })
print(f"Probed {len(rows)} service(s)")

# COMMAND ----------

from jobs_watchdog.upgrade import require_current_tables

require_current_tables(spark, s.catalog, s.schema)
jobs, dependencies = read_config(spark, s.catalog, s.schema)
# A service check belongs to the region, not to one workspace, so account_id stays empty.
complete = finalize_rows(rows, scan_id, now, s.region, None, jobs, dependencies)
written = write_findings(spark, complete, s.catalog, s.schema)
print(f"Offered {written} rows to findings (rows already there for this scan_id are skipped)")

# COMMAND ----------

# MAGIC %md
# MAGIC ## This scan's custom findings

# COMMAND ----------

from pyspark.sql import functions as F

findings = spark.table(f"{s.catalog}.{s.schema}.findings")
display(findings.where((F.col("scan_id") == scan_id) & (F.col("source") == "CUSTOM")).orderBy("job_name"))
