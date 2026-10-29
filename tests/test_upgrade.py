import pytest

from jobs_watchdog.findings import FINDINGS_COLUMNS, FINDINGS_SCHEMA
from jobs_watchdog.upgrade import (
    TABLES,
    VIEW_TEMPLATES,
    Column,
    add_columns_statement,
    create_views,
    ddl_columns,
    missing_columns,
    render_view,
    upgrade_tables,
)
from jobs_watchdog.sqlfiles import parameters
from tests.helpers import for_parsing

NEW_FINDINGS_COLUMNS = ("environment", "schedule_type", "run_start_time", "run_end_time", "run_duration_seconds",
                        "trigger_type", "triggered_by", "job_tags", "code_version", "pipeline_url")


def test_findings_ddl_matches_the_python_schema():
    assert tuple((c.name, c.data_type) for c in ddl_columns("sql/setup/04_create_findings.sql")) == FINDINGS_SCHEMA


def test_new_findings_columns_come_last_so_upgraded_tables_match_new_ones():
    assert FINDINGS_COLUMNS[-len(NEW_FINDINGS_COLUMNS):] == NEW_FINDINGS_COLUMNS
    assert dict(FINDINGS_SCHEMA)["job_tags"] == "MAP<STRING,STRING>"


def test_every_table_ddl_parses_with_comments():
    for table, relpath in TABLES:
        columns = ddl_columns(relpath)
        assert columns, table
        assert all(c.comment is not None or c.name == "notes" for c in columns), table


def test_ddl_columns_keep_not_null_and_comments():
    column = ddl_columns("sql/setup/04_create_findings.sql")[0]
    assert column == Column("observed_at", "TIMESTAMP", True, "When the scan ran")


def test_missing_columns_are_reported_in_ddl_order():
    columns = ddl_columns("sql/setup/04_create_findings.sql")
    existing = [name.upper() for name in FINDINGS_COLUMNS[:19]]
    assert [c.name for c in missing_columns(existing, columns)] == list(NEW_FINDINGS_COLUMNS)


def test_add_columns_statement_drops_not_null_and_keeps_comments():
    statement = add_columns_statement("findings", [Column("environment", "STRING", True, "Environment label"),
                                                   Column("job_tags", "MAP<STRING,STRING>", False, None)])
    assert statement == (
        "ALTER TABLE IDENTIFIER(:catalog || '.' || :schema || '.findings') ADD COLUMNS "
        "(environment STRING COMMENT 'Environment label', job_tags MAP<STRING,STRING>)"
    )
    assert parameters(statement) == {"catalog", "schema"}


class Frame:
    def __init__(self, columns):
        self.columns = columns


class Rows:
    def __init__(self, rows):
        self.rows = rows

    def collect(self):
        return self.rows


class FakeSpark:
    def __init__(self, tables, view_versions=None):
        self.tables, self.calls = tables, []
        self.view_versions = view_versions or {}

    def table(self, name):
        return Frame(self.tables[name])

    def sql(self, text, args=None):
        if text.startswith("SHOW TBLPROPERTIES"):
            # like Databricks: asking for one key returns only a value column, and a
            # missing property comes back as a message in that column
            name = text.split()[2].replace("`", "")
            version = self.view_versions.get(name)
            if version is None:
                return Rows([{"value": f"Table {name} does not have property: watchdog.view_version"}])
            return Rows([{"value": version}])
        self.calls.append((text, args))


def test_upgrade_adds_only_what_is_missing():
    old_findings = list(FINDINGS_COLUMNS[:19])
    complete = {f"main.watchdog.{table}": [c.name for c in ddl_columns(path)] for table, path in TABLES}
    spark = FakeSpark(dict(complete, **{"main.watchdog.findings": old_findings}))
    added = upgrade_tables(spark, "main", "watchdog")
    assert added == {"findings": list(NEW_FINDINGS_COLUMNS)}
    assert len(spark.calls) == 1
    text, args = spark.calls[0]
    assert text.startswith("ALTER TABLE IDENTIFIER(:catalog || '.' || :schema || '.findings') ADD COLUMNS (environment")
    assert args == {"catalog": "main", "schema": "watchdog"}


def test_upgrade_checks_names_before_any_sql():
    spark = FakeSpark({})
    with pytest.raises(ValueError, match="schema"):
        upgrade_tables(spark, "main", "bad-schema")
    assert spark.calls == []


def test_view_templates_have_no_parameter_markers_and_parse_once_rendered():
    sqlglot = pytest.importorskip("sqlglot")
    assert VIEW_TEMPLATES
    for relpath in VIEW_TEMPLATES:
        rendered = render_view(relpath, "main", "watchdog")
        assert "{schema}" not in rendered and not parameters(rendered)
        assert "`main`.`watchdog`.findings" in rendered
        sqlglot.parse_one(for_parsing(rendered), read="databricks")


def test_render_view_rejects_bad_names():
    with pytest.raises(ValueError, match="catalog"):
        render_view(VIEW_TEMPLATES[0], "main;drop", "watchdog")


