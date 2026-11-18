import json
import os
import shutil
import subprocess
import sys

import pytest

from jobs_watchdog.sqlfiles import repo_root
from jobs_watchdog.upgrade import TABLES, ddl_columns, view_names

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
# A read of a table's columns gets the answer in columns/<table>.json next to FAKE_LOG (write_columns).
# FAKE_STATE overrides the statement state (FAILED, or PENDING once, then the poll gives the answer).
FAKE_DATABRICKS = """#!/usr/bin/env bash
echo "$* | host=${DATABRICKS_HOST:-} profile_env=${DATABRICKS_CONFIG_PROFILE:-} catalog=${BUNDLE_VAR_catalog:-} warehouse=${BUNDLE_VAR_warehouse_id:-}" >> "$FAKE_LOG"
if [[ "$1 $2" == "api post" ]]; then
  if [[ "${FAKE_STATE:-}" == "FAILED" ]]; then
    echo '{"statement_id":"s1","status":{"state":"FAILED","error":{"message":"PERMISSION_DENIED on the catalog"}}}'
    exit 0
  fi
  table_parameter='"name": "table", "value": "([A-Za-z0-9_]+)"'
  if [[ "$*" == *information_schema.columns* && "$*" =~ $table_parameter ]]; then
    answer="$(cat "$(dirname "$FAKE_LOG")/columns/${BASH_REMATCH[1]}.json")"
  elif [[ "$*" == *information_schema* && "${FAKE_VIEW_EXISTS:-}" == "1" ]]; then
    answer='{"statement_id":"s1","status":{"state":"SUCCEEDED"},"result":{"data_array":[["1"]]}}'
  elif [[ "$*" == *information_schema* ]]; then
    answer='{"statement_id":"s1","status":{"state":"SUCCEEDED"},"manifest":{},"result":null}'
  else
    answer='{"statement_id":"s1","status":{"state":"SUCCEEDED"}}'
  fi
  if [[ "${FAKE_STATE:-}" == "PENDING" ]]; then
    printf '%s\\n' "$answer" > "$FAKE_LOG.answer"  # what the poll returns
    echo '{"statement_id":"s1","status":{"state":"PENDING"}}'
    exit 0
  fi
  printf '%s\\n' "$answer"
  exit 0
fi
if [[ "$1 $2" == "api get" ]]; then
  if [[ -f "$FAKE_LOG.answer" ]]; then cat "$FAKE_LOG.answer"; else echo '{"statement_id":"s1","status":{"state":"SUCCEEDED"}}'; fi
  exit 0
fi
# FAKE_APP_SP_<n> answers the n-th apps get: a client ID, or "missing"; unset, the answer is not JSON.
if [[ "$1 $2" == "apps get" ]]; then
  n=$(grep -c '^apps get' "$FAKE_LOG")
  sp_var="FAKE_APP_SP_$n"
  if [[ "${!sp_var:-}" == "missing" ]]; then echo "Error: App with name $3 does not exist or is deleted." >&2; exit 1; fi
  if [[ -n "${!sp_var:-}" ]]; then printf '{"name":"%s","service_principal_client_id":"%s"}\n' "$3" "${!sp_var}"; exit 0; fi
fi
# FAKE_PROJECT=missing: the Lakebase project does not exist yet.
if [[ "$1 $2" == "postgres get-project" && "${FAKE_PROJECT:-}" == "missing" ]]; then
  echo "Error: Project with name '$3' not found" >&2
  exit 1
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
    shutil.copy2(repo_root() / "databricks.yml", tmp_path / "databricks.yml")  # the bundle's variable defaults
    write_columns(tmp_path)
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


def write_columns(sandbox, **tables):
    """The fake's answers to the column reads: each Watchdog table with its current columns, or the ones given."""
    folder = sandbox / "columns"
    folder.mkdir(exist_ok=True)
    for table, relpath in TABLES:
        columns = tables.get(table, [column.name for column in ddl_columns(relpath)])
        answer = {"statement_id": "s1", "status": {"state": "SUCCEEDED"},
                  "result": {"data_array": [[name] for name in columns]}}
        (folder / f"{table}.json").write_text(json.dumps(answer))


def statements(calls):
    """The SQL of each statement API call, in order."""
    posts = (call.split("--json ", 1)[1] for call in calls if call.startswith("api post"))
    return [json.JSONDecoder().raw_decode(post)[0]["statement"] for post in posts]


