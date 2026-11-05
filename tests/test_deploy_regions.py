import json
import os
import shutil
import subprocess
import sys

import pytest

from jobs_watchdog.sqlfiles import repo_root
from jobs_watchdog.upgrade import view_names

TOKEN = "dapi" + "0123456789abcdef" * 2  # built here so no token-shaped literal sits in the file

REGION_FILE = """
target:
  catalog: main
  schema: watchdog
  region: {region}
  warehouse_id: wh{name}
auth:
  mode: current_workspace
deploy:
  workspace_host: https://{name}.example.com
  profile: "{profile}"
"""

# Logs each call (arguments plus the environment the script set), then answers.
# FAKE_FAIL_HOST makes every bundle command fail for that host.
# FAKE_VIEW_EXISTS=1 answers the view check with a row.
# FAKE_STATE overrides the statement state (FAILED, or PENDING once, then SUCCEEDED).
FAKE_DATABRICKS = """#!/usr/bin/env bash
echo "$* | host=${DATABRICKS_HOST:-} catalog=${BUNDLE_VAR_catalog:-} warehouse=${BUNDLE_VAR_warehouse_id:-}" >> "$FAKE_LOG"
if [[ "$1 $2" == "api post" ]]; then
  if [[ "${FAKE_STATE:-}" == "FAILED" ]]; then
    echo '{"statement_id":"s1","status":{"state":"FAILED","error":{"message":"PERMISSION_DENIED on the catalog"}}}'
    exit 0
  fi
  if [[ "${FAKE_STATE:-}" == "PENDING" ]]; then
    echo '{"statement_id":"s1","status":{"state":"PENDING"}}'
    exit 0
  fi
  if [[ "$*" == *information_schema* ]]; then
    if [[ "${FAKE_VIEW_EXISTS:-}" == "1" ]]; then
      echo '{"statement_id":"s1","status":{"state":"SUCCEEDED"},"result":{"data_array":[["1"]]}}'
    else
      echo '{"statement_id":"s1","status":{"state":"SUCCEEDED"},"manifest":{},"result":null}'
    fi
    exit 0
  fi
  echo '{"statement_id":"s1","status":{"state":"SUCCEEDED"}}'
  exit 0
fi
if [[ "$1 $2" == "api get" ]]; then
  echo '{"statement_id":"s1","status":{"state":"SUCCEEDED"}}'
  exit 0
fi
if [[ -n "${FAKE_FAIL_HOST:-}" && "${DATABRICKS_HOST:-}" == "$FAKE_FAIL_HOST" && "$1" == "bundle" ]]; then
  echo "Error: boom with $DATABRICKS_CLIENT_SECRET and ${FAKE_TOKEN}" >&2
  exit 1
fi
echo "ok $*"
exit 0
"""


@pytest.fixture
def sandbox(tmp_path):
    for folder in ("scripts", "jobs_watchdog", "sql"):
        shutil.copytree(repo_root() / folder, tmp_path / folder, ignore=shutil.ignore_patterns("__pycache__"))
    regions = tmp_path / "regions"
    regions.mkdir()
    for name, region in (("lower", "us-east-2"), ("prod-eu", "eu-west-1"), ("prod-us", "us-east-1")):
        (regions / f"accelerator.{name}.yaml").write_text(REGION_FILE.format(name=name, region=region, profile=""))
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "databricks").write_text(FAKE_DATABRICKS)
    (bin_dir / "python3").write_text(f'#!/usr/bin/env bash\nexec "{sys.executable}" "$@"\n')
    for tool in ("databricks", "python3"):
        (bin_dir / tool).chmod(0o755)
    return tmp_path


def run(sandbox, *args, **extra_env):
    log = sandbox / "calls.log"
    env = dict(os.environ, PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log),
               DEPLOY_REGIONS_POLL_SECONDS="0", DATABRICKS_CLIENT_SECRET="s3cr3t-value-123", FAKE_TOKEN=TOKEN, **extra_env)
    result = subprocess.run([sys.executable, str(sandbox / "scripts" / "deploy_regions.py"), *args],
                            capture_output=True, text=True, env=env, cwd=sandbox)
    calls = log.read_text().splitlines() if log.exists() else []
    return result, calls


def bundle_calls(calls):
    return [call.split(" | ")[0] for call in calls if call.startswith("bundle ")]


