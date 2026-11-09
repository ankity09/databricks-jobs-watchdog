"""The incidents the view must return for tests/fixtures/incident_cases.sql, and a live check.

pytest checks that these expectations fit the fixture (tests/test_incident_cases.py).
Run this file to check the view itself on a SQL warehouse, in a scratch schema
that it creates and then drops:

    python3 tests/incident_cases.py --profile <profile> --warehouse-id <id> \\
        --catalog <catalog> --schema <scratch schema>

It creates findings and both views there, inserts the fixture rows in two
phases (before and after 02:30), checks every incident after each phase,
checks the scan summary counts and the notebook 07 check (sql/validate/43),
and prints a table of expected against actual. --keep leaves the schema.
It needs the Databricks CLI, signed in to that profile.
"""

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from jobs_watchdog.findings import FINDINGS_COLUMNS  # noqa: E402
from jobs_watchdog.identifiers import validate_identifier  # noqa: E402
from jobs_watchdog.incidents import INCIDENT_COLUMNS  # noqa: E402
from jobs_watchdog.sqlfiles import load_sql  # noqa: E402
from jobs_watchdog.upgrade import render_view  # noqa: E402

FIXTURE = "tests/fixtures/incident_cases.sql"
PHASE_SPLIT = "2026-11-01 02:30:00"  # phase 1 inserts the rows observed before this, phase 2 the rest

S1, S2, S3, S4 = "20261101T000000Z", "20261101T010000Z", "20261101T020000Z", "20261101T030000Z"
J1, J2, J3 = "20261101T000500Z", "20261101T010500Z", "20261101T020500Z"
C1, C2, C3 = "20261101T001000Z", "20261101T011000Z", "20261101T021000Z"
SCAN_TIMES = {
    S1: "2026-11-01 00:00:00", S2: "2026-11-01 01:00:00", S3: "2026-11-01 02:00:00", S4: "2026-11-01 03:00:00",
    J1: "2026-11-01 00:05:00", J2: "2026-11-01 01:05:00", J3: "2026-11-01 02:05:00",
    C1: "2026-11-01 00:10:00", C2: "2026-11-01 01:10:00", C3: "2026-11-01 02:10:00",
}
WS = "1111111111111111"
KEY = ("source", "workspace_id", "job_id", "job_name", "check_id")
CASES = ("A", "B", "C", "C2", "C3", "D", "E1", "E2", "F", "G", "H", "K", "M", "O", "L", "J1", "J2", "I", "P", "Q")


def incident(case, source, job_name, job_id, check_id, state, opened, last, scans, worst, current,
             resolved=None, is_new=False, workspace_id=WS, **columns):
    """One expected incident. columns holds any other column to check, such as error_summary."""
    return dict(case=case, source=source, workspace_id=workspace_id, job_id=job_id, job_name=job_name,
                check_id=check_id, state=state, opened_scan_id=opened, last_seen_scan_id=last, scans_seen=scans,
                worst_status=worst, current_status=current, resolved_scan_id=resolved, is_new=is_new, **columns)


ST, API, CUSTOM = "SYSTEM_TABLES", "JOBS_API", "CUSTOM"
LRR = "last_run_result"