def test_missing_views_are_created():
    spark = FakeSpark({"main.watchdog.findings": list(FINDINGS_COLUMNS)})
    assert create_views(spark, "main", "watchdog") == [("findings_latest", "created")]
    assert spark.calls[0][0].lstrip().startswith("--") and "CREATE OR REPLACE VIEW `main`.`watchdog`.findings_latest" in spark.calls[0][0]
    assert spark.calls[0][1] is None


def test_current_views_are_left_alone_so_owners_and_grants_stay():
    from jobs_watchdog.upgrade import view_version

    spark = FakeSpark({"main.watchdog.findings": list(FINDINGS_COLUMNS),
                       "main.watchdog.findings_latest": [c.upper() for c in FINDINGS_COLUMNS]},
                      {"main.watchdog.findings_latest": view_version(VIEW_TEMPLATES[0])})
    assert create_views(spark, "main", "watchdog") == [("findings_latest", "current")]
    assert spark.calls == []


def test_a_view_with_an_older_definition_is_replaced_even_when_columns_match():
    spark = FakeSpark({"main.watchdog.findings": list(FINDINGS_COLUMNS),
                       "main.watchdog.findings_latest": list(FINDINGS_COLUMNS)},
                      {"main.watchdog.findings_latest": "1"})
    assert create_views(spark, "main", "watchdog") == [("findings_latest", "replaced")]
    no_version = FakeSpark({"main.watchdog.findings": list(FINDINGS_COLUMNS),
                            "main.watchdog.findings_latest": list(FINDINGS_COLUMNS)})
    assert create_views(no_version, "main", "watchdog") == [("findings_latest", "replaced")]


def test_every_view_template_declares_its_version():
    from jobs_watchdog.upgrade import view_version

    for relpath in VIEW_TEMPLATES:
        assert view_version(relpath).isdigit(), relpath


def test_views_with_old_columns_are_replaced():
    spark = FakeSpark({"main.watchdog.findings": list(FINDINGS_COLUMNS),
                       "main.watchdog.findings_latest": list(FINDINGS_COLUMNS[:19])})
    assert create_views(spark, "main", "watchdog") == [("findings_latest", "replaced")]
    assert len(spark.calls) == 1


def test_require_current_tables_passes_when_nothing_is_missing():
    from jobs_watchdog.upgrade import require_current_tables

    complete = {f"main.watchdog.{table}": [c.name for c in ddl_columns(path)] for table, path in TABLES}
    complete["main.watchdog.findings_latest"] = list(FINDINGS_COLUMNS)
    from jobs_watchdog.upgrade import view_version

    require_current_tables(FakeSpark(complete, {"main.watchdog.findings_latest": view_version(VIEW_TEMPLATES[0])}),
                           "main", "watchdog")


def test_require_current_tables_says_to_run_notebook_01():
    from jobs_watchdog.upgrade import require_current_tables

    complete = {f"main.watchdog.{table}": [c.name for c in ddl_columns(path)] for table, path in TABLES}
    stale = dict(complete, **{"main.watchdog.findings": list(FINDINGS_COLUMNS[:19])})
    with pytest.raises(RuntimeError, match="findings.*notebook 01"):
        require_current_tables(FakeSpark(stale), "main", "watchdog")


def test_require_current_tables_names_a_missing_table():
    from jobs_watchdog.upgrade import require_current_tables

    class NoTables(FakeSpark):
        def table(self, name):
            raise Exception(f"[TABLE_OR_VIEW_NOT_FOUND] {name}")

    with pytest.raises(RuntimeError, match="monitored_jobs.*notebook 01"):
        require_current_tables(NoTables({}), "main", "watchdog")


def test_require_current_tables_also_checks_the_view():
    from jobs_watchdog.upgrade import require_current_tables

    complete = {f"main.watchdog.{table}": [c.name for c in ddl_columns(path)] for table, path in TABLES}
    stale_view = dict(complete, **{"main.watchdog.findings_latest": list(FINDINGS_COLUMNS[:19])})
    with pytest.raises(RuntimeError, match="findings_latest.*notebook 01"):
        require_current_tables(FakeSpark(stale_view), "main", "watchdog")
    from jobs_watchdog.upgrade import view_version

    current = dict(complete, **{"main.watchdog.findings_latest": list(FINDINGS_COLUMNS)})
    versions = {"main.watchdog.findings_latest": view_version(VIEW_TEMPLATES[0])}
    require_current_tables(FakeSpark(current, versions), "main", "watchdog")
    with pytest.raises(RuntimeError, match="findings_latest.*notebook 01"):
        require_current_tables(FakeSpark(current, {"main.watchdog.findings_latest": "1"}), "main", "watchdog")


def test_watchdog_objects_lists_every_table_and_view():
    from jobs_watchdog.upgrade import watchdog_objects

    assert watchdog_objects() == ("monitored_jobs", "job_dependencies", "findings", "monitored_workspaces",
                                  "monitored_job_environments", "findings_latest")
