"""Load and validate accelerator.yaml and the monitored-jobs file."""

import re
from dataclasses import dataclass, field, replace
from pathlib import Path

import yaml

from jobs_watchdog.identifiers import validate_identifier

SCHEDULE_TYPES = {"continuous", "scheduled"}
SEVERITIES = {"CRITICAL", "WARNING"}
DEPENDENCY_TYPES = {"job", "child_job", "service"}
AUTH_MODES = {"current_workspace", "service_principal"}
ACCELERATOR_SECTIONS = ("metadata", "target", "auth", "scan", "resources", "features")

# keys a job entry may set; defaults may set any of them except the names and patterns
JOB_KEYS = {
    "job_name", "job_name_regex", "job_name_exclude_regex", "schedule_type", "max_gap_minutes",
    "max_runtime_minutes", "max_retries", "min_attempt_minutes", "severity", "owner", "enabled", "notes",
    "environments",
}
DEFAULT_KEYS = JOB_KEYS - {"job_name", "job_name_regex", "environments"}
# settings an environment can override for one job
OVERRIDE_KEYS = ("severity", "owner", "enabled", "max_gap_minutes", "max_runtime_minutes", "max_retries",
                 "min_attempt_minutes")


class ConfigError(Exception):
    """Raised when a config file is missing, unreadable or invalid."""


@dataclass(frozen=True)
class MonitoredJob:
    job_name: str
    job_name_regex: str
    schedule_type: str
    max_gap_minutes: int | None
    max_runtime_minutes: int | None
    max_retries: int | None
    severity: str
    owner: str
    enabled: bool
    notes: str
    job_name_exclude_regex: str | None = None
    min_attempt_minutes: int | None = None
    # environment label -> {setting: value}, from the job's environments section
    environments: dict = field(default_factory=dict, hash=False)

    def settings_for(self, environment):
        """This job with the overrides for one environment label applied."""
        overrides = self.environments.get(environment) if environment else None
        return replace(self, **overrides) if overrides else self

    @property
    def active(self):
        """True when the job is checked in at least one environment."""
        return self.enabled or any(o.get("enabled") for o in self.environments.values())


@dataclass(frozen=True)
class Dependency:
    job_name: str
    depends_on: str
    dependency_type: str
    notes: str


@dataclass(frozen=True)
class MonitoredWorkspace:
    """An environment label for a workspace, matched by ID or by name."""

    workspace_id: str | None
    workspace_name: str | None
    environment: str
    notes: str


def _read_yaml(path):
    path = Path(path)
    try:
        text = path.read_text()
    except OSError as err:
        raise ConfigError(f"cannot read config file {path}: {err}") from err
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as err:
        raise ConfigError(f"{path} is not valid YAML: {err}") from err
    if not isinstance(data, dict):
        raise ConfigError(f"{path} must contain a YAML mapping at the top level")
    return data


def _optional_int(raw, job_name, field):
    if raw is None:
        return None
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        raise ConfigError(f"job {job_name}: {field} must be a whole number of zero or more, got {raw!r}")
    return raw


def _compiled(raw, name, field):
    try:
        re.compile(raw)
    except re.error as err:
        raise ConfigError(f"job {name}: {field} does not compile: {err}") from err
    return raw


def _check_severity(value, where):
    if value not in SEVERITIES:
        raise ConfigError(f"{where}: severity must be one of {sorted(SEVERITIES)}, got {value!r}")
    return value


def _check_enabled(value, where):
    if not isinstance(value, bool):
        raise ConfigError(f"{where}: enabled must be true or false, got {value!r}")
    return value


def _parse_defaults(raw):
    if raw in (None, {}):
        return {}
    if not isinstance(raw, dict):
        raise ConfigError(f"defaults must be a mapping of job settings, got {raw!r}")
    for key in raw:
        if key in JOB_KEYS - DEFAULT_KEYS:
            raise ConfigError(f"defaults cannot set {key}: set it on each job")
    unknown = sorted(set(raw) - DEFAULT_KEYS)
    if unknown:
        raise ConfigError(f"defaults has unknown keys {unknown}; allowed: {sorted(DEFAULT_KEYS)}")
    return dict(raw)


