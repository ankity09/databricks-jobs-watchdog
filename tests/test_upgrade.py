import pytest

from jobs_watchdog.findings import FINDINGS_COLUMNS, FINDINGS_SCHEMA
from jobs_watchdog.incidents import INCIDENT_COLUMNS
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
    view_names,
)
from jobs_watchdog.sqlfiles import parameters
from tests.helpers import for_parsing

NEW_FINDINGS_COLUMNS = ("environment", "schedule_type", "run_start_time", "run_end_time", "run_duration_seconds",
                        "trigger_type", "triggered_by", "job_tags", "code_version", "pipeline_url", "parent_job")


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


class FakeCatalog:
    def __init__(self, spark):
        self.spark = spark

    def tableExists(self, name):
        return name in self.spark.tables or name in self.spark.unreadable


class FakeSpark:
    """tables: {name: columns}. not_views: names that exist but are tables. unreadable: names that
    exist but cannot be read. SHOW statements are answered; every other statement is recorded."""

    def __init__(self, tables, view_versions=None, not_views=(), unreadable=()):
        self.tables, self.calls = tables, []
        self.view_versions = view_versions or {}
        self.not_views, self.unreadable = set(not_views), set(unreadable)
        self.catalog = FakeCatalog(self)

    def table(self, name):
        if name in self.unreadable:
            raise Exception(f"[INSUFFICIENT_PERMISSIONS] {name}")
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
        if text.startswith("SHOW VIEWS"):
            # SHOW VIEWS IN `main`.`watchdog` LIKE 'incidents': a row only when that name is a view
            schema = text.split()[3].replace("`", "")
            name = text.split("LIKE")[1].strip().strip("'")
            full = f"{schema}.{name}"
            if self.catalog.tableExists(full) and full not in self.not_views:
                return Rows([{"namespace": schema, "viewName": name, "isTemporary": False, "isMaterialized": False}])
            return Rows([])
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


def current_views(**changes):
    """Tables and view versions for a schema where both views are current, with changes applied."""
    from jobs_watchdog.upgrade import view_version

    tables = {"main.watchdog.findings": list(FINDINGS_COLUMNS),
              "main.watchdog.findings_latest": list(FINDINGS_COLUMNS),
              "main.watchdog.incidents": list(INCIDENT_COLUMNS)}
    versions = {f"main.watchdog.{name}": view_version(relpath) for relpath, name in zip(VIEW_TEMPLATES, view_names())}
    for name, columns in changes.items():
        if columns is None:
            del tables[f"main.watchdog.{name}"]
        else:
            tables[f"main.watchdog.{name}"] = columns
    return tables, versions


def test_missing_views_are_created():
    spark = FakeSpark({"main.watchdog.findings": list(FINDINGS_COLUMNS)})
    assert create_views(spark, "main", "watchdog") == [("findings_latest", "created"), ("incidents", "created")]
    assert spark.calls[0][0].lstrip().startswith("--") and "CREATE OR REPLACE VIEW `main`.`watchdog`.findings_latest" in spark.calls[0][0]
    assert "CREATE OR REPLACE VIEW `main`.`watchdog`.incidents" in spark.calls[1][0]
    assert spark.calls[0][1] is None and spark.calls[1][1] is None


def test_current_views_are_left_alone_so_owners_and_grants_stay():
    tables, versions = current_views(findings_latest=[c.upper() for c in FINDINGS_COLUMNS])
    spark = FakeSpark(tables, versions)
    assert create_views(spark, "main", "watchdog") == [("findings_latest", "current"), ("incidents", "current")]
    assert spark.calls == []


def test_a_view_with_an_older_definition_is_replaced_even_when_columns_match():
    tables, versions = current_views()
    spark = FakeSpark(tables, dict(versions, **{"main.watchdog.findings_latest": "1"}))
    assert create_views(spark, "main", "watchdog") == [("findings_latest", "replaced"), ("incidents", "current")]
    # a findings_latest with no watchdog.view_version is not one notebook 01 made (every release
    # since the view exists sets it), so it is left alone; see the tests below
    no_version = FakeSpark(tables, {"main.watchdog.incidents": versions["main.watchdog.incidents"]})
    with pytest.raises(RuntimeError, match="findings_latest is not a Watchdog view"):
        create_views(no_version, "main", "watchdog")
    assert no_version.calls == []


def test_notebook_01_never_replaces_a_table_of_yours_named_like_a_watchdog_view():
    tables, versions = current_views(incidents=["ticket_id", "summary"])
    spark = FakeSpark(tables, versions, not_views={"main.watchdog.incidents"})
    with pytest.raises(RuntimeError) as raised:
        create_views(spark, "main", "watchdog")
    assert str(raised.value) == (
        "main.watchdog.incidents is not a Watchdog view: it is a table, or a view without the table property "
        "watchdog.view_version. Notebook 01 does not replace it. Rename or move it, then run notebook 01 again.")
    assert spark.calls == []


