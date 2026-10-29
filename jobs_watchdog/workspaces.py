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


def build_targets(mode, current_workspace_id, region_workspaces, names):
    """The workspaces to scan, and the ones that cannot be scanned.

    current_workspace mode scans only the workspace running the notebook.
    service_principal mode scans every workspace that has jobs in this region
    (rows of sql/explore/10_workspaces_in_region.sql) and has a URL in the
    workspaces table. Workspaces without a URL come back as the second list.
    """
    by_id = {str(row["workspace_id"]): row for row in names}
    if mode == "current_workspace":
        workspace_id = str(current_workspace_id)
        return [Target(workspace_id, by_id.get(workspace_id, {}).get("workspace_name"), None)], []
    targets, missing = [], []
    for row in region_workspaces:
        workspace_id = str(row["workspace_id"])
        info = by_id.get(workspace_id, {})
        url = info.get("workspace_url")
        if url:
            targets.append(Target(workspace_id, info.get("workspace_name"), url))
        else:
            missing.append(Target(workspace_id, info.get("workspace_name"), None))
    return targets, missing