def run(sandbox, *args, **extra_env):
    log = sandbox / "calls.log"
    env = dict(os.environ, PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log),
               DATABRICKS_CLIENT_SECRET="s3cr3t-value-123", FAKE_TOKEN=TOKEN, **extra_env)
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


PROBES = ("apps get", "postgres get-project")


def test_a_full_deploy_creates_tables_then_deploys_then_runs_the_app(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"))
    assert result.returncode == 0, result.stdout + result.stderr
    kinds = [kind for kind in (" ".join(call.split(" ")[:2]) for call in calls) if kind not in PROBES]
    assert kinds[0] == "bundle validate"
    assert kinds[-3:] == ["bundle deploy", "bundle run", "bundle run"]
    assert bundle_calls(calls)[-1] == "bundle run watchdog_app_access -t production"
    middle = kinds[1:-3]
    assert middle and set(middle) == {"api post"}
    first_deploy = kinds.index("bundle deploy")
    assert all(kind == "api post" for kind in kinds[1:first_deploy])
    setup = len(list((repo_root() / "sql" / "setup").glob("*.sql")))
    # a read per table (each already has every column, so no ALTER), and a check and a create per missing view
    assert len(middle) == setup + len(TABLES) + 2 * len(view_names())
    assert not any(statement.startswith("ALTER TABLE") for statement in statements(calls))


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
                                   "bundle run watchdog_app -t production",
                                   "bundle run watchdog_app_access -t production"]


def test_no_app_run_leaves_out_the_app_run_and_skip_app_access_the_access_job(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"), "--no-app-run")
    assert result.returncode == 0
    assert bundle_calls(calls)[-2:] == ["bundle deploy -t production", "bundle run watchdog_app_access -t production"]
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"), "--no-app-run",
                        "--skip-app-access")
    assert result.returncode == 0
    assert bundle_calls(calls)[-1] == "bundle deploy -t production"


