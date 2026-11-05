"""Deploy one Watchdog per region.

A region file is an accelerator file plus a deploy section:

    deploy:
      workspace_host: https://<workspace>.cloud.databricks.com
      profile: ""     # optional CLI profile. Empty: the script sets DATABRICKS_HOST from
                      # workspace_host and the CLI signs in with OAuth M2M

Deploy a region as the same identity every time: the bundle state lives under that
identity's folder (docs/multi-region.md).

load_regions checks the files, region_env builds the environment one region's
CLI commands run in, and deploy_steps lists those commands. The script
scripts/deploy_regions.py runs them.
"""

import configparser
import json
from dataclasses import dataclass
from pathlib import Path

from jobs_watchdog.bundle_vars import VARIABLES, bundle_variables
from jobs_watchdog.config import ConfigError, load_accelerator
from jobs_watchdog.sqlfiles import load_sql, repo_root
from jobs_watchdog.upgrade import VIEW_TEMPLATES, render_view, view_names

TARGET = "production"
STATEMENTS_API = "/api/2.0/sql/statements"
WAIT_TIMEOUT = "50s"  # the longest the statement API waits before the call returns


@dataclass(frozen=True)
class RegionDeploy:
    name: str  # the part of the file name between "accelerator." and ".yaml"
    path: Path
    host: str
    profile: str
    catalog: str = ""
    schema: str = ""
    warehouse_id: str = ""


@dataclass(frozen=True)
class Step:
    """One CLI command.

    only_if_missing is a second command, a check: when it is set, argv runs only
    if the check finds no row.
    """

    label: str
    argv: list
    only_if_missing: list | None = None


def _region_name(path):
    name = Path(path).name
    if not (name.startswith("accelerator.") and name.endswith(".yaml")):
        raise ConfigError(f"{path}: a region file is named accelerator.<region>.yaml")
    return name[len("accelerator."):-len(".yaml")]


def _files(paths):
    files = []
    for entry in paths:
        entry = Path(entry)
        if entry.is_dir():
            found = sorted(entry.glob("accelerator.*.yaml"))
            if not found:
                raise ConfigError(f"no accelerator.<region>.yaml files in {entry}")
            files.extend(found)
        else:
            files.append(entry)
    return sorted(files, key=lambda p: (p.name, str(p)))


def _load_region(path):
    name = _region_name(path)
    data = load_accelerator(path, require_complete=True)
    target = data["target"]
    if not str(target.get("warehouse_id") or "").strip():
        raise ConfigError(f"target.warehouse_id must be set in {path}")
    deploy = data.get("deploy") or {}
    host = str(deploy.get("workspace_host") or "").strip().rstrip("/")
    if not host.startswith("https://") or len(host) <= len("https://"):
        raise ConfigError(f"deploy.workspace_host must be set in {path} and start with https://")
    return RegionDeploy(
        name=name, path=Path(path), host=host, profile=str(deploy.get("profile") or "").strip(),
        catalog=str(target["catalog"]), schema=str(target["schema"]), warehouse_id=str(target["warehouse_id"]).strip(),
    )


def region_names(paths):
    """The region names the given files and folders hold, read from the file names only."""
    names = []
    for path in _files(paths):
        try:
            names.append(_region_name(path))
        except ConfigError:
            continue
    return names


def load_regions(paths, only=None):
    """The checked regions in the given files and folders, sorted by file name.

    With only, just the region of that name is loaded and checked; the other files are not read.
    """
    files = _files(paths)
    if only:
        files = [path for path in files if path.name == f"accelerator.{only}.yaml"]
    regions = [_load_region(path) for path in files]
    seen = set()
    for region in regions:
        if region.name in seen:
            raise ConfigError(f"region {region.name!r} appears twice ({region.path})")
        seen.add(region.name)
    return regions


def region_env(region, base_env):
    """base_env plus this region's BUNDLE_VAR_* values, and DATABRICKS_HOST when no profile is set."""
    env = {key: value for key, value in base_env.items()
           if not (key.startswith("BUNDLE_VAR_") and key[len("BUNDLE_VAR_"):] in VARIABLES)}
    for name, value in bundle_variables(region.path).items():
        env[f"BUNDLE_VAR_{name}"] = value
    if region.profile:
        env.pop("DATABRICKS_HOST", None)
    else:
        env["DATABRICKS_HOST"] = region.host
    return env


def _profile_args(region):
    return ["--profile", region.profile] if region.profile else []


def _statement(region, statement, parameters):
    body = {
        "warehouse_id": region.warehouse_id,
        "statement": statement,
        "wait_timeout": WAIT_TIMEOUT,
        "on_wait_timeout": "CONTINUE",
        "parameters": [{"name": name, "value": value, "type": "STRING"} for name, value in parameters],
    }
    return ["databricks", "api", "post", STATEMENTS_API, "--json", json.dumps(body)] + _profile_args(region)


# information_schema holds names in lower case, so a schema named Watchdog must still find its view
_VIEW_EXISTS = ("SELECT 1 FROM IDENTIFIER(:catalog || '.information_schema.views') "
                "WHERE table_schema = lower(:schema) AND table_name = lower(:view)")


