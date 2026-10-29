"""Bring existing Watchdog tables and views up to date with this version.

Notebook 01 runs this after the CREATE TABLE IF NOT EXISTS files. A table
created by an older version keeps its rows; any column the DDL file now
declares but the table lacks is added at the end. Columns added this way are
always nullable. A view in sql/views is created when it is missing and
replaced only when its columns no longer match the findings table or its
definition version (watchdog.view_version) changed, because replacing a view
needs ownership and moves it to whoever runs this.
"""

import re
from dataclasses import dataclass
from pathlib import Path

from jobs_watchdog.identifiers import validate_identifier
from jobs_watchdog.sqlfiles import load_sql, repo_root

TABLES = (
    ("monitored_jobs", "sql/setup/02_create_monitored_jobs.sql"),
    ("job_dependencies", "sql/setup/03_create_job_dependencies.sql"),
    ("findings", "sql/setup/04_create_findings.sql"),
    ("monitored_workspaces", "sql/setup/05_create_monitored_workspaces.sql"),
    ("monitored_job_environments", "sql/setup/06_create_monitored_job_environments.sql"),
)
VIEW_TEMPLATES = tuple(sorted(str(p.relative_to(repo_root())) for p in (repo_root() / "sql" / "views").glob("*.sql")))
_COLUMN = re.compile(r"^\s+(\w+)\s+([A-Z]+(?:<[A-Z, ]+>)?)(\s+NOT NULL)?(?:\s+COMMENT\s+'([^']*)')?,?\s*$")
_VIEW_NAME = re.compile(r"CREATE OR REPLACE VIEW \{schema\}\.(\w+)")
VIEW_BASE = "findings"  # every view selects the columns of this table


def view_names():
    return tuple(_VIEW_NAME.search(Path(repo_root(), relpath).read_text()).group(1) for relpath in VIEW_TEMPLATES)


def watchdog_objects():
    """Every table and view notebook 01 creates in the Watchdog schema."""
    return tuple(table for table, _ in TABLES) + view_names()


_VERSION = re.compile(r"'watchdog\.view_version'\s*=\s*'(\d+)'")


def view_version(relpath):
    """The watchdog.view_version a view template declares."""
    return _VERSION.search(Path(repo_root(), relpath).read_text()).group(1)


def _deployed_version(spark, catalog, schema, name):
    """The watchdog.view_version of an existing view, or None."""
    try:
        rows = spark.sql(f"SHOW TBLPROPERTIES `{catalog}`.`{schema}`.`{name}` ('watchdog.view_version')").collect()
    except Exception:
        return None
    # asking for one key returns a single value column; a missing property comes
    # back as a "does not have property" message in that column
    for row in rows:
        value = str(row["value"]).strip()
        if value.isdigit():
            return value
    return None


def _view_is_current(spark, catalog, schema, relpath, name, base):
    existing = _columns(spark, f"{catalog}.{schema}.{name}")
    if existing is None:
        return None
    return existing == base and _deployed_version(spark, catalog, schema, name) == view_version(relpath)


def _columns(spark, name):
    """The columns of a table or view, or None when it is missing or unreadable."""
    try:
        return [column.lower() for column in spark.table(name).columns]
    except Exception:
        return None


@dataclass(frozen=True)
class Column:
    name: str
    data_type: str
    not_null: bool
    comment: str | None


def ddl_columns(relpath):
    """The columns a CREATE TABLE file declares, in order."""
    columns = []
    for line in load_sql(relpath).splitlines():
        match = _COLUMN.match(line)
        if match:
            name, data_type, not_null, comment = match.groups()
            columns.append(Column(name, data_type, bool(not_null), comment))
    return columns


def missing_columns(existing, columns):
    """The declared columns a table does not have yet, in declared order."""
    have = {name.lower() for name in existing}
    return [column for column in columns if column.name.lower() not in have]


def add_columns_statement(table, columns):
    """ALTER TABLE ... ADD COLUMNS for one of the Watchdog tables."""
    if table not in dict(TABLES):
        raise ValueError(f"not a Watchdog table: {table!r}")
    definitions = ", ".join(
        f"{c.name} {c.data_type}" + (f" COMMENT '{c.comment}'" if c.comment else "") for c in columns
    )
    return f"ALTER TABLE IDENTIFIER(:catalog || '.' || :schema || '.{table}') ADD COLUMNS ({definitions})"


def upgrade_tables(spark, catalog, schema):
    """Add missing columns to every Watchdog table; returns {table: [added columns]}."""
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    added = {}
    for table, relpath in TABLES:
        missing = missing_columns(spark.table(f"{catalog}.{schema}.{table}").columns, ddl_columns(relpath))
        if missing:
            spark.sql(add_columns_statement(table, missing), args={"catalog": catalog, "schema": schema})
            added[table] = [column.name for column in missing]
    return added


def require_current_tables(spark, catalog, schema):
    """Stop with a clear message when a Watchdog table is missing or out of date.

    The scans and the config load call this first, so pulling a new version
    and forgetting to re-run notebook 01 fails with a message, not a SQL error.
    """
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    for table, relpath in TABLES:
        name = f"{catalog}.{schema}.{table}"
        try:
            existing = spark.table(name).columns
        except Exception as err:
            first_line = (str(err).strip().splitlines() or [""])[0][:200]
            raise RuntimeError(f"{name} is missing or unreadable ({first_line}). Run notebook 01 first.") from err
        missing = missing_columns(existing, ddl_columns(relpath))
        if missing:
            names = ", ".join(column.name for column in missing)
            raise RuntimeError(f"{name} is missing columns {names}: run notebook 01 once to add them "
                               "(it upgrades existing tables and keeps their rows).")
    base = [column.lower() for column in spark.table(f"{catalog}.{schema}.{VIEW_BASE}").columns]
    for relpath, view in zip(VIEW_TEMPLATES, view_names()):
        if not _view_is_current(spark, catalog, schema, relpath, view, base):
            raise RuntimeError(f"{catalog}.{schema}.{view} is missing or out of date: run notebook 01 once.")


def render_view(relpath, catalog, schema):
    """A view template with {schema} replaced by the checked, quoted catalog and schema."""
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    return load_sql(relpath).replace("{schema}", f"`{catalog}`.`{schema}`")


def create_views(spark, catalog, schema):
    """Make every view in sql/views current; returns (name, "created" | "replaced" | "current") pairs."""
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    base = _columns(spark, f"{catalog}.{schema}.{VIEW_BASE}")
    results = []
    for relpath, name in zip(VIEW_TEMPLATES, view_names()):
        current = _view_is_current(spark, catalog, schema, relpath, name, base)
        if current:
            results.append((name, "current"))
            continue
        spark.sql(render_view(relpath, catalog, schema))
        results.append((name, "created" if current is None else "replaced"))
    return results
