"""One entry point for the monitored-jobs list, from the YAML file or from the Watchdog app.

Notebook 02 calls load_config. With config_source yaml it reads the file at
monitored_jobs_path, as it always did. With lakebase it reads the newest
version the Watchdog app saved. Both go through the same parsing rules.
"""

from dataclasses import dataclass

from jobs_watchdog.config import (
    CONFIG_SOURCES,
    Dependency,
    MonitoredJob,
    MonitoredWorkspace,
    load_monitored_jobs,
    load_monitored_workspaces,
    parse_monitored_jobs,
    parse_monitored_workspaces,
)
from jobs_watchdog.lakebase_source import LakebaseSourceError, LakebaseTarget, read_latest_job_list


@dataclass(frozen=True)
class LoadedConfig:
    jobs: list[MonitoredJob]
    dependencies: list[Dependency]
    workspaces: list[MonitoredWorkspace]
    source: str  # yaml or lakebase
    source_ref: str  # the YAML path, or the Lakebase database path
    version: int | None  # the Lakebase job list version; None for YAML


def _target(s):
    return LakebaseTarget(s.lakebase_project_id, s.lakebase_branch, s.lakebase_database)


def source_ref_for(s):
    """Where the list comes from, as text; it works even when the load would fail."""
    if s.config_source == "lakebase":
        try:
            return _target(s).database_path
        except LakebaseSourceError:
            return f"projects/{s.lakebase_project_id}/branches/{s.lakebase_branch}/databases/{s.lakebase_database}"
    return str(s.monitored_jobs_path)


def load_config(s, api=None, connect=None):
    """Read, parse and check the monitored-jobs list named by the settings."""
    if s.config_source not in CONFIG_SOURCES:
        raise ValueError(f"config_source must be one of {sorted(CONFIG_SOURCES)}, got {s.config_source!r}")
    if s.config_source == "yaml":
        jobs, dependencies = load_monitored_jobs(s.monitored_jobs_path)
        workspaces = load_monitored_workspaces(s.monitored_jobs_path)
        return LoadedConfig(jobs, dependencies, workspaces, "yaml", str(s.monitored_jobs_path), None)
    if api is None or connect is None:
        raise ValueError("config_source lakebase needs api and connect")
    target = _target(s)
    latest = read_latest_job_list(api, target, connect)
    where = f"Lakebase job list version {latest.version}"
    jobs, dependencies = parse_monitored_jobs(latest.document, where)
    workspaces = parse_monitored_workspaces(latest.document, where)
    return LoadedConfig(jobs, dependencies, workspaces, "lakebase", target.database_path, latest.version)
