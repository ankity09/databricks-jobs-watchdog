"""Render the Watchdog findings dashboard and create or update it in a workspace.

The template in dashboards/ holds {{catalog}} and {{schema}} placeholders. render()
checks both names and fills them in. create_or_update_dashboard() uses only the
Lakeview list, create, update and publish calls, with Dashboard objects, which is the
shape databricks-sdk 0.40 expects. The Lakeview client is passed in, so tests can use a fake.
"""

from databricks.sdk.service.dashboards import Dashboard

from jobs_watchdog.identifiers import validate_identifier

CATALOG_PLACEHOLDER = "{{catalog}}"
SCHEMA_PLACEHOLDER = "{{schema}}"


def render(template_text, catalog, schema):
    """Return the dashboard JSON with the catalog and schema filled in.

    Both names must be plain identifiers (letters, digits, underscores). They are
    written with backticks, so a query reads `catalog`.`schema`.findings_latest.
    """
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    return (template_text
            .replace(CATALOG_PLACEHOLDER, f"`{catalog}`")
            .replace(SCHEMA_PLACEHOLDER, f"`{schema}`"))


def _folder(path):
    """A folder path with no trailing slash and no /Workspace prefix.

    The Lakeview API lists folders as /Users/..., while Workspace paths start with /Workspace/Users/...,
    so both spellings are reduced to the same form before they are compared.
    """
    path = (path or "").rstrip("/")
    return path[len("/Workspace"):] if path.startswith("/Workspace/") else path


def _is_trashed(dashboard):
    state = getattr(dashboard, "lifecycle_state", None)
    return getattr(state, "value", state) == "TRASHED"


def find_dashboards(lakeview, display_name, parent_path):
    """The dashboards with this display name in this folder. Trashed ones are skipped.

    list() does not say which folder a dashboard is in, so the folder is read with get(),
    and only for the dashboards that already have the name.
    """
    matches = []
    for listed in lakeview.list():
        if listed.display_name != display_name or _is_trashed(listed):
            continue
        dashboard = lakeview.get(listed.dashboard_id)
        if _folder(dashboard.parent_path) == _folder(parent_path):
            matches.append(dashboard)
    return matches


def create_or_update_dashboard(client, *, display_name, parent_path, serialized_dashboard, warehouse_id):
    """Update the dashboard with this name in this folder, or create it, then publish it.

    Returns the URL path of the published dashboard. Add it to the workspace host to open it.
    Two dashboards with the same name in one folder stop the deploy, so no copy is changed silently.
    """
    matches = find_dashboards(client.lakeview, display_name, parent_path)
    if len(matches) > 1:
        ids = ", ".join(str(dashboard.dashboard_id) for dashboard in matches)
        raise ValueError(f"{len(matches)} dashboards named {display_name!r} are in {parent_path}: {ids}. "
                         "Trash all but one in the workspace, then run this again.")
    if matches:
        dashboard_id = matches[0].dashboard_id
        client.lakeview.update(dashboard_id, dashboard=Dashboard(
            display_name=display_name, serialized_dashboard=serialized_dashboard, warehouse_id=warehouse_id))
    else:
        client.workspace.mkdirs(parent_path)
        created = client.lakeview.create(dashboard=Dashboard(
            display_name=display_name, parent_path=parent_path,
            serialized_dashboard=serialized_dashboard, warehouse_id=warehouse_id))
        dashboard_id = created.dashboard_id
    client.lakeview.publish(dashboard_id, warehouse_id=warehouse_id)
    return f"/sql/dashboardsv3/{dashboard_id}/published"
