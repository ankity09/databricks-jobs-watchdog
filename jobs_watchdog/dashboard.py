"""Render the Watchdog findings dashboard and create or update it in a workspace.

The template in dashboards/ holds {{catalog}} and {{schema}} placeholders. render()
checks both names and fills them in. create_or_update_dashboard() calls the Lakeview
REST API through client.api_client.do, so it works with any databricks-sdk version:
older serverless runtimes ship an SDK without the dashboards dataclasses. The
workspace client is passed in, so tests can use a fake.
"""

from jobs_watchdog.identifiers import validate_identifier

_DASHBOARDS = "/api/2.0/lakeview/dashboards"
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


def _listed(client):
    """Every dashboard the caller can see, page by page."""
    token = None
    while True:
        query = {"page_size": 100, **({"page_token": token} if token else {})}
        page = client.api_client.do("GET", _DASHBOARDS, query=query) or {}
        yield from page.get("dashboards", [])
        token = page.get("next_page_token")
        if not token:
            return


def find_dashboards(client, display_name, parent_path):
    """The dashboards with this display name in this folder. Trashed ones are skipped.

    The list does not say which folder a dashboard is in, so the folder is read
    from each dashboard that already has the name.
    """
    matches = []
    for listed in _listed(client):
        if listed.get("display_name") != display_name or listed.get("lifecycle_state") == "TRASHED":
            continue
        dashboard = client.api_client.do("GET", f"{_DASHBOARDS}/{listed['dashboard_id']}")
        if _folder(dashboard.get("parent_path")) == _folder(parent_path):
            matches.append(dashboard)
    return matches


def create_or_update_dashboard(client, *, display_name, parent_path, serialized_dashboard, warehouse_id):
    """Update the dashboard with this name in this folder, or create it, then publish it.

    Returns the URL path of the published dashboard. Add it to the workspace host to open it.
    Two dashboards with the same name in one folder stop the deploy, so no copy is changed silently.
    """
    matches = find_dashboards(client, display_name, parent_path)
    if len(matches) > 1:
        ids = ", ".join(str(dashboard["dashboard_id"]) for dashboard in matches)
        raise ValueError(f"{len(matches)} dashboards named {display_name!r} are in {parent_path}: {ids}. "
                         "Trash all but one in the workspace, then run this again.")
    body = {"display_name": display_name, "serialized_dashboard": serialized_dashboard, "warehouse_id": warehouse_id}
    if matches:
        dashboard_id = matches[0]["dashboard_id"]
        client.api_client.do("PATCH", f"{_DASHBOARDS}/{dashboard_id}", body=body)
    else:
        client.workspace.mkdirs(parent_path)
        created = client.api_client.do("POST", _DASHBOARDS, body={**body, "parent_path": parent_path})
        dashboard_id = created["dashboard_id"]
    # embed_credentials off: viewers' queries run with their own permissions on the tables
    client.api_client.do("POST", f"{_DASHBOARDS}/{dashboard_id}/published",
                         body={"warehouse_id": warehouse_id, "embed_credentials": False})
    return f"/sql/dashboardsv3/{dashboard_id}/published"
