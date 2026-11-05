"""scripts/ensure_tables.py: the Watchdog tables before the first deploy of a single workspace."""

import os
import shutil
import subprocess
import sys

import pytest

from jobs_watchdog.sqlfiles import repo_root
from jobs_watchdog.upgrade import view_names
from tests.test_deploy_regions import FAKE_DATABRICKS

LOCAL = """
target:
  catalog: main
  schema: watchdog
  region: us-east-1
  warehouse_id: wh123
auth:
  mode: current_workspace
"""


@pytest.fixture
def sandbox(tmp_path):
    for folder in ("scripts", "jobs_watchdog", "sql"):
        shutil.copytree(repo_root() / folder, tmp_path / folder, ignore=shutil.ignore_patterns("__pycache__"))
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "databricks").write_text(FAKE_DATABRICKS)
    (bin_dir / "databricks").chmod(0o755)
    return tmp_path


def run(sandbox, *args, text=LOCAL, **extra_env):
    (sandbox / "accelerator.local.yaml").write_text(text)
    log = sandbox / "calls.log"
    log.unlink(missing_ok=True)
    env = dict(os.environ, PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log), **extra_env)
    result = subprocess.run([sys.executable, str(sandbox / "scripts" / "ensure_tables.py"), *args],
                            capture_output=True, text=True, env=env, cwd=sandbox)
    return result, log.read_text().splitlines() if log.exists() else []


def test_it_creates_every_setup_table_then_the_missing_view_on_the_file_s_warehouse(sandbox):
    result, calls = run(sandbox, str(sandbox / "accelerator.local.yaml"), "--profile", "my-profile")
    assert result.returncode == 0, result.stdout + result.stderr
    setup = len(list((repo_root() / "sql" / "setup").glob("*.sql")))
    assert len(calls) == setup + 2 * len(view_names())  # a check and a create per missing view
    assert all(call.startswith("api post /api/2.0/sql/statements") for call in calls)
    assert all('"warehouse_id": "wh123"' in call and "--profile my-profile" in call for call in calls)
    assert "bundle" not in " ".join(calls)


def test_it_reads_accelerator_local_yaml_by_default(sandbox):
    result, calls = run(sandbox)
    assert result.returncode == 0, result.stderr
    assert calls and all('"warehouse_id": "wh123"' in call for call in calls)


def test_a_file_without_a_warehouse_says_so_and_runs_nothing(sandbox):
    result, calls = run(sandbox, text=LOCAL.replace("  warehouse_id: wh123\n", ""))
    assert result.returncode == 2
    assert "target.warehouse_id must be set" in result.stderr
    assert calls == []


def test_a_failed_statement_stops_with_its_message(sandbox):
    result, calls = run(sandbox, FAKE_STATE="FAILED")
    assert result.returncode == 1
    assert "PERMISSION_DENIED on the catalog" in result.stderr
    assert len(calls) == 1
