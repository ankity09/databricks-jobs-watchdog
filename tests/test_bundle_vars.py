import subprocess
import sys

import pytest

from jobs_watchdog.bundle_vars import as_exports, as_flags, bundle_variables
from jobs_watchdog.config import ConfigError
from jobs_watchdog.sqlfiles import repo_root

COMPLETE = """
target:
  catalog: main
  schema: watchdog
  region: us-east-1
auth:
  mode: current_workspace
  secret_scope: ""
  client_id_key: client_id
  client_secret_key: client_secret
scan:
  lookback_hours: 48
  monitored_jobs_path: /Volumes/main/ops/files/my jobs.yml
"""


def write(tmp_path, text):
    path = tmp_path / "accelerator.local.yaml"
    path.write_text(text)
    return path


def test_values_come_from_accelerator_yaml_and_empties_are_skipped(tmp_path):
    variables = bundle_variables(write(tmp_path, COMPLETE))
    assert variables["catalog"] == "main"
    assert variables["region"] == "us-east-1"
    assert variables["lookback_hours"] == "48"
    assert variables["auth_mode"] == "current_workspace"
    assert "secret_scope" not in variables


def test_required_values_must_be_set(tmp_path):
    with pytest.raises(ConfigError, match="target.region"):
        bundle_variables(write(tmp_path, COMPLETE.replace("region: us-east-1", 'region: ""')))


def test_flags_are_shell_quoted(tmp_path):
    flags = as_flags(bundle_variables(write(tmp_path, COMPLETE)))
    assert "--var=catalog=main" in flags
    assert "'--var=monitored_jobs_path=/Volumes/main/ops/files/my jobs.yml'" in flags


def test_exports_set_bundle_var_environment_variables(tmp_path):
    exports = as_exports(bundle_variables(write(tmp_path, COMPLETE))).splitlines()
    assert "export BUNDLE_VAR_catalog=main" in exports
    assert "export BUNDLE_VAR_monitored_jobs_path='/Volumes/main/ops/files/my jobs.yml'" in exports


def test_script_prints_exports(tmp_path):
    result = subprocess.run([sys.executable, str(repo_root() / "scripts" / "bundle_vars.py"), "--export",
                             str(write(tmp_path, COMPLETE))], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert "export BUNDLE_VAR_schema=watchdog" in result.stdout


def test_script_explains_missing_values(tmp_path):
    path = write(tmp_path, COMPLETE.replace("catalog: main", 'catalog: ""'))
    result = subprocess.run([sys.executable, str(repo_root() / "scripts" / "bundle_vars.py"), str(path)],
                            capture_output=True, text=True)
    assert result.returncode == 2
    assert "target.catalog must be set" in result.stderr