def workspace_target(path, profile=""):
    """One workspace's tables target from an accelerator file: its catalog, schema and warehouse, no host."""
    data = load_accelerator(path, require_complete=True)
    target = data["target"]
    if not str(target.get("warehouse_id") or "").strip():
        raise ConfigError(f"target.warehouse_id must be set in {path}")
    return RegionDeploy(name=Path(path).name, path=Path(path), host="", profile=profile,
                        catalog=str(target["catalog"]), schema=str(target["schema"]),
                        warehouse_id=str(target["warehouse_id"]).strip())


def ensure_tables_steps(region):
    """The Statement Execution API calls that create the Watchdog schema, tables and view when they are missing."""
    return _ensure_tables_steps(region)


def _ensure_tables_steps(region):
    base = [("catalog", region.catalog), ("schema", region.schema)]
    steps = []
    for path in sorted((repo_root() / "sql" / "setup").glob("*.sql")):
        relpath = str(path.relative_to(repo_root()))
        steps.append(Step(f"tables: {path.stem}", _statement(region, load_sql(relpath), base)))
    for relpath, name in zip(VIEW_TEMPLATES, view_names()):
        # CREATE OR REPLACE VIEW moves a view's owner, so an existing view is left alone
        steps.append(Step(
            f"tables: view {name}",
            _statement(region, render_view(relpath, region.catalog, region.schema), []),
            only_if_missing=_statement(region, _VIEW_EXISTS, base + [("view", name)]),
        ))
    return steps


def deploy_steps(region, validate_only, run_app, ensure_tables=True, app_access=True):
    """The commands for one region, in order.

    validate, then (unless validate_only) the Watchdog tables and views a fresh
    region lacks, which the copilot's Genie agent needs before the first
    deploy, then bundle deploy, then bundle run watchdog_app, then the
    watchdog_app_access job: after a teardown and a new deploy, it gives the
    new app access to the job list the teardown kept (it changes nothing
    otherwise).
    """
    profile = _profile_args(region)
    steps = [Step("validate", ["databricks", "bundle", "validate", "--strict", "-t", TARGET] + profile)]
    if validate_only:
        return steps
    if ensure_tables:
        steps += _ensure_tables_steps(region)
    steps.append(Step("deploy", ["databricks", "bundle", "deploy", "-t", TARGET] + profile))
    if run_app:
        steps.append(Step("run app", ["databricks", "bundle", "run", "watchdog_app", "-t", TARGET] + profile))
    if app_access:
        steps.append(Step("app access", ["databricks", "bundle", "run", "watchdog_app_access", "-t", TARGET] + profile))
    return steps


def normal_host(host):
    """A workspace host as https://<name>, lowercase, with no slash at the end; "" when unset."""
    host = str(host or "").strip().rstrip("/").lower()
    return f"https://{host}" if host and "://" not in host else host


def profile_hosts(env):
    """(profile name -> host, config path) from the CLI's config file (DATABRICKS_CONFIG_FILE, else ~/.databrickscfg)."""
    path = Path(env.get("DATABRICKS_CONFIG_FILE") or Path.home() / ".databrickscfg")
    parser = configparser.ConfigParser(default_section="__no_default__", interpolation=None)
    parser.read(path)
    return {name: normal_host(parser[name].get("host")) for name in parser.sections()}, path


@dataclass(frozen=True)
class TeardownTarget:
    host: str  # the workspace the teardown goes to, or "" when unknown
    profile: str  # the profile every CLI call gets with --profile, or "" to use DATABRICKS_HOST
    checked: bool  # True when an accelerator file named the host and the shell was checked against it


def teardown_target(path, profile, env):
    """Where teardown.sh sends its calls.

    With an accelerator file that has deploy.workspace_host (a region file), the
    teardown goes to that host and nowhere else: a DATABRICKS_HOST, a profile
    (-p, the file's deploy.profile, or DATABRICKS_CONFIG_PROFILE) that points at
    another workspace raises ConfigError before anything runs. Without one, it
    only reports the host the CLI will use, as far as it can tell.
    """
    deploy = (load_accelerator(path).get("deploy") or {}) if path else {}
    hosts, config = profile_hosts(env)
    host = normal_host(deploy.get("workspace_host"))
    chosen = profile or str(deploy.get("profile") or "").strip() or str(env.get("DATABRICKS_CONFIG_PROFILE") or "").strip()
    if not host:
        shown = hosts.get(chosen or "DEFAULT", "") if chosen or not env.get("DATABRICKS_HOST") else ""
        return TeardownTarget(normal_host(env.get("DATABRICKS_HOST")) or shown, profile, False)
    shell_host = normal_host(env.get("DATABRICKS_HOST"))
    if shell_host and shell_host != host:
        raise ConfigError(f"DATABRICKS_HOST points at {shell_host}, but {path} is the Watchdog in {host}")
    if chosen:
        if chosen not in hosts:
            raise ConfigError(f"the profile {chosen} is not in {config}")
        if hosts[chosen] != host:
            raise ConfigError(f"the profile {chosen} points at {hosts[chosen]}, but {path} is the Watchdog in {host}")
    return TeardownTarget(host, chosen, True)
