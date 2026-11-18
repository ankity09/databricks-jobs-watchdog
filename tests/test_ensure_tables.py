"""scripts/ensure_tables.py: the Watchdog tables before the first deploy of a single workspace."""

import os
import shutil
import subprocess
import sys

import pytest

from jobs_watchdog.sqlfiles import repo_root
from jobs_watchdog.upgrade import TABLES, ddl_columns, view_names
from tests.test_deploy_regions import FAKE_DATABRICKS, statements, write_columns

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
    write_columns(tmp_path)
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
    # a read per table (each already has every column, so no ALTER), and a check and a create per missing view
    assert len(calls) == setup + len(TABLES) + 2 * len(view_names())
    assert all(call.startswith("api post /api/2.0/sql/statements") for call in calls)
    assert all('"warehouse_id": "wh123"' in call and "--profile my-profile" in call for call in calls)
    assert "bundle" not in " ".join(calls)
    assert "tables: columns of findings: current" in result.stdout


def test_a_findings_table_from_phase_1_2_gets_parent_job_before_the_incidents_view_is_created(sandbox):
    # incidents names parent_job, which findings has only since Phase 1.3, so the view could not be created first
    write_columns(sandbox, findings=[c.name for c in ddl_columns("sql/setup/04_create_findings.sql")
                                     if c.name != "parent_job"])
    result, calls = run(sandbox)
    assert result.returncode == 0, result.stdout + result.stderr
    sql = statements(calls)
    alters = [statement for statement in sql if statement.startswith("ALTER TABLE")]
    assert len(alters) == 1
    assert alters[0].startswith("ALTER TABLE IDENTIFIER(:catalog || '.' || :schema || '.findings') "
                                "ADD COLUMNS (parent_job STRING COMMENT ")
    incidents = next(i for i, statement in enumerate(sql)
                     if "CREATE OR REPLACE VIEW `main`.`watchdog`.incidents" in statement)
    assert sql.index(alters[0]) < incidents
    assert "tables: columns of findings: added parent_job" in result.stdout


def test_a_table_whose_columns_cannot_be_read_stops_before_any_view(sandbox):
    write_columns(sandbox, findings=[])
    result, calls = run(sandbox)
    assert result.returncode == 1
    assert "cannot see the columns of main.watchdog.findings" in result.stderr
    assert not any("CREATE OR REPLACE VIEW" in statement or statement.startswith("ALTER TABLE")
                   for statement in statements(calls))


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
