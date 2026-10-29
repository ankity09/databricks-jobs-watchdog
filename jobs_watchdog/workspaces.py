"""Workspace names, URLs and the workspaces the Jobs API scan visits."""

from jobs_watchdog.jobs_api import Target
from jobs_watchdog.sqlfiles import run_sql

NAMES_VIEW = "watchdog_workspace_names"
NAMES_SQL = "sql/explore/11_workspace_names.sql"
NAMES_SCHEMA = "workspace_id STRING, workspace_name STRING, workspace_url STRING, status STRING"


def _as_dict(row):
    return row.asDict() if hasattr(row, "asDict") else dict(row)


def register_workspace_names(spark):
    """Create the temp view watchdog_workspace_names.

    Returns (rows, error). When system.access.workspaces_latest cannot be read
    (it is in Public Preview), the view is empty and error says why; findings
    then have no workspace names or run links, and nothing else breaks.
    """
    try:
        frame = run_sql(spark, NAMES_SQL)
        rows = [_as_dict(row) for row in frame.collect()]
    except Exception as err:
        spark.createDataFrame([], schema=NAMES_SCHEMA).createOrReplaceTempView(NAMES_VIEW)
        first_line = (str(err).strip().splitlines() or [""])[0]
        return [], f"{type(err).__name__}: {first_line[:300]}"
    frame.createOrReplaceTempView(NAMES_VIEW)
    return rows, None


def environment_for(workspace_id, workspace_name, labels):
    """The environment label for a workspace: by ID first, then by name.

    Entries with an ID match only that ID. Entries without one match the
    workspace name, ignoring case. The system table scan applies the same rule.
    """
    for label in labels:
        if label.workspace_id is not None and label.workspace_id == str(workspace_id):
            return label.environment
    if workspace_name:
        for label in labels:
            if label.workspace_id is None and (label.workspace_name or "").lower() == workspace_name.lower():
                return label.environment
    return None


def build_targets(mode, current_workspace_id, region_workspaces, names, labels=()):
    """The workspaces to scan, and the ones that cannot be scanned.

    current_workspace mode scans only the workspace running the notebook.
    service_principal mode scans every workspace that has jobs in this region
    (rows of sql/explore/10_workspaces_in_region.sql) and has a URL in the
    workspaces table. Workspaces without a URL come back as the second list.
    Each target carries its environment label from the workspaces config.
    """
    by_id = {str(row["workspace_id"]): row for row in names}

    def target(workspace_id, host):
        name = by_id.get(workspace_id, {}).get("workspace_name")
        return Target(workspace_id, name, host, environment_for(workspace_id, name, labels))

    if mode == "current_workspace":
        return [target(str(current_workspace_id), None)], []
    targets, missing = [], []
    for row in region_workspaces:
        workspace_id = str(row["workspace_id"])
        url = by_id.get(workspace_id, {}).get("workspace_url")
        (targets if url else missing).append(target(workspace_id, url or None))
    return targets, missing