def _parse_environments(raw, name, labels):
    if raw in (None, {}):
        return {}
    if not isinstance(raw, dict):
        raise ConfigError(f"job {name}: environments must be a mapping of environment label to settings")
    parsed = {}
    for label, overrides in raw.items():
        label = str(label)
        where = f"job {name}: environments.{label}"
        if label not in labels:
            defined = ", ".join(sorted(labels)) or "none defined"
            raise ConfigError(f"job {name}: environment {label!r} is not a label in the workspaces section ({defined})")
        if not isinstance(overrides, dict):
            raise ConfigError(f"{where} must be a mapping such as {{severity: WARNING}}, got {overrides!r}")
        unknown = sorted(set(overrides) - set(OVERRIDE_KEYS))
        if unknown:
            raise ConfigError(f"{where} has unknown keys {unknown}; allowed: {list(OVERRIDE_KEYS)}")
        values = {}
        for key, value in overrides.items():
            if key == "severity":
                values[key] = _check_severity(value, where)
            elif key == "enabled":
                values[key] = _check_enabled(value, where)
            elif key == "owner":
                values[key] = str(value or "")
            else:
                values[key] = _optional_int(value, name, f"environments.{label}.{key}")
        parsed[label] = values
    return parsed


def _parse_job(raw, defaults=None, labels=()):
    if not isinstance(raw, dict) or not raw.get("job_name"):
        raise ConfigError(f"every job needs a job_name, got {raw!r}")
    name = str(raw["job_name"])
    unknown = sorted(set(raw) - JOB_KEYS)
    if unknown:
        raise ConfigError(f"job {name}: unknown keys {unknown}; allowed: {sorted(JOB_KEYS)}")
    environments = _parse_environments(raw.get("environments"), name, set(labels))
    raw = {**(defaults or {}), **raw}
    regex = _compiled(raw.get("job_name_regex") or f"^{re.escape(name)}$", name, "job_name_regex")
    exclude = raw.get("job_name_exclude_regex")
    exclude = _compiled(str(exclude), name, "job_name_exclude_regex") if exclude not in (None, "") else None
    enabled = _check_enabled(raw.get("enabled", True), f"job {name}")
    schedule_type = raw.get("schedule_type", "scheduled")
    if schedule_type not in SCHEDULE_TYPES:
        raise ConfigError(f"job {name}: schedule_type must be one of {sorted(SCHEDULE_TYPES)}, got {schedule_type!r}")
    severity = _check_severity(raw.get("severity", "WARNING"), f"job {name}")
    max_gap = _optional_int(raw.get("max_gap_minutes"), name, "max_gap_minutes")
    if schedule_type == "scheduled" and max_gap is None:
        raise ConfigError(f"job {name}: scheduled jobs need max_gap_minutes")
    return MonitoredJob(
        job_name=name,
        job_name_regex=regex,
        schedule_type=schedule_type,
        max_gap_minutes=max_gap,
        max_runtime_minutes=_optional_int(raw.get("max_runtime_minutes"), name, "max_runtime_minutes"),
        max_retries=_optional_int(raw.get("max_retries"), name, "max_retries"),
        severity=severity,
        owner=str(raw.get("owner") or ""),
        enabled=enabled,
        notes=str(raw.get("notes") or ""),
        job_name_exclude_regex=exclude,
        min_attempt_minutes=_optional_int(raw.get("min_attempt_minutes"), name, "min_attempt_minutes"),
        environments=environments,
    )


def _parse_dependency(raw, job_names):
    if not isinstance(raw, dict):
        raise ConfigError(f"every dependency must be a mapping, got {raw!r}")
    job_name = str(raw.get("job_name") or "")
    depends_on = str(raw.get("depends_on") or "")
    dependency_type = raw.get("dependency_type", "job")
    label = f"dependency {job_name} -> {depends_on}"
    if not job_name or not depends_on:
        raise ConfigError(f"{label}: job_name and depends_on are both required")
    if dependency_type not in DEPENDENCY_TYPES:
        raise ConfigError(f"{label}: dependency_type must be one of {sorted(DEPENDENCY_TYPES)}, got {dependency_type!r}")
    if job_name not in job_names:
        raise ConfigError(f"{label}: {job_name} is not a configured job")
    if dependency_type in {"job", "child_job"} and depends_on not in job_names:
        raise ConfigError(f"{label}: {depends_on} is not a configured job (use dependency_type: service for services)")
    return Dependency(job_name, depends_on, dependency_type, str(raw.get("notes") or ""))


