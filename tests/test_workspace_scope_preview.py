"""Run the app's complete preview queries against controlled local job history.

SQLGlot translates Databricks QUALIFY/regex syntax to SQLite. Only the external
system table reference is replaced. This is an offline behavior check, not a
Databricks warehouse execution or an access/permission test.
"""
from pathlib import Path
import re
import sqlite3

import pytest
import sqlglot
from sqlglot import expressions as exp

QUERIES = Path(__file__).resolve().parents[1] / "app" / "config" / "queries"
LOWER = "1111111111111111"
PRODUCTION = "2222222222222222"


def _query(filename):
    tree = sqlglot.parse_one((QUERIES / filename).read_text(), read="databricks")
    for table in tree.find_all(exp.Table):
        if (table.catalog, table.db, table.name) == ("system", "lakeflow", "jobs"):
            table.set("catalog", None)
            table.set("db", None)
            table.set("this", exp.to_identifier("preview_jobs"))
    return tree.sql(dialect="sqlite")


@pytest.fixture
def preview_db():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.create_function("regexp", 2, lambda pattern, value: bool(re.search(pattern, value)))
    connection.execute("""CREATE TABLE preview_jobs (
        workspace_id TEXT, job_id TEXT, name TEXT, change_time INT, delete_time INT
    )""")
    # More than the result limit in another workspace, with repeated job IDs
    # and names across the two workspaces. Neither may consume the scoped cap.
    rows = [(LOWER, str(i), f"orders_{i:03}", 1, None) for i in range(60)]
    rows += [(PRODUCTION, str(i), f"orders_{i:03}", 1, None) for i in range(3)]
    rows += [
        (PRODUCTION, "900", "orders_deleted", 1, None),
        (PRODUCTION, "900", "orders_deleted", 2, 2),
        (PRODUCTION, "901", "orders_renamed", 1, None),
        (PRODUCTION, "901", "unrelated_job", 2, None),
    ]
    connection.executemany("INSERT INTO preview_jobs VALUES (?, ?, ?, ?, ?)", rows)
    try:
        yield connection
    finally:
        connection.close()


def _matches(connection, workspace_id, exclude=""):
    rows = connection.execute(
        _query("pattern_matches.obo.sql"),
        {"pattern": "^orders_", "exclude": exclude, "workspace_id": workspace_id, "refresh": 0},
    )
    return [dict(row) for row in rows]


def test_scope_applies_before_the_preview_count_and_limit(preview_db):
    assert _matches(preview_db, PRODUCTION) == [
        {"workspace_id": PRODUCTION, "job_id": "0", "name": "orders_000", "match_count": 3},
        {"workspace_id": PRODUCTION, "job_id": "1", "name": "orders_001", "match_count": 3},
        {"workspace_id": PRODUCTION, "job_id": "2", "name": "orders_002", "match_count": 3},
    ]


def test_missing_workspace_does_not_fall_back_to_another_copy(preview_db):
    assert _matches(preview_db, "3333333333333333") == []


def test_empty_scope_keeps_the_regional_preview_with_an_uncapped_count(preview_db):
    rows = _matches(preview_db, "")
    assert len(rows) == 50
    assert {row["match_count"] for row in rows} == {63}
    assert {row["workspace_id"] for row in rows} == {LOWER, PRODUCTION}


def test_exclusion_still_applies_inside_the_workspace(preview_db):
    rows = _matches(preview_db, PRODUCTION, "_002$")
    assert [row["job_id"] for row in rows] == ["0", "1"]
    assert {row["match_count"] for row in rows} == {2}


def test_table_free_pattern_check_keeps_the_exact_workspace_value(preview_db):
    row = preview_db.execute(
        _query("pattern_check.obo.sql"),
        {"pattern": "^orders_", "exclude": "", "workspace_id": "9007199254740993", "refresh": 0},
    ).fetchone()
    assert dict(row) == {
        "pattern_matches_empty": 0,
        "exclude_matches_empty": 1,
        "configured_workspace_id": "9007199254740993",
        "refresh": 0,
    }