def test_a_failed_statement_stops_that_region_before_the_deploy(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"), FAKE_STATE="FAILED")
    assert result.returncode == 1
    assert "PERMISSION_DENIED on the catalog" in result.stdout + result.stderr
    assert "bundle deploy -t production" not in bundle_calls(calls)


def test_a_pending_statement_is_polled_until_it_finishes(sandbox, monkeypatch, capsys):
    import importlib.util

    spec = importlib.util.spec_from_file_location("deploy_regions_under_test", repo_root() / "scripts" / "deploy_regions.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "POLL_INTERVAL_SECONDS", 0)
    log = sandbox / "calls.log"
    monkeypatch.setenv("PATH", f"{sandbox / 'bin'}:{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("FAKE_STATE", "PENDING")
    code = module.main([str(sandbox / "regions" / "accelerator.lower.yaml")])
    capsys.readouterr()
    assert code == 0
    assert any(call.startswith("api get /api/2.0/sql/statements/s1") for call in log.read_text().splitlines())


def test_the_poll_interval_is_not_read_from_the_environment(sandbox):
    # A test-only setting must not change production behavior.
    assert "DEPLOY_REGIONS_POLL_SECONDS" not in (repo_root() / "scripts" / "deploy_regions.py").read_text()


def test_a_missing_databricks_binary_is_reported_in_the_summary(sandbox):
    empty = sandbox / "empty-bin"
    empty.mkdir()
    env = dict(os.environ, PATH=str(empty))
    result = subprocess.run([sys.executable, str(sandbox / "scripts" / "deploy_regions.py"),
                             str(sandbox / "regions" / "accelerator.lower.yaml"), "--validate-only"],
                            capture_output=True, text=True, env=env, cwd=sandbox)
    assert result.returncode == 1
    assert "Traceback" not in result.stderr
    assert "databricks" in result.stderr and "PATH" in result.stderr
    assert any("lower" in line and "FAILED" in line for line in result.stdout.splitlines())


def test_a_profile_from_the_environment_cannot_redirect_a_region(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions"), "--validate-only", DATABRICKS_CONFIG_PROFILE="other-workspace")
    assert result.returncode == 0, result.stdout + result.stderr
    assert calls and all("profile_env= " in call for call in calls)
    assert all("host=https://" in call for call in calls)
    assert "DATABRICKS_CONFIG_PROFILE" in result.stderr  # one line says it was ignored


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


def test_only_ignores_a_broken_file_for_another_region(sandbox):
    bad = sandbox / "regions" / "accelerator.prod-us.yaml"
    bad.write_text("target: [not, a, mapping\n")
    result, calls = run(sandbox, str(sandbox / "regions"), "--validate-only", "--only", "prod-eu")
    assert result.returncode == 0, result.stdout + result.stderr
    assert len(calls) == 1 and "host=https://prod-eu.example.com" in calls[0]


def test_only_still_checks_the_named_region(sandbox):
    bad = sandbox / "regions" / "accelerator.prod-eu.yaml"
    bad.write_text(bad.read_text().replace("  warehouse_id: whprod-eu\n", ""))
    result, calls = run(sandbox, str(sandbox / "regions"), "--validate-only", "--only", "prod-eu")
    assert result.returncode == 2
    assert "target.warehouse_id" in result.stderr
    assert calls == []


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


def test_the_docs_do_not_say_the_targets_are_both_development_mode_or_that_ci_sets_the_host():
    readme = (repo_root() / "README.md").read_text()
    assert "Both targets use development mode" not in readme
    docs = (repo_root() / "docs" / "multi-region.md").read_text()
    remove = docs.split("## Remove one region", 1)[1]
    assert "same identity" in remove
    assert "from a CI variable" in docs  # CI takes the host from the region file


# the access job: only when the deploy gave the app a new service principal and the Lakebase project was kept


def probes(calls):
    return [call.split(" | ")[0] for call in calls if call.startswith(PROBES)]


def test_a_deploy_that_keeps_the_app_s_service_principal_does_not_run_the_access_job(sandbox):
    sp = "11111111-2222-3333-4444-555555555555"
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"), FAKE_APP_SP_1=sp, FAKE_APP_SP_2=sp)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "bundle run watchdog_app_access -t production" not in bundle_calls(calls)
    assert probes(calls) == ["postgres get-project projects/jobs-watchdog -o json", "apps get watchdog-app -o json",
                             "apps get watchdog-app -o json"]
    assert "app access not needed: the app kept its service principal" in result.stdout
    assert any([cell.strip() for cell in line.split("|")][1:] == ["app access", "not needed"] for line in result.stdout.splitlines())


def test_a_first_deploy_with_a_new_lakebase_project_does_not_run_the_access_job(sandbox):
    result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"), FAKE_PROJECT="missing",
                        FAKE_APP_SP_1="missing", FAKE_APP_SP_2="11111111-2222-3333-4444-555555555555")
    assert result.returncode == 0, result.stdout + result.stderr
    assert "bundle run watchdog_app_access -t production" not in bundle_calls(calls)
    assert "the Lakebase project is new" in result.stdout


def test_a_new_service_principal_with_a_kept_project_runs_the_access_job(sandbox):
    # after a plain teardown, or a new app.name: the kept job list belongs to someone else
    for before in ("missing", "99999999-2222-3333-4444-555555555555"):
        result, calls = run(sandbox, str(sandbox / "regions" / "accelerator.lower.yaml"),
                            FAKE_APP_SP_1=before, FAKE_APP_SP_2="11111111-2222-3333-4444-555555555555")
        assert result.returncode == 0, result.stdout + result.stderr
        assert bundle_calls(calls)[-1] == "bundle run watchdog_app_access -t production"


def test_the_access_check_uses_the_region_s_app_and_project_names_and_its_profile(sandbox):
    region = sandbox / "regions" / "accelerator.lower.yaml"
    region.write_text(region.read_text().replace("deploy:", "app:\n  name: watchdog-eu\n  lakebase_project_id: watchdog-eu-list\ndeploy:")
                      .replace('profile: ""', "profile: lower"))
    sp = "11111111-2222-3333-4444-555555555555"
    result, calls = run(sandbox, str(region), FAKE_APP_SP_1=sp, FAKE_APP_SP_2=sp)
    assert result.returncode == 0, result.stdout + result.stderr
    assert probes(calls) == ["postgres get-project projects/watchdog-eu-list -o json --profile lower",
                             "apps get watchdog-eu -o json --profile lower", "apps get watchdog-eu -o json --profile lower"]
