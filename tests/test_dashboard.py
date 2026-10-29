"""Tests for the findings dashboard: the template, render() and create_or_update_dashboard().

Nothing here touches the network. The Lakeview client is a fake whose methods take the
same arguments as databricks-sdk 0.40 (create and update take a Dashboard object, publish
takes warehouse_id), so the code cannot quietly rely on newer SDK signatures.
"""

import json
import py_compile
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
import sqlglot
from sqlglot import exp

from databricks.sdk.service.dashboards import LifecycleState

from jobs_watchdog.dashboard import create_or_update_dashboard, find_dashboards, render

REPO = Path(__file__).resolve().parents[1]
TEMPLATE = REPO / "dashboards" / "watchdog_findings.lvdash.json"
NOTEBOOK = REPO / "notebooks" / "08_create_dashboard.py"

FINDINGS_COLUMNS = {
    "observed_at", "scan_id", "account_id", "region", "workspace_id", "workspace_name", "job_id", "job_name",
    "check_id", "status", "severity", "failure_category", "run_id", "run_page_url", "failed_task_keys",
    "error_summary", "affected_jobs", "owner", "source", "environment", "schedule_type", "run_start_time",
    "run_end_time", "run_duration_seconds", "trigger_type", "triggered_by", "job_tags", "code_version",
}
TABLES = {"findings", "findings_latest"}
# Widget type -> spec version, from the Lakeview widget index the template follows.
WIDGET_VERSIONS = {
    "counter": 2, "table": 2, "bar": 3, "filter-multi-select": 2, "filter-single-select": 2,
    "filter-date-range-picker": 2, "range-slider": 2,
}
NAME = "Watchdog findings"
FOLDER = "/Workspace/Users/someone@example.com"
SERIALIZED = '{"datasets": []}'


def template_text():
    return TEMPLATE.read_text()


def template():
    return json.loads(template_text())


def sql_of(dataset):
    return "".join(dataset["queryLines"])


def widgets_of(tpl):
    for page in tpl["pages"]:
        for item in page["layout"]:
            yield page, item["widget"], item["position"]


