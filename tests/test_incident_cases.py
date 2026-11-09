"""The live-test cases for the incidents view fit the fixture and cover every rule.

tests/incident_cases.py runs them on a SQL warehouse; these checks need no network.
"""

import re
from pathlib import Path

import pytest

from jobs_watchdog.findings import FINDINGS_COLUMNS
from jobs_watchdog.incidents import INCIDENT_COLUMNS, INCIDENT_STATES
from jobs_watchdog.sqlfiles import load_sql, parameters
from tests import incident_cases as cases
from tests.helpers import for_parsing


def test_the_fixture_builds_findings_rows_in_table_order():
    sqlglot = pytest.importorskip("sqlglot")
    text = load_sql(cases.FIXTURE)
    assert parameters(text) == set()
    assert tuple(sqlglot.parse_one(for_parsing(text), read="databricks").named_selects) == FINDINGS_COLUMNS


def test_expectations_use_incident_columns_and_known_states():
    for want in cases.FINAL + cases.PHASE_1:
        assert set(want) - {"case"} <= set(INCIDENT_COLUMNS), want["case"]
        assert want["state"] in INCIDENT_STATES + (None,), want["case"]
    assert [want["case"] for want in cases.FINAL] == list(cases.CASES)
    opened = [(cases._key(want), want["opened_scan_id"]) for want in cases.FINAL]
    assert len(opened) == len(set(opened))


def test_every_scan_in_the_expectations_is_in_the_fixture():
    text = load_sql(cases.FIXTURE)
    for scan_id, time in cases.SCAN_TIMES.items():
        assert f"('{time}', '{scan_id}'," in text, scan_id


def _final(case):
    return next(want for want in cases.FINAL if want["case"] == case)


def test_the_cases_cover_every_rule():
    final = {want["case"]: want for want in cases.FINAL}
    # a new problem, and one open across three scans
    assert final["A"]["is_new"] and final["A"]["scans_seen"] == 1
    assert final["B"]["state"] == "OPEN" and final["B"]["scans_seen"] == 3
    # FAILED, then WARNING, then FAILED is one incident, worst FAILED
    assert final["C"]["scans_seen"] == 3 and final["C"]["worst_status"] == "FAILED"
    # resolved, then reopened: two incidents for one key
    assert final["D"]["state"] == "RESOLVED" and final["D"]["resolved_scan_id"] == cases.S3
    assert cases._key(final["E1"]) == cases._key(final["E2"])
    assert (final["E1"]["state"], final["E2"]["state"]) == ("RESOLVED", "OPEN")
    # UNKNOWN in between is still one incident
    assert final["F"]["scans_seen"] == 3 and final["F"]["opened_scan_id"] == cases.S1
    # absent from the newest scan, then back as the same incident
    assert final["G"]["state"] == "NOT_CHECKED"
    phase_1 = {want["case"]: want for want in cases.PHASE_1}
    assert phase_1["H"]["state"] == "NOT_CHECKED" and final["H"]["state"] == "OPEN"
    assert set(cases.SAME_INCIDENT_ACROSS_PHASES) == {"G", "H"}
    # a re-run of an old scan_id is ordered as that old scan, never the newest
    assert final["I"]["opened_scan_id"] == cases.J1 and final["I"]["resolved_scan_id"] == cases.J2
    assert cases.NEWEST_SCANS["JOBS_API"] == cases.J3
    # two job IDs under one job name are two incidents
    assert final["J1"]["job_name"] == final["J2"]["job_name"] and final["J1"]["job_id"] != final["J2"]["job_id"]
    # keys with no job ID, or no workspace either
    assert final["K"]["job_id"] is None and final["P"]["workspace_id"] is None
    # UNKNOWN in the newest scan keeps an incident open
    assert final["M"]["state"] == "OPEN" and final["M"]["current_status"] == "UNKNOWN"
    # a status that is neither HEALTHY nor a problem (a custom check's own) keeps it open, like UNKNOWN
    assert final["R"]["state"] == "OPEN" and final["R"]["current_status"] == "SKIPPED"
    # every source at once
    assert {want["source"] for want in cases.FINAL} == {"SYSTEM_TABLES", "JOBS_API", "CUSTOM"}


def test_the_fixture_is_synthetic():
    text = load_sql(cases.FIXTURE)
    hosts = set(re.findall(r"https://([^/']+)", text))
    assert hosts == {"workspace.example.com"}
    assert set(re.findall(r"'(\d{12,})'", text)) == {cases.WS}


class FakeWarehouse:
    """Answers the schema check, records every statement, and fails the first one containing fail_on."""

    def __init__(self, exists=False, fail_on=None):
        self.statements, self.exists, self.fail_on = [], exists, fail_on

    def run(self, statement, **params):
        self.statements.append(statement)
        if "information_schema.schemata" in statement:
            return [{"found": "1" if self.exists else "0"}]
        if self.fail_on and self.fail_on in statement:
            raise RuntimeError(f"statement failed: {self.fail_on}")
        return []


ARGS = ["--profile", "dev", "--warehouse-id", "abc123", "--catalog", "main", "--schema", "scratch_cases"]


def _connect(warehouse):
    return lambda profile, warehouse_id: warehouse


def test_the_runner_refuses_a_schema_that_already_exists(capsys):
    warehouse = FakeWarehouse(exists=True)
    assert cases.main(ARGS, connect=_connect(warehouse)) == 2
    assert len(warehouse.statements) == 1 and "information_schema.schemata" in warehouse.statements[0]
    assert "main.scratch_cases already exists" in capsys.readouterr().err


def test_the_runner_drops_nothing_when_it_could_not_create_the_schema():
    warehouse = FakeWarehouse(fail_on="CREATE SCHEMA")
    with pytest.raises(RuntimeError, match="CREATE SCHEMA"):
        cases.main(ARGS, connect=_connect(warehouse))
    assert not any(word in statement for statement in warehouse.statements for word in ("DROP", "DELETE"))
    # created without IF NOT EXISTS, so a schema made in the meantime also stops it
    assert warehouse.statements[1] == "CREATE SCHEMA `main`.`scratch_cases`"


def test_the_runner_drops_the_schema_it_created_even_when_a_step_fails():
    warehouse = FakeWarehouse(fail_on="INSERT INTO")
    with pytest.raises(RuntimeError, match="INSERT INTO"):
        cases.main(ARGS, connect=_connect(warehouse))
    assert warehouse.statements[-1] == "DROP SCHEMA `main`.`scratch_cases` CASCADE"


def test_the_runner_keeps_the_schema_with_keep_and_never_deletes_rows():
    warehouse = FakeWarehouse(fail_on="INSERT INTO")
    with pytest.raises(RuntimeError):
        cases.main(ARGS + ["--keep"], connect=_connect(warehouse))
    assert not any("DROP" in statement for statement in warehouse.statements)
    source = Path(cases.__file__).read_text()
    assert "DELETE FROM" not in source
    assert "refuses to run when the schema already exists" in cases.__doc__