# Every incident after both phases, and nothing else.
FINAL = [
    incident("A", ST, "orders_ingest", "101", LRR, "OPEN", S4, S4, 1, "FAILED", "FAILED", is_new=True,
             error_summary="A s4 failed", affected_jobs=["orders_enrich"], severity="CRITICAL",
             owner="ingestion-team", workspace_name="analytics", environment="production",
             schedule_type="scheduled", failure_category="FUNCTIONAL",
             run_page_url=f"https://workspace.example.com/jobs/101/runs/{S4}"),
    incident("B", ST, "orders_enrich", "102", "task_failures", "OPEN", S2, S4, 3, "FAILED", "FAILED",
             error_summary="B s4 failed"),
    incident("C", ST, "daily_revenue_report", "103", LRR, "OPEN", S2, S4, 3, "FAILED", "FAILED",
             error_summary="C s4 failed", affected_jobs=["daily_revenue_export"], severity="CRITICAL"),
    incident("C2", ST, "daily_revenue_export", "104", "long_runtime", "OPEN", S3, S4, 2, "WARNING", "WARNING",
             severity="WARNING"),
    incident("C3", ST, "customer_sync", "105", LRR, "OPEN", S3, S4, 2, "FAILED", "WARNING",
             error_summary="C3 s4 cancelled", affected_jobs=None, owner="crm-oncall", severity="WARNING"),
    incident("D", ST, "inventory_load", "106", LRR, "RESOLVED", S1, S2, 2, "FAILED", "HEALTHY", resolved=S3,
             error_summary="D s2 failed"),
    incident("E1", ST, "payments_export", "107", LRR, "RESOLVED", S1, S1, 1, "FAILED", "FAILED", resolved=S2,
             error_summary="E s1 failed"),
    incident("E2", ST, "payments_export", "107", LRR, "OPEN", S3, S4, 2, "FAILED", "FAILED",
             error_summary="E s4 failed"),
    incident("F", ST, "clickstream_load", "108", LRR, "OPEN", S1, S4, 3, "FAILED", "FAILED"),
    incident("G", ST, "ledger_close", "109", LRR, "NOT_CHECKED", S2, S3, 2, "FAILED", "FAILED",
             error_summary="G s3 failed"),
    incident("H", ST, "ledger_post", "110", LRR, "OPEN", S1, S4, 2, "FAILED", "FAILED"),
    incident("K", ST, "audit_export", None, "duplicate_name", "OPEN", S2, S4, 3, "WARNING", "WARNING",
             run_page_url=None),
    incident("M", ST, "fx_rates_load", "114", LRR, "OPEN", S2, S2, 1, "FAILED", "UNKNOWN",
             error_summary="M s2 failed"),
    incident("O", ST, "shipping_load", "115", LRR, "RESOLVED", S3, S3, 1, "FAILED", "HEALTHY", resolved=S4),
    incident("L", API, "orders_ingest", "101", "live_run_status", "OPEN", J2, J3, 2, "FAILED", "FAILED"),
    incident("J1", API, "orders_api", "112", "live_run_status", "OPEN", J2, J3, 2, "FAILED", "FAILED"),
    incident("J2", API, "orders_api", "113", "live_run_status", "OPEN", J3, J3, 1, "FAILED", "FAILED", is_new=True),
    incident("I", API, "refund_api", "117", "live_run_status", "RESOLVED", J1, J1, 1, "FAILED", "HEALTHY",
             resolved=J2, error_summary="I j1 re-run failed"),
    incident("P", CUSTOM, "kafka", None, "service_connectivity", "RESOLVED", C1, C2, 2, "FAILED", "HEALTHY",
             resolved=C3, workspace_id=None, workspace_name=None, environment=None, schedule_type=None,
             affected_jobs=["orders_ingest"]),
    incident("Q", CUSTOM, "schema_registry", None, "service_connectivity", "OPEN", C2, C3, 2, "WARNING", "WARNING",
             workspace_id=None),
]

# After phase 1 only (s4 and the re-run of j1 not written yet), for the cases that change.
PHASE_1 = [
    incident("A", ST, "orders_ingest", "101", LRR, None, None, None, 0, None, None),  # no incident yet
    incident("G", ST, "ledger_close", "109", LRR, "OPEN", S2, S3, 2, "FAILED", "FAILED"),
    incident("H", ST, "ledger_post", "110", LRR, "NOT_CHECKED", S1, S1, 1, "FAILED", "FAILED"),
    incident("I", API, "refund_api", "117", "live_run_status", None, None, None, 0, None, None),  # no incident yet
    incident("O", ST, "shipping_load", "115", LRR, "OPEN", S3, S3, 1, "FAILED", "FAILED", is_new=True),
]
SAME_INCIDENT_ACROSS_PHASES = ("G", "H")

# What notebooks 05 and 06 would print after the newest scans (sql/scan/31_scan_summary.sql).
SUMMARIES = [
    dict(source=ST, scan_id=S4, rows_written=14, new_problems=1, still_open=9, resolved=1),
    dict(source=API, scan_id=J3, rows_written=4, new_problems=1, still_open=2, resolved=0),
    dict(source=CUSTOM, scan_id=C3, rows_written=2, new_problems=0, still_open=1, resolved=1),
]
NEWEST_SCANS = {ST: S4, API: J3, CUSTOM: C3}  # what findings_latest must show


