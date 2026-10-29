"""Turn accelerator.yaml into bundle variables for the Databricks CLI.

scripts/bundle_vars.py prints them either as --var flags or as
BUNDLE_VAR_<name> exports, which the CLI reads from the environment.
"""

import shlex

from jobs_watchdog.config import load_accelerator

# bundle variable: (accelerator.yaml section, key)
VARIABLES = {
    "catalog": ("target", "catalog"),
    "schema": ("target", "schema"),
    "region": ("target", "region"),
    "lookback_hours": ("scan", "lookback_hours"),
    "auth_mode": ("auth", "mode"),
    "secret_scope": ("auth", "secret_scope"),
    "client_id_key": ("auth", "client_id_key"),
    "client_secret_key": ("auth", "client_secret_key"),
    "monitored_jobs_path": ("scan", "monitored_jobs_path"),
}


def bundle_variables(path):
    """Variable values from a complete accelerator.yaml; empty values are left out."""
    data = load_accelerator(path, require_complete=True)
    variables = {}
    for name, (section, key) in VARIABLES.items():
        value = data[section].get(key)
        if value is not None and str(value).strip():
            variables[name] = str(value).strip()
    return variables


def as_flags(variables):
    """--var=name=value flags, shell-quoted."""
    return " ".join(shlex.quote(f"--var={name}={value}") for name, value in variables.items())


def as_exports(variables):
    """export BUNDLE_VAR_name=value lines, shell-quoted."""
    return "\n".join(f"export BUNDLE_VAR_{name}={shlex.quote(value)}" for name, value in variables.items())