def field_refs(node):
    """Every fieldName value nested anywhere under node."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "fieldName":
                yield value
            else:
                yield from field_refs(value)
    elif isinstance(node, list):
        for item in node:
            yield from field_refs(item)


def test_template_is_valid_json_with_datasets_and_pages():
    tpl = template()
    assert tpl["datasets"] and tpl["pages"]


def test_dashboard_has_the_three_on_call_pages():
    assert [page["displayName"] for page in template()["pages"]] == ["Now", "Versions and runs", "History"]


def test_every_dataset_query_reads_only_through_the_placeholders():
    for dataset in template()["datasets"]:
        sql = sql_of(dataset)
        assert "{{catalog}}" in sql and "{{schema}}" in sql, dataset["name"]
        references = re.findall(r"(?i)\b(?:from|join)\s+(\S+)", sql)
        assert references, dataset["name"]
        for reference in references:
            if reference.startswith("("):
                continue  # a JOIN subquery; its own FROM is checked too
            assert reference.startswith("{{catalog}}.{{schema}}."), (dataset["name"], reference)
            table = reference[len("{{catalog}}.{{schema}}."):].rstrip(",;")
            assert table in TABLES, (dataset["name"], table)


def test_render_fills_in_the_catalog_and_schema_as_backtick_quoted_names():
    text = render(template_text(), "cat_one", "sch_one")
    assert "{{catalog}}" not in text and "{{schema}}" not in text
    assert "`cat_one`.`sch_one`.findings_latest" in text
    json.loads(text)


@pytest.mark.parametrize("catalog, schema", [
    ("bad-name", "watch"),
    ("cat", "has space"),
    ("cat", "x`y"),
    ("cat;drop", "watch"),
    ("", "watch"),
    ("cat", None),
])
def test_render_rejects_names_that_are_not_plain_identifiers(catalog, schema):
    with pytest.raises(ValueError):
        render(template_text(), catalog, schema)


def rendered():
    return json.loads(render(template_text(), "cat_one", "sch_one"))


def test_rendered_queries_parse_as_databricks_sql():
    for dataset in rendered()["datasets"]:
        sqlglot.parse_one(sql_of(dataset), read="databricks")


def test_rendered_queries_read_only_the_findings_tables_and_columns():
    assert len(FINDINGS_COLUMNS) == 28
    for dataset in rendered()["datasets"]:
        tree = sqlglot.parse_one(sql_of(dataset), read="databricks")
        tables = list(tree.find_all(exp.Table))
        assert tables, dataset["name"]
        for table in tables:
            assert table.catalog == "cat_one" and table.db == "sch_one", (dataset["name"], table.sql())
            assert table.name in TABLES, (dataset["name"], table.name)
        aliases = {alias.alias.lower() for alias in tree.find_all(exp.Alias)}
        columns = {column.name.lower() for column in tree.find_all(exp.Column)}
        unknown = columns - FINDINGS_COLUMNS - aliases
        assert not unknown, (dataset["name"], sorted(unknown))


def test_each_widget_field_is_produced_by_its_query():
    tpl = template()
    datasets = {dataset["name"] for dataset in tpl["datasets"]}
    for _, widget, _ in widgets_of(tpl):
        queries = {query["name"]: query["query"] for query in widget.get("queries", [])}
        for query in queries.values():
            assert query["datasetName"] in datasets, widget["name"]
            assert "disaggregated" in query, widget["name"]
            expressions = {field["expression"] for field in query["fields"]}
            for order in query.get("orders", []):
                assert order["expression"] in expressions, widget["name"]
        spec = widget.get("spec")
        if spec is None:
            continue
        encodings = spec.get("encodings", {})
        if "fields" in encodings:
            for binding in encodings["fields"]:
                query = queries[binding["queryName"]]
                assert binding["fieldName"] in {field["name"] for field in query["fields"]}, widget["name"]
        else:
            available = set()
            for query in queries.values():
                available |= {field["name"] for field in query["fields"]}
            for name in field_refs(encodings):
                assert name in available, (widget["name"], name)


def test_every_chart_and_counter_has_the_spec_version_the_widget_needs():
    for _, widget, _ in widgets_of(template()):
        spec = widget.get("spec")
        if spec is None:
            assert "multilineTextboxSpec" in widget, widget["name"]
            continue
        assert spec["frame"]["showTitle"] is True, widget["name"]
        assert spec["version"] == WIDGET_VERSIONS[spec["widgetType"]], widget["name"]
        if spec["widgetType"] == "counter":
            assert "color" not in spec["encodings"]["value"], widget["name"]


def test_widget_names_are_unique_and_use_only_safe_characters():
    names = [widget["name"] for _, widget, _ in widgets_of(template())]
    assert len(names) == len(set(names))
    for name in names:
        assert re.fullmatch(r"[A-Za-z0-9_-]{1,60}", name), name


def test_every_page_uses_grid_v1_and_each_row_fills_twelve_columns():
    for page in template()["pages"]:
        assert page["pageType"] in {"PAGE_TYPE_CANVAS", "PAGE_TYPE_GLOBAL_FILTERS"}, page["displayName"]
        assert page["layoutVersion"] == "GRID_V1", page["displayName"]
        widths = {}
        for item in page["layout"]:
            y = item["position"]["y"]
            widths[y] = widths.get(y, 0) + item["position"]["width"]
        assert all(width == 12 for width in widths.values()), (page["displayName"], widths)


class FakeLakeview:
    """Answers like the Lakeview API: list() leaves out the folder (parent_path), get() includes it."""

    def __init__(self, existing=()):
        self.stored = {dashboard.dashboard_id: dashboard for dashboard in existing}
        self.created = None
        self.updated = None
        self.published = None

    def list(self, *, page_size=None, page_token=None, show_trashed=None, view=None):
        return iter([
            SimpleNamespace(dashboard_id=d.dashboard_id, display_name=d.display_name, parent_path=None,
                            path=None, lifecycle_state=d.lifecycle_state)
            for d in self.stored.values()
        ])

    def get(self, dashboard_id):
        return self.stored[dashboard_id]

    def create(self, *, dashboard=None):
        self.created = dashboard
        return SimpleNamespace(dashboard_id="new-id")

    def update(self, dashboard_id, *, dashboard=None):
        self.updated = (dashboard_id, dashboard)
        return SimpleNamespace(dashboard_id=dashboard_id)

    def publish(self, dashboard_id, *, embed_credentials=None, warehouse_id=None):
        self.published = (dashboard_id, warehouse_id)
        return SimpleNamespace(dashboard_id=dashboard_id)


class FakeWorkspace:
    def __init__(self):
        self.made = []

    def mkdirs(self, path):
        self.made.append(path)


class FakeClient:
    def __init__(self, existing=()):
        self.lakeview = FakeLakeview(existing)
        self.workspace = FakeWorkspace()


def existing(dashboard_id, name=NAME, folder=FOLDER, state=LifecycleState.ACTIVE):
    return SimpleNamespace(dashboard_id=dashboard_id, display_name=name, parent_path=folder, lifecycle_state=state)


def deploy(client):
    return create_or_update_dashboard(
        client, display_name=NAME, parent_path=FOLDER, serialized_dashboard=SERIALIZED, warehouse_id="wh-1")


def test_find_dashboards_matches_name_and_folder_and_skips_trashed():
    client = FakeClient([
        existing("match"),
        existing("other-name", name="Something else"),
        existing("other-folder", folder="/Workspace/Users/other@example.com"),
        existing("trashed", state=LifecycleState.TRASHED),
    ])
    assert [d.dashboard_id for d in find_dashboards(client.lakeview, NAME, FOLDER)] == ["match"]


def test_existing_dashboard_in_the_folder_is_updated_and_published():
    client = FakeClient([existing("d-1")])
    path = deploy(client)
    assert client.lakeview.created is None
    dashboard_id, dashboard = client.lakeview.updated
    assert dashboard_id == "d-1"
    assert dashboard.display_name == NAME
    assert dashboard.serialized_dashboard == SERIALIZED
    assert dashboard.warehouse_id == "wh-1"
    assert client.lakeview.published == ("d-1", "wh-1")
    assert client.workspace.made == []
    assert path == "/sql/dashboardsv3/d-1/published"


def test_folder_with_a_trailing_slash_still_matches_the_existing_dashboard():
    client = FakeClient([existing("d-2", folder=FOLDER + "/")])
    deploy(client)
    assert client.lakeview.updated[0] == "d-2"
    assert client.lakeview.created is None


def test_listed_folder_without_the_workspace_prefix_still_matches():
    # The Lakeview API stores and lists the folder as /Users/..., while the notebook passes /Workspace/Users/...
    client = FakeClient([existing("d-3", folder=FOLDER.removeprefix("/Workspace"))])
    deploy(client)
    assert client.lakeview.updated[0] == "d-3"
    assert client.lakeview.created is None


def test_missing_dashboard_is_created_in_the_folder_and_published():
    client = FakeClient([
        existing("renamed", name="Something else"),
        existing("elsewhere", folder="/Workspace/Users/other@example.com"),
        existing("old", state=LifecycleState.TRASHED),
    ])
    path = deploy(client)
    assert client.lakeview.updated is None
    dashboard = client.lakeview.created
    assert dashboard.display_name == NAME
    assert dashboard.parent_path == FOLDER
    assert dashboard.serialized_dashboard == SERIALIZED
    assert dashboard.warehouse_id == "wh-1"
    assert client.workspace.made == [FOLDER]
    assert client.lakeview.published == ("new-id", "wh-1")
    assert path == "/sql/dashboardsv3/new-id/published"


def test_two_dashboards_with_the_same_name_in_the_folder_stop_the_deploy():
    client = FakeClient([existing("d-1"), existing("d-2")])
    with pytest.raises(ValueError, match="d-1, d-2"):
        deploy(client)
    assert client.lakeview.updated is None
    assert client.lakeview.created is None
    assert client.lakeview.published is None


def test_notebook_compiles(tmp_path):
    py_compile.compile(str(NOTEBOOK), cfile=str(tmp_path / "08.pyc"), doraise=True)


def test_notebook_creates_the_widgets_it_describes():
    text = NOTEBOOK.read_text()
    assert 'define_widgets("catalog", "schema")' in text
    for name in ("warehouse_id", "dashboard_folder", "dashboard_name"):
        assert f'"{name}"' in text, name