class Warehouse:
    """Runs one statement at a time through the SQL Statement Execution API, with the Databricks CLI."""

    def __init__(self, profile, warehouse_id):
        self.profile, self.warehouse_id = profile, warehouse_id

    def _api(self, method, path, body=None):
        command = ["databricks", "api", method, path, "-p", self.profile]
        if body is not None:
            command += ["--json", json.dumps(body)]
        out = subprocess.run(command, capture_output=True, text=True)
        if out.returncode:
            raise RuntimeError(out.stderr.strip()[:800])
        return json.loads(out.stdout)

    def run(self, statement, **params):
        body = {"warehouse_id": self.warehouse_id, "statement": statement, "wait_timeout": "50s",
                "format": "JSON_ARRAY", "disposition": "INLINE",
                "parameters": [{"name": name, "value": str(value)} for name, value in params.items()]}
        result = self._api("post", "/api/2.0/sql/statements", body)
        while result["status"]["state"] in ("PENDING", "RUNNING"):
            time.sleep(2)
            result = self._api("get", f"/api/2.0/sql/statements/{result['statement_id']}")
        if result["status"]["state"] != "SUCCEEDED":
            raise RuntimeError(json.dumps(result["status"])[:800])
        columns = [c["name"] for c in result.get("manifest", {}).get("schema", {}).get("columns", [])]
        return [dict(zip(columns, row)) for row in (result.get("result", {}).get("data_array") or [])]


def _value(row, column):
    """A column value from the statement API (every value arrives as text) as a Python value."""
    value = row.get(column)
    if value is None:
        return None
    if column == "scans_seen":
        return int(value)
    if column == "is_new":
        return value == "true"
    if column == "affected_jobs":
        return json.loads(value)
    if column.endswith("_at"):
        return value.replace("T", " ")[:19]
    return value


def _key(row):
    return tuple(row.get(column) for column in KEY)


def compare(expected, actual, phase):
    """(case, column, expected, actual) for every difference, plus incidents nobody expected."""
    problems = []
    by_key = {}
    for row in actual:
        by_key.setdefault(_key(row), []).append(row)
    matched = set()
    for want in expected:
        rows = by_key.get(_key(want), [])
        if want["state"] is None:  # no incident expected for this key
            if rows:
                problems.append((want["case"], "incident", "none", f"{len(rows)} rows"))
            continue
        found = [row for row in rows if row["opened_scan_id"] == want["opened_scan_id"]]
        if len(found) != 1:
            problems.append((want["case"], "incident", f"one opened in {want['opened_scan_id']}", f"{len(found)}"))
            continue
        got = found[0]
        matched.add(id(got))
        times = {"opened_at": SCAN_TIMES[want["opened_scan_id"]],
                 "last_seen_at": SCAN_TIMES[want["last_seen_scan_id"]],
                 "resolved_at": SCAN_TIMES.get(want["resolved_scan_id"])}
        for column, value in list(want.items()) + list(times.items()):
            if column in KEY or column == "case":
                continue
            if _value(got, column) != value:
                problems.append((want["case"], column, value, _value(got, column)))
        if len(got["incident_id"] or "") != 64:
            problems.append((want["case"], "incident_id", "64 hex characters", got["incident_id"]))
    if phase == "final":
        for row in actual:
            if id(row) not in matched:
                problems.append(("?", "unexpected incident", None, {c: row[c] for c in KEY + ("opened_scan_id",)}))
    return problems


