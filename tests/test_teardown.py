import json
import os
import shutil
import subprocess
import sys

import pytest

from jobs_watchdog.sqlfiles import repo_root

ACCELERATOR = """
target:
  catalog: main
  schema: watchdog
  region: us-east-1
auth:
  mode: current_workspace
"""

FAKE_DATABRICKS = """#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
if [[ "$1 $2" == "tables list" ]]; then
  echo "$FAKE_TABLES_JSON"
fi
exit 0
"""


@pytest.fixture
def sandbox(tmp_path):
    for name in ("teardown.sh",):
        shutil.copy2(repo_root() / name, tmp_path / name)
    for folder in ("scripts", "jobs_watchdog"):
        shutil.copytree(repo_root() / folder, tmp_path / folder, ignore=shutil.ignore_patterns("__pycache__"))
    (tmp_path / "accelerator.local.yaml").write_text(ACCELERATOR)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "databricks").write_text(FAKE_DATABRICKS)
    (bin_dir / "python3").write_text(f'#!/usr/bin/env bash\nexec "{sys.executable}" "$@"\n')
    for tool in ("databricks", "python3"):
        (bin_dir / tool).chmod(0o755)
    return tmp_path


def run(sandbox, tables, *args):
    log = sandbox / "calls.log"
    env = dict(os.environ, PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log),
               FAKE_TABLES_JSON=json.dumps([{"name": name} for name in tables]))
    result = subprocess.run(["bash", str(sandbox / "teardown.sh"), *args], capture_output=True, text=True, env=env)
    calls = log.read_text().splitlines() if log.exists() else []
    return result, calls


def test_extra_tables_stop_the_schema_drop_before_anything_changes(sandbox):
    result, calls = run(sandbox, ["findings", "monitored_jobs", "job_dependencies", "orders"], "--drop-schema", "-y")
    assert result.returncode == 1
    assert "orders" in result.stdout + result.stderr
    assert not any(call.startswith("schemas delete") for call in calls)
    assert not any(call.startswith("bundle destroy") for call in calls)


def test_only_watchdog_tables_lets_the_schema_drop_run(sandbox):
    result, calls = run(sandbox, ["findings", "monitored_jobs", "job_dependencies"], "--drop-schema", "-y")
    assert result.returncode == 0, result.stderr
    assert any(call.startswith("bundle destroy -t dev --auto-approve") for call in calls)
    assert "schemas delete main.watchdog --force" in calls


def test_plain_teardown_never_lists_or_drops_tables(sandbox):
    result, calls = run(sandbox, [], "-y")
    assert result.returncode == 0, result.stderr
    assert calls == ["bundle destroy -t dev --auto-approve"]


def test_bundle_vars_failure_stops_before_any_databricks_call(sandbox):
    (sandbox / "accelerator.local.yaml").write_text(ACCELERATOR.replace("catalog: main", 'catalog: ""'))
    result, calls = run(sandbox, [], "--drop-schema", "-y")
    assert result.returncode != 0
    assert "target.catalog must be set" in result.stderr
    assert calls == []


def test_an_empty_listing_counts_as_no_extra_tables(sandbox):
    log = sandbox / "calls.log"
    env = dict(os.environ, PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log), FAKE_TABLES_JSON="")
    result = subprocess.run(["bash", str(sandbox / "teardown.sh"), "--drop-schema", "-y"], capture_output=True,
                            text=True, env=env)
    assert result.returncode == 0, result.stderr
    assert "schemas delete main.watchdog --force" in log.read_text().splitlines()


def test_the_current_tables_and_view_still_let_the_schema_drop_run(sandbox):
    listing = ["findings", "monitored_jobs", "job_dependencies", "monitored_workspaces", "findings_latest"]
    result, calls = run(sandbox, listing, "--drop-schema", "-y")
    assert result.returncode == 0, result.stderr
    assert "schemas delete main.watchdog --force" in calls


def test_teardown_accepts_exactly_the_objects_notebook_01_creates():
    import re

    from jobs_watchdog.upgrade import watchdog_objects

    text = (repo_root() / "teardown.sh").read_text()
    listed = set(re.findall(r'"(\w+)"', re.search(r"watchdog = \{([^}]*)\}", text).group(1)))
    assert listed == set(watchdog_objects())


def test_help_prints_the_whole_header(sandbox):
    result = subprocess.run(["bash", str(sandbox / "teardown.sh"), "-h"], capture_output=True, text=True)
    assert result.returncode == 0
    assert "docs/phase-1-runbook.md" in result.stdout and "set -euo" not in result.stdout