def test_notebook_01_never_replaces_a_view_of_yours_without_the_watchdog_property():
    tables, versions = current_views(incidents=["ticket_id", "summary"])
    spark = FakeSpark(tables, {name: v for name, v in versions.items() if not name.endswith(".incidents")})
    with pytest.raises(RuntimeError, match=r"main\.watchdog\.incidents is not a Watchdog view"):
        create_views(spark, "main", "watchdog")
    assert spark.calls == []


def test_findings_latest_gets_the_same_check_before_it_is_replaced():
    tables, versions = current_views(findings_latest=list(FINDINGS_COLUMNS[:19]))
    spark = FakeSpark(tables, versions, not_views={"main.watchdog.findings_latest"})
    with pytest.raises(RuntimeError, match=r"main\.watchdog\.findings_latest is not a Watchdog view"):
        create_views(spark, "main", "watchdog")
    assert spark.calls == []


def test_a_watchdog_view_that_cannot_be_read_is_checked_and_then_replaced():
    tables, versions = current_views()
    del tables["main.watchdog.incidents"]
    spark = FakeSpark(tables, versions, unreadable={"main.watchdog.incidents"})
    assert create_views(spark, "main", "watchdog") == [("findings_latest", "current"), ("incidents", "replaced")]
    assert "CREATE OR REPLACE VIEW `main`.`watchdog`.incidents" in spark.calls[0][0]


def test_the_incidents_view_has_its_own_columns_not_the_findings_columns():
    tables, versions = current_views(incidents=list(FINDINGS_COLUMNS))
    spark = FakeSpark(tables, versions)
    assert create_views(spark, "main", "watchdog") == [("findings_latest", "current"), ("incidents", "replaced")]
    assert "CREATE OR REPLACE VIEW `main`.`watchdog`.incidents" in spark.calls[0][0]
    # new findings columns do not make the incidents view out of date
    tables, versions = current_views()
    spark = FakeSpark(dict(tables, **{"main.watchdog.findings": list(FINDINGS_COLUMNS) + ["later_column"],
                                      "main.watchdog.findings_latest": list(FINDINGS_COLUMNS) + ["later_column"]}),
                      versions)
    assert create_views(spark, "main", "watchdog") == [("findings_latest", "current"), ("incidents", "current")]


def test_every_view_template_declares_its_version():
    from jobs_watchdog.upgrade import view_version

    for relpath in VIEW_TEMPLATES:
        assert view_version(relpath).isdigit(), relpath


def test_views_with_old_columns_are_replaced():
    tables, versions = current_views(findings_latest=list(FINDINGS_COLUMNS[:19]))
    spark = FakeSpark(tables, versions)
    assert create_views(spark, "main", "watchdog") == [("findings_latest", "replaced"), ("incidents", "current")]
    assert len(spark.calls) == 1


def complete_schema():
    """Every table with its current columns, and both views current."""
    tables, versions = current_views()
    tables.update({f"main.watchdog.{table}": [c.name for c in ddl_columns(path)] for table, path in TABLES})
    return tables, versions


def test_require_current_tables_passes_when_nothing_is_missing():
    from jobs_watchdog.upgrade import require_current_tables

    require_current_tables(FakeSpark(*complete_schema()), "main", "watchdog")


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

    complete, versions = complete_schema()
    stale_view = dict(complete, **{"main.watchdog.findings_latest": list(FINDINGS_COLUMNS[:19])})
    with pytest.raises(RuntimeError, match="findings_latest.*notebook 01"):
        require_current_tables(FakeSpark(stale_view, versions), "main", "watchdog")
    require_current_tables(FakeSpark(complete, versions), "main", "watchdog")
    with pytest.raises(RuntimeError, match="findings_latest.*notebook 01"):
        require_current_tables(FakeSpark(complete, dict(versions, **{"main.watchdog.findings_latest": "0"})),
                               "main", "watchdog")


def test_the_scans_refuse_to_run_until_notebook_01_has_created_the_incidents_view():
    from jobs_watchdog.upgrade import require_current_tables

    complete, versions = complete_schema()
    without = {name: columns for name, columns in complete.items() if name != "main.watchdog.incidents"}
    with pytest.raises(RuntimeError, match="incidents is missing or out of date: run notebook 01 once"):
        require_current_tables(FakeSpark(without, versions), "main", "watchdog")
    wrong = dict(complete, **{"main.watchdog.incidents": list(FINDINGS_COLUMNS)})
    with pytest.raises(RuntimeError, match="incidents.*notebook 01"):
        require_current_tables(FakeSpark(wrong, versions), "main", "watchdog")


def test_watchdog_objects_lists_every_table_and_view():
    from jobs_watchdog.upgrade import watchdog_objects

    assert watchdog_objects() == ("monitored_jobs", "job_dependencies", "findings", "monitored_workspaces",
                                  "monitored_job_environments", "findings_latest", "incidents")
