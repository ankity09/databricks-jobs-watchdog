"""Enforce the same workspace boundary in API and SQL candidate matching."""
from dataclasses import replace
import json
import sqlite3

import pytest
import sqlglot
from sqlglot import expressions as exp

from jobs_watchdog.jobs_api import Target, collect_target, resolve_jobs, unreachable_rows
from jobs_watchdog.sqlfiles import load_sql
from tests.helpers import for_parsing
from tests.test_jobs_api import FakeClient, NOW, monitored, run


def scoped_job(workspace_id="1001", **changes):
    return replace(monitored(max_runtime=None, max_retries=None), workspace_id=workspace_id, **changes)


@pytest.mark.parametrize("workspace_id", [None, "1001"])
def test_api_resolver_keeps_every_job_from_iterator_inputs(workspace_id):
    client = FakeClient(jobs=[(7, "orders"), (8, "billing")])
    jobs = iter([scoped_job(None, job_name="billing", job_name_regex="^billing$"), scoped_job(workspace_id)])
    resolved = resolve_jobs(client, jobs)
    assert [(job.job_name, job_id) for job, job_id, _name, _tags in resolved] == [("billing", 8), ("orders", 7)]


def test_scoped_collection_reuses_the_workspace_identity_guard():
    class CountingClient(FakeClient):
        workspace_id_reads = 0

        def get_workspace_id(self):
            self.workspace_id_reads += 1
            return super().get_workspace_id()

    client = CountingClient(jobs=[(7, "orders")], runs={7: [run(11, "TERMINATED", "SUCCESS")]})
    rows = collect_target(client, Target("1001", "lower", None), [scoped_job()], NOW)
    assert rows and all(row["status"] == "HEALTHY" for row in rows)
    assert client.workspace_id_reads == 1


def test_direct_api_resolver_cannot_match_same_id_in_a_different_workspace():
    client = FakeClient(workspace_id="2002", jobs=[(7, "orders")])
    assert resolve_jobs(client, [scoped_job(job_ids=("7",))]) == []


def test_direct_api_resolver_cannot_match_same_name_in_a_different_workspace():
    client = FakeClient(workspace_id="2002", jobs=[(7, "orders")])
    assert resolve_jobs(client, [scoped_job()]) == []


def test_api_collection_checks_the_job_in_its_configured_workspace():
    client = FakeClient(workspace_id="1001", jobs=[(7, "renamed_orders")], runs={7: [run(11, "TERMINATED", "SUCCESS")]})
    rows = collect_target(client, Target("1001", "lower", None), [scoped_job(job_ids=("7",))], NOW)
    assert rows
    assert {row["job_id"] for row in rows} == {"7"}
    assert {row["workspace_id"] for row in rows} == {"1001"}
    assert all(row["status"] == "HEALTHY" for row in rows)


def test_api_collection_does_not_probe_an_unrelated_workspace():
    client = FakeClient(workspace_id="2002", list_error=RuntimeError("This workspace must not be read."))
    assert collect_target(client, Target("2002", "other", None), [scoped_job(job_ids=("7",))], NOW) == []


def test_unreachable_workspace_does_not_mark_jobs_scoped_elsewhere_unreachable():
    jobs = [scoped_job("1001"), scoped_job("2002", job_name="billing")]
    rows = unreachable_rows(Target("2002", "other", None), jobs, "cannot connect")
    assert [row["job_name"] for row in rows] == ["billing"]
    assert rows[0]["check_id"] == "api_unreachable"


def test_missing_job_in_its_workspace_remains_unknown_not_a_match_elsewhere():
    client = FakeClient(workspace_id="1001", jobs=[(8, "orders")])
    rows = collect_target(client, Target("1001", "lower", None), [scoped_job(job_ids=("7",))], NOW)
    assert len(rows) == 1
    assert rows[0]["status"] == "UNKNOWN"
    assert rows[0]["check_id"] == "not_found"
    assert rows[0]["job_id"] is None


def cte_where(path, alias):
    """Execute the real production WHERE, not a reimplementation of its scope rule."""
    tree = sqlglot.parse_one(for_parsing(load_sql(path)), read="databricks")
    cte = next(node for node in tree.find_all(exp.CTE) if node.alias_or_name == alias)
    select = next(node for node in cte.this.find_all(exp.Select) if node.args.get("where") is not None)
    return select.args["where"].this.sql(dialect="databricks")


def candidates_allowed(where, scope, matched_by, target_alias="c"):
    # SQLite executes ordinary boolean/NULL predicates. Only the two existing
    # Spark array scalar functions need equivalents for these small fixtures.
    connection = sqlite3.connect(":memory:")
    connection.create_function("SIZE", 1, lambda v: None if v is None else len(json.loads(v)))
    connection.create_function("ARRAY_CONTAINS", 2, lambda a, v: None if a is None else v in json.loads(a))
    try:
        if target_alias == "c":
            target = "c(workspace_id, matched_by, job_id) AS (VALUES ('1001', ?, '7'), ('2002', ?, '7'))"
            params = (scope, '["7"]' if matched_by == "job_id" else None, matched_by, matched_by)
        else:
            target = "e(workspace_id, environment) AS (VALUES ('1001', 'lower'), ('2002', 'other'))"
            params = (scope, '["7"]')
        sql = (
            "WITH m(workspace_id, job_ids, enabled) AS (VALUES (?, ?, 1)), "
            "o(job_ids, enabled) AS (VALUES (NULL, NULL)), " + target +
            f" SELECT {target_alias}.workspace_id FROM m CROSS JOIN o CROSS JOIN {target_alias} WHERE " + where +
            f" ORDER BY {target_alias}.workspace_id"
        )
        return [row[0] for row in connection.execute(sql, params)]
    finally:
        connection.close()


@pytest.mark.parametrize("path,alias", [
    ("sql/scan/20_resolve_monitored_jobs.sql", "matches"),
    ("sql/scan/21_system_table_findings.sql", "all_matched"),
])
@pytest.mark.parametrize("matched_by", ["job_id", "name"])
@pytest.mark.parametrize("scope,expected", [
    (None, ["1001", "2002"]),
    ("1001", ["1001"]),
    ("2002", ["2002"]),
    ("9999", []),
])
def test_sql_matching_predicate_enforces_workspace_for_ids_and_names(path, alias, matched_by, scope, expected):
    assert candidates_allowed(cte_where(path, alias), scope, matched_by) == expected


@pytest.mark.parametrize("scope,expected", [(None, ["1001", "2002"]), ("1001", ["1001"]), ("9999", [])])
def test_system_table_expected_ids_only_apply_in_the_scoped_workspace(scope, expected):
    where = cte_where("sql/scan/21_system_table_findings.sql", "expected_ids")
    assert candidates_allowed(where, scope, "job_id", target_alias="e") == expected
