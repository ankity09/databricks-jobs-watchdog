"""Load and validate accelerator.yaml and the monitored-jobs file."""

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from jobs_watchdog.identifiers import validate_identifier

SCHEDULE_TYPES = {"continuous", "scheduled"}
SEVERITIES = {"CRITICAL", "WARNING"}
DEPENDENCY_TYPES = {"job", "child_job", "service"}
AUTH_MODES = {"current_workspace", "service_principal"}
ACCELERATOR_SECTIONS = ("metadata", "target", "auth", "scan", "resources", "features")


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


@dataclass(frozen=True)
class Dependency:
    job_name: str
    depends_on: str
    dependency_type: str
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


def _parse_job(raw):
    if not isinstance(raw, dict) or not raw.get("job_name"):
        raise ConfigError(f"every job needs a job_name, got {raw!r}")
    name = str(raw["job_name"])
    regex = raw.get("job_name_regex") or f"^{re.escape(name)}$"
    try:
        re.compile(regex)
    except re.error as err:
        raise ConfigError(f"job {name}: job_name_regex does not compile: {err}") from err
    schedule_type = raw.get("schedule_type", "scheduled")
    if schedule_type not in SCHEDULE_TYPES:
        raise ConfigError(f"job {name}: schedule_type must be one of {sorted(SCHEDULE_TYPES)}, got {schedule_type!r}")
    severity = raw.get("severity", "WARNING")
    if severity not in SEVERITIES:
        raise ConfigError(f"job {name}: severity must be one of {sorted(SEVERITIES)}, got {severity!r}")
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
        enabled=bool(raw.get("enabled", True)),
        notes=str(raw.get("notes") or ""),
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
    """Return (jobs, dependencies) from a monitored-jobs YAML file."""
    data = _read_yaml(path)
    jobs = [_parse_job(raw) for raw in data.get("jobs") or []]
    if not jobs:
        raise ConfigError(f"{path} lists no jobs")
    seen = set()
    for job in jobs:
        if job.job_name in seen:
            raise ConfigError(f"duplicate job_name {job.job_name!r} in {path}")
        seen.add(job.job_name)
    deps = [_parse_dependency(raw, seen) for raw in data.get("dependencies") or []]
    return jobs, deps


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