def test_validate_only_validates_each_region_and_changes_nothing(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions"), "--validate-only")
    assert result.returncode == 0, result.stdout + result.stderr
    assert bundle_calls(calls) == ["bundle validate --strict -t production"] * 3
    assert not any(call.startswith("api ") for call in calls)  # no tables step
    assert [call.split("host=")[1].split(" ")[0] for call in calls] == [
        "https://lower.example.com", "https://prod-eu.example.com", "https://prod-us.example.com"]


def test_each_region_runs_with_its_own_variables(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions"), "--validate-only")
    assert "warehouse=whprod-eu" in calls[1]
    assert "catalog=main" in calls[1]


def test_a_full_deploy_creates_tables_then_deploys_then_runs_the_app(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"))
    assert result.returncode == 0, result.stdout + result.stderr
    kinds = [" ".join(call.split(" ")[:2]) for call in calls]
    assert kinds[0] == "bundle validate"
    assert kinds[-2:] == ["bundle deploy", "bundle run"]
    middle = kinds[1:-2]
    assert middle and set(middle) == {"api post"}
    first_deploy = kinds.index("bundle deploy")
    assert all(kind == "api post" for kind in kinds[1:first_deploy])
    setup = len(list((repo_root() / "sql" / "setup").glob("*.sql")))
    assert len(middle) == setup + 2 * len(view_names())  # a check and a create per missing view


def test_an_existing_view_is_not_replaced(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"), FAKE_VIEW_EXISTS="1")
    assert result.returncode == 0, result.stdout + result.stderr
    assert not any("CREATE OR REPLACE VIEW" in call for call in calls)
    assert any("information_schema" in call for call in calls)
    assert "exists" in result.stdout


def test_skip_ensure_tables_leaves_out_the_api_calls(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"), "--skip-ensure-tables")
    assert result.returncode == 0, result.stdout + result.stderr
    assert not any(call.startswith("api ") for call in calls)
    assert bundle_calls(calls) == ["bundle validate --strict -t production", "bundle deploy -t production",
                                   "bundle run watchdog_app -t production"]


def test_no_app_run_stops_after_the_deploy(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"), "--no-app-run")
    assert result.returncode == 0
    assert bundle_calls(calls)[-1] == "bundle deploy -t production"


def test_a_failed_statement_stops_that_region_before_the_deploy(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"), FAKE_STATE="FAILED")
    assert result.returncode == 1
    assert "PERMISSION_DENIED on the catalog" in result.stdout + result.stderr
    assert "bundle deploy -t production" not in bundle_calls(calls)


def test_a_pending_statement_is_polled_until_it_finishes(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"), FAKE_STATE="PENDING")
    assert result.returncode == 0, result.stdout + result.stderr
    assert any(call.startswith("api get /api/2.0/sql/statements/s1") for call in calls)


def test_a_failure_in_one_region_does_not_stop_the_others(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions"), "--validate-only", FAKE_FAIL_HOST="https://prod-eu.example.com")
    assert result.returncode == 1
    assert len(bundle_calls(calls)) == 3  # all three regions ran
    table = result.stdout.splitlines()
    rows = [line for line in table if "validate" in line and "|" in line]
    assert any("lower" in row and "ok" in row for row in rows)
    assert any("prod-eu" in row and "FAILED" in row for row in rows)
    assert any("prod-us" in row and "ok" in row for row in rows)


def test_after_a_failed_step_the_rest_of_that_region_is_skipped(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions"), "--skip-ensure-tables", "--no-app-run",
                        FAKE_FAIL_HOST="https://prod-eu.example.com")
    assert result.returncode == 1
    assert bundle_calls(calls).count("bundle deploy -t production") == 2
    assert any("prod-eu" in line and "deploy" in line and "skipped" in line for line in result.stdout.splitlines())


def test_secrets_are_never_printed(sandbox):
    result, _ = run(sandbox, str(sandbox / "regions"), "--validate-only", FAKE_FAIL_HOST="https://prod-eu.example.com")
    output = result.stdout + result.stderr
    assert "s3cr3t-value-123" not in output
    assert TOKEN not in output
    assert "boom" in output  # the error itself is shown


def test_only_picks_one_region_by_the_name_in_the_file(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions"), "--validate-only", "--only", "prod-eu")
    assert result.returncode == 0
    assert len(calls) == 1 and "host=https://prod-eu.example.com" in calls[0]


def test_only_with_an_unknown_name_lists_the_known_ones(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions"), "--validate-only", "--only", "nope")
    assert result.returncode == 2
    assert "lower" in result.stderr and "prod-eu" in result.stderr
    assert calls == []


def test_a_bad_region_file_stops_before_any_command_and_names_the_file(sandbox):
    bad = sandbox / "regions" / "accelerator.prod-us.yaml"
    bad.write_text(bad.read_text().replace("  warehouse_id: whprod-us\n", ""))
    result, calls = run(sandbox, str(sandbox / "regions"), "--validate-only")
    assert result.returncode == 2
    assert "accelerator.prod-us.yaml" in result.stderr and "target.warehouse_id" in result.stderr
    assert calls == []


def test_a_profile_is_passed_to_every_command(sandbox):
    path = sandbox / "regions" / "accelerator.lower.yaml"
    path.write_text(REGION_FILE.format(name="lower", region="us-east-2", profile="my-profile"))
    result, calls = run(sandbox, str(path))
    assert result.returncode == 0, result.stdout + result.stderr
    assert all("--profile my-profile" in call.split(" | ")[0] for call in calls)
    assert all("host= " in call for call in calls)  # the host comes from the profile


def test_the_summary_table_lists_region_step_and_result(sandbox):
    result, _ = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"), "--skip-ensure-tables")
    lines = result.stdout.splitlines()
    assert any(line.split() == ["region", "|", "step", "|", "result"] for line in lines)
    assert any("lower" in line and "deploy" in line and "ok" in line for line in lines)


def test_the_json_body_is_valid_for_the_statement_api(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"))
    post = next(call for call in calls if call.startswith("api post"))
    body = json.loads(post.split("--json ", 1)[1].split(" | ")[0])
    assert body["warehouse_id"] == "whlower"