def load_monitored_jobs(path):
    """Return (jobs, dependencies) from a monitored-jobs YAML file.

    The optional top-level defaults section fills every key a job leaves out.
    A job's environments section overrides settings for one environment label,
    and each label must be defined in the workspaces section.
    """
    data = _read_yaml(path)
    defaults = _parse_defaults(data.get("defaults"))
    labels = {_parse_workspace(raw).environment for raw in data.get("workspaces") or []}
    jobs = [_parse_job(raw, defaults, labels) for raw in data.get("jobs") or []]
    if not jobs:
        raise ConfigError(f"{path} lists no jobs")
    seen = set()
    for job in jobs:
        if job.job_name in seen:
            raise ConfigError(f"duplicate job_name {job.job_name!r} in {path}")
        seen.add(job.job_name)
    deps = [_parse_dependency(raw, seen) for raw in data.get("dependencies") or []]
    return jobs, deps


_ENVIRONMENT = re.compile(r"[A-Za-z0-9_-]+")


def _parse_workspace(raw):
    if not isinstance(raw, dict):
        raise ConfigError(f"every workspace entry must be a mapping, got {raw!r}")
    workspace_id = raw.get("workspace_id")
    workspace_name = raw.get("workspace_name")
    workspace_id = None if workspace_id in (None, "") else str(workspace_id)
    workspace_name = None if workspace_name in (None, "") else str(workspace_name)
    label = workspace_id or workspace_name
    if label is None:
        raise ConfigError(f"workspace entry {raw!r}: set workspace_id or workspace_name")
    if workspace_id is not None and not workspace_id.isdigit():
        raise ConfigError(f"workspace {label}: workspace_id must be digits, got {workspace_id!r}")
    environment = raw.get("environment")
    if not environment:
        raise ConfigError(f"workspace {label}: environment is required, for example production or lower")
    if not _ENVIRONMENT.fullmatch(str(environment)):
        raise ConfigError(f"workspace {label}: environment must be letters, digits, - or _, got {environment!r}")
    return MonitoredWorkspace(workspace_id, workspace_name, str(environment), str(raw.get("notes") or ""))


def load_monitored_workspaces(path):
    """The optional workspaces section of a monitored-jobs file: an environment per workspace."""
    data = _read_yaml(path)
    workspaces = [_parse_workspace(raw) for raw in data.get("workspaces") or []]
    seen = set()
    for workspace in workspaces:
        name = workspace.workspace_name.lower() if workspace.workspace_name else None
        for key in (("id", workspace.workspace_id), ("name", name)):
            if key[1] is None:
                continue
            if key in seen:
                raise ConfigError(f"workspace {key[1]} is listed twice in {path}")
            seen.add(key)
    return workspaces


def load_accelerator(path, require_complete=False):
    """Return accelerator.yaml as a dict.

    With require_complete=True, also check the values a run needs: catalog,
    schema and region set and valid, a known auth mode, and a secret scope
    when the service principal mode is chosen.
    """
    data = _read_yaml(path)
    for section in ACCELERATOR_SECTIONS:
        data.setdefault(section, {})
        if data[section] is None:
            data[section] = {}
    if not require_complete:
        return data
    target, auth = data["target"], data["auth"]
    for key in ("catalog", "schema", "region"):
        if not target.get(key):
            raise ConfigError(f"target.{key} must be set in {path}")
    for key in ("catalog", "schema"):
        try:
            validate_identifier(target[key], f"target.{key}")
        except ValueError as err:
            raise ConfigError(str(err)) from err
    mode = auth.get("mode", "current_workspace")
    if mode not in AUTH_MODES:
        raise ConfigError(f"auth.mode must be one of {sorted(AUTH_MODES)}, got {mode!r}")
    if mode == "service_principal" and not auth.get("secret_scope"):
        raise ConfigError("auth.secret_scope must be set when auth.mode is service_principal")
    return data
