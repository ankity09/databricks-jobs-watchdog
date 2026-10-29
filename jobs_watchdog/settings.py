"""Notebook settings: widget defaults from accelerator.yaml, and input checks.

Every notebook reads its inputs from widgets. A widget's default comes from
accelerator.local.yaml when that file exists (your filled-in, git-ignored
copy), otherwise from accelerator.yaml, otherwise from the built-in default
below. Job parameters override the defaults when the notebooks run as a job.
"""

from pathlib import Path
from types import SimpleNamespace

from jobs_watchdog.config import AUTH_MODES, load_accelerator
from jobs_watchdog.identifiers import validate_identifier

# widget name: (accelerator.yaml section, key, built-in default)
WIDGETS = {
    "catalog": ("target", "catalog", ""),
    "schema": ("target", "schema", "watchdog"),
    "region": ("target", "region", ""),
    "lookback_hours": ("scan", "lookback_hours", "48"),
    "scan_id": (None, None, ""),
    "auth_mode": ("auth", "mode", "current_workspace"),
    "secret_scope": ("auth", "secret_scope", ""),
    "client_id_key": ("auth", "client_id_key", "client_id"),
    "client_secret_key": ("auth", "client_secret_key", "client_secret"),
    "monitored_jobs_path": ("scan", "monitored_jobs_path", "config/monitored_jobs.example.yml"),
    "code_version_tag": ("scan", "code_version_tag", "code_version"),
}


def accelerator_file(repo_root):
    """accelerator.local.yaml when present, otherwise accelerator.yaml."""
    local = Path(repo_root) / "accelerator.local.yaml"
    return local if local.is_file() else Path(repo_root) / "accelerator.yaml"


def widget_defaults(repo_root):
    """Default text for every widget.

    With no accelerator file the built-in defaults apply. A file that exists
    but cannot be read raises ConfigError, so a typo never goes unnoticed.
    """
    path = accelerator_file(repo_root)
    data = load_accelerator(path) if path.is_file() else {}
    defaults = {}
    for name, (section, key, fallback) in WIDGETS.items():
        value = (data.get(section) or {}).get(key) if section else None
        defaults[name] = fallback if value is None or str(value).strip() == "" else str(value).strip()
    return defaults


def read_settings(values, repo_root):
    """Check widget values and convert them; only the names given are checked.

    Relative paths are resolved from the repo root. Raises ValueError with a
    message that says what to fix.
    """
    settings = {name: str(value).strip() for name, value in values.items()}
    for key in ("catalog", "schema"):
        if key in settings:
            if not settings[key]:
                raise ValueError(f"{key} is empty: type it in the {key} box at the top of the notebook, "
                                 f"or set target.{key} in accelerator.local.yaml")
            validate_identifier(settings[key], key)
    if "lookback_hours" in settings:
        hours = settings["lookback_hours"]
        if not hours.isdigit() or int(hours) == 0:
            raise ValueError(f"lookback_hours must be a whole number above zero, got {hours!r}")
        settings["lookback_hours"] = int(hours)
    if "auth_mode" in settings:
        if settings["auth_mode"] not in AUTH_MODES:
            raise ValueError(f"auth_mode must be one of {sorted(AUTH_MODES)}, got {settings['auth_mode']!r}")
        if settings["auth_mode"] == "service_principal" and not settings.get("secret_scope"):
            raise ValueError("service_principal mode needs secret_scope: the secret scope holding the OAuth secret")
    if "monitored_jobs_path" in settings:
        path = Path(settings["monitored_jobs_path"])
        settings["monitored_jobs_path"] = path if path.is_absolute() else Path(repo_root) / path
    return SimpleNamespace(**settings)