def _table(expected, actual):
    """Expected against actual, one line per expected incident, for the report."""
    lines = ["| case | key | state | opened | last seen | scans | worst | current | resolved | new | match |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    by_key = {}
    for row in actual:
        by_key.setdefault((_key(row), row["opened_scan_id"]), row)
    for want in expected:
        got = by_key.get((_key(want), want["opened_scan_id"]), {})
        cells = []
        ok = True
        for column in ("state", "opened_scan_id", "last_seen_scan_id", "scans_seen", "worst_status",
                       "current_status", "resolved_scan_id", "is_new"):
            have = _value(got, column) if got else None
            ok = ok and have == want[column]
            cells.append(f"{want[column]}" if have == want[column] else f"{want[column]} / got {have}")
        key = f"{want['source']} {want['job_name']} {want['job_id'] or 'no job ID'} {want['check_id']}"
        lines.append(f"| {want['case']} | {key} | " + " | ".join(cells) + f" | {'yes' if ok else 'NO'} |")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--profile", required=True)
    parser.add_argument("--warehouse-id", required=True)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--schema", required=True, help="a scratch schema; it is created, then dropped")
    parser.add_argument("--keep", action="store_true", help="leave the scratch schema in place")
    args = parser.parse_args(argv)
    validate_identifier(args.catalog, "catalog")
    validate_identifier(args.schema, "schema")
    sql = Warehouse(args.profile, args.warehouse_id)
    names = dict(catalog=args.catalog, schema=args.schema)
    prefix = f"`{args.catalog}`.`{args.schema}`"

    sql.run(load_sql("sql/setup/01_create_schema.sql"), **names)
    sql.run(load_sql("sql/setup/04_create_findings.sql"), **names)
    sql.run(f"DELETE FROM {prefix}.findings")
    for view in ("sql/views/01_findings_latest.sql", "sql/views/02_incidents.sql"):
        sql.run(render_view(view, args.catalog, args.schema))
    columns = ", ".join(FINDINGS_COLUMNS)
    cases = load_sql(FIXTURE)
    select = f"SELECT {', '.join(INCIDENT_COLUMNS)} FROM {prefix}.incidents"
    failures = []

    sql.run(f"INSERT INTO {prefix}.findings ({columns}) SELECT {columns} FROM ({cases}) "
            f"WHERE observed_at < TIMESTAMP '{PHASE_SPLIT}'")
    first = sql.run(select)
    failures += [("phase 1",) + problem for problem in compare(PHASE_1, first, "phase 1")]
    print("Phase 1 (before s4 and the re-run of j1):")
    print(_table([want for want in PHASE_1 if want["state"]], first))

    sql.run(f"INSERT INTO {prefix}.findings ({columns}) SELECT {columns} FROM ({cases}) "
            f"WHERE observed_at >= TIMESTAMP '{PHASE_SPLIT}'")
    final = sql.run(select)
    failures += [("final",) + problem for problem in compare(FINAL, final, "final")]
    print(f"\nFinal ({len(final)} incidents):")
    print(_table(FINAL, final))

    ids = {}
    for phase, rows in (("phase 1", first), ("final", final)):
        for want in (PHASE_1 if phase == "phase 1" else FINAL):
            if want["case"] in SAME_INCIDENT_ACROSS_PHASES:
                row = next((r for r in rows if _key(r) == _key(want)), {})
                ids.setdefault(want["case"], set()).add(row.get("incident_id"))
    for case, seen in ids.items():
        print(f"case {case}: incident_id {'the same in both phases' if len(seen) == 1 else 'CHANGED'}")
        if len(seen) != 1:
            failures.append(("final", case, "incident_id", "the same in both phases", seen))

    newest = {row["source"]: row["scan_id"] for row in sql.run(
        f"SELECT DISTINCT source, scan_id FROM {prefix}.findings_latest")}
    print(f"\nfindings_latest newest scans: {newest}")
    if newest != NEWEST_SCANS:
        failures.append(("final", "findings_latest", "newest scans", NEWEST_SCANS, newest))

    print("\nScan summaries:")
    for want in SUMMARIES:
        rows = sql.run(load_sql("sql/scan/31_scan_summary.sql"), scan_id=want["scan_id"], **names)
        got = next((row for row in rows if row["source"] == want["source"]), {})
        got = {column: int(got.get(column) or 0) for column in ("rows_written", "new_problems", "still_open", "resolved")}
        wanted = {column: want[column] for column in got}
        print(f"  {want['source']} {want['scan_id']}: expected {wanted}, got {got}")
        if got != wanted:
            failures.append(("final", "summary", want["source"], wanted, got))

    gaps = sql.run(load_sql("sql/validate/43_open_incidents_match_latest.sql"), **names)
    print(f"\nsql/validate/43 rows (expect none): {gaps}")
    if gaps:
        failures.append(("final", "validate 43", "no rows", None, gaps))
    # the same check, with one OPEN incident dropped and one made up, must name both
    forced_open = ", ".join("'OPEN' AS state" if column == "state" else column for column in INCIDENT_COLUMNS)
    broken = load_sql("sql/validate/43_open_incidents_match_latest.sql").replace(
        "IDENTIFIER(:catalog || '.' || :schema || '.incidents')",
        f"(SELECT * FROM {prefix}.incidents WHERE job_name <> 'orders_enrich' UNION ALL "
        f"SELECT {forced_open} FROM {prefix}.incidents WHERE job_name = 'ledger_close')")
    caught = sql.run(broken, **names)
    print(f"sql/validate/43 on a broken view (expect orders_enrich and ledger_close): "
          f"{[(row['job_name'], row['problem']) for row in caught]}")
    if sorted(row["job_name"] for row in caught) != ["ledger_close", "orders_enrich"]:
        failures.append(("final", "validate 43 on a broken view", "orders_enrich, ledger_close", None, caught))

    if not args.keep:
        sql.run(f"DROP SCHEMA IF EXISTS {prefix} CASCADE")
        print(f"\nDropped {args.catalog}.{args.schema}")
    print(f"\n{len(failures)} differences")
    for failure in failures:
        print("  ", failure)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
