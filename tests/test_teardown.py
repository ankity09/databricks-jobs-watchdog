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


UNBIND_THEN_DESTROY = [
    "bundle deployment unbind watchdog_database -t dev",
    "bundle deployment unbind watchdog_owner -t dev",
    "bundle deployment unbind watchdog_db -t dev",
    "bundle destroy -t dev --auto-approve",
]


def test_plain_teardown_never_lists_or_drops_tables(sandbox):
    result, calls = run(sandbox, [], "-y")
    assert result.returncode == 0, result.stderr
    assert calls == UNBIND_THEN_DESTROY


def test_plain_teardown_keeps_the_lakebase_project(sandbox):
    result, calls = run(sandbox, [], "-y")
    assert result.returncode == 0, result.stderr
    assert calls == UNBIND_THEN_DESTROY
    assert not any(call.startswith("postgres") for call in calls)


def test_drop_lakebase_deletes_the_project_after_the_destroy(sandbox):
    result, calls = run(sandbox, [], "--drop-lakebase", "-y")
    assert result.returncode == 0, result.stderr
    assert calls[:-1] == UNBIND_THEN_DESTROY
    assert calls[-1] == "postgres delete-project projects/jobs-watchdog"


def test_drop_lakebase_keeps_the_project_unless_the_name_is_typed(sandbox):
    log = sandbox / "calls.log"
    env = dict(os.environ, PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log))
    result = subprocess.run(["bash", str(sandbox / "teardown.sh"), "--drop-lakebase"], capture_output=True,
                            text=True, env=env, input="yes\nnope\n")
    assert result.returncode == 0
    assert "Lakebase project kept." in result.stdout
    assert not any(call.startswith("postgres") for call in log.read_text().splitlines())


def test_a_teardown_of_a_bundle_that_never_had_the_app_still_works(sandbox):
    (sandbox / "bin" / "databricks").write_text(FAKE_DATABRICKS.replace(
        'exit 0', 'if [[ "$1 $2" == "bundle deployment" ]]; then echo "no such resource" >&2; exit 1; fi\nexit 0'))
    result, calls = run(sandbox, [], "-y")
    assert result.returncode == 0, result.stderr
    assert calls[-1] == "bundle destroy -t dev --auto-approve"


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


def test_teardown_header_names_every_job_the_bundle_deploys():
    import yaml

    header = (repo_root() / "teardown.sh").read_text().split("set -euo")[0]
    for path in (repo_root() / "resources").glob("*.yml"):
        for job in (yaml.safe_load(path.read_text()) or {}).get("resources", {}).get("jobs", {}):
            assert job in header, job


def run_with_input(sandbox, answers, *args):
    log = sandbox / "calls.log"
    env = dict(os.environ, PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log))
    result = subprocess.run(["bash", str(sandbox / "teardown.sh"), *args], capture_output=True, text=True, env=env,
                            input=answers)
    return result, log.read_text().splitlines() if log.exists() else []


def test_declining_the_prompt_makes_no_calls(sandbox):
    result, calls = run_with_input(sandbox, "no\n")
    assert result.returncode == 0, result.stderr
    assert "Nothing was changed." in result.stdout
    assert calls == []


def test_yes_at_the_prompt_unbinds_then_destroys_without_asking_again(sandbox):
    result, calls = run_with_input(sandbox, "yes\n")
    assert result.returncode == 0, result.stderr
    assert calls == UNBIND_THEN_DESTROY


def test_dash_y_skips_the_prompt(sandbox):
    result, calls = run_with_input(sandbox, "", "-y")
    assert result.returncode == 0, result.stderr
    assert "Type yes" not in result.stdout
    assert calls == UNBIND_THEN_DESTROY


def test_a_plain_teardown_prints_how_to_bind_the_kept_lakebase_resources(sandbox):
    result, _ = run_with_input(sandbox, "", "-y")
    assert "bundle deployment bind watchdog_db projects/jobs-watchdog -t dev" in result.stdout
    assert "branches/production/roles/watchdog-owner" in result.stdout
    assert "branches/production/databases/watchdog" in result.stdout


def test_the_hint_ends_with_giving_the_new_app_access_to_the_kept_list(sandbox):
    out = run_with_input(sandbox, "", "-y")[0].stdout
    steps = ["bundle deployment bind watchdog_database", "databricks bundle deploy -t dev",
             "databricks bundle run watchdog_app -t dev", "databricks bundle run watchdog_app_access -t dev"]
    assert all(step in out for step in steps)
    assert [out.index(step) for step in steps] == sorted(out.index(step) for step in steps)


def test_dropping_the_lakebase_project_prints_no_bind_hint(sandbox):
    result, _ = run_with_input(sandbox, "", "--drop-lakebase", "-y")
    assert "bundle deployment bind" not in result.stdout


def test_teardown_runs_the_destroy_for_an_accelerator_file_without_a_warehouse(sandbox):
    assert "warehouse_id" not in (sandbox / "accelerator.local.yaml").read_text()
    log = sandbox / "calls.log"
    env = dict(os.environ, PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log))
    env.pop("BUNDLE_VAR_warehouse_id", None)
    (sandbox / "bin" / "databricks").write_text(FAKE_DATABRICKS.replace(
        'echo "$*" >> "$FAKE_LOG"', 'echo "$* warehouse=$BUNDLE_VAR_warehouse_id" >> "$FAKE_LOG"'))
    result = subprocess.run(["bash", str(sandbox / "teardown.sh"), "-y"], capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stderr
    assert "bundle destroy -t dev --auto-approve warehouse=unused-for-teardown" in log.read_text().splitlines()


def test_config_option_reads_another_accelerator_file(sandbox):
    other = sandbox / "accelerator.prod-eu.yaml"
    other.write_text(ACCELERATOR.replace("schema: watchdog", "schema: other_schema"))
    result, calls = run(sandbox, ["findings", "monitored_jobs", "job_dependencies"], "-t", "production", "-c", str(other),
                        "--drop-schema", "-y")
    assert result.returncode == 0, result.stderr
    assert "schemas delete main.other_schema --force" in calls
    assert any(call.startswith("bundle destroy -t production --auto-approve") for call in calls)


def test_config_with_a_missing_directory_says_so_and_changes_nothing(sandbox):
    result, calls = run(sandbox, [], "-c", str(sandbox / "no-such-dir" / "accelerator.x.yaml"), "-y")
    assert result.returncode == 2
    assert "no-such-dir" in result.stderr and "does not exist" in result.stderr
    assert calls == []


def test_config_with_a_missing_file_says_so_and_changes_nothing(sandbox):
    result, calls = run(sandbox, [], "-c", str(sandbox / "accelerator.nope.yaml"), "-y")
    assert result.returncode == 2
    assert "accelerator.nope.yaml" in result.stderr and "does not exist" in result.stderr
    assert calls == []


@pytest.mark.parametrize("option", ["-c", "-t", "-p"])
def test_an_option_without_a_value_gets_a_clear_message(sandbox, option):
    result, calls = run(sandbox, [], "-y", option)
    assert result.returncode == 2
    assert f"{option} needs a value" in result.stderr
    assert "unbound variable" not in result.stderr
    assert calls == []


# -c with a region file: the teardown goes to the file's deploy.workspace_host, or nowhere

REGION = ACCELERATOR + """
deploy:
  workspace_host: https://prod-eu.example.com/
  profile: ""
"""

FAKE_ENV_DATABRICKS = FAKE_DATABRICKS.replace(
    'echo "$*" >> "$FAKE_LOG"', 'echo "$* | host=${DATABRICKS_HOST:-} profile=${DATABRICKS_CONFIG_PROFILE:-}" >> "$FAKE_LOG"')


CLI_CONFIG = "[eu]\nhost = https://prod-eu.example.com\n\n[us]\nhost = https://prod-us.example.com/\n"
# The CLI reads these; Python's configparser refuses a key twice in a section, and a key before the first section.
CONFIG_PYTHON_REFUSES = [CLI_CONFIG + "host = https://prod-us.example.com/\n", "host = https://prod-eu.example.com\n" + CLI_CONFIG]


def region_run(sandbox, *args, answers="", region=REGION, config=CLI_CONFIG, **env_extra):
    (sandbox / "accelerator.prod-eu.yaml").write_text(region)
    (sandbox / "bin" / "databricks").write_text(FAKE_ENV_DATABRICKS)
    (sandbox / "databrickscfg").write_text(config)
    log = sandbox / "calls.log"
    log.unlink(missing_ok=True)
    env = {key: value for key, value in os.environ.items() if not key.startswith("DATABRICKS_")}
    env.update(PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log),
               DATABRICKS_CONFIG_FILE=str(sandbox / "databrickscfg"), **env_extra)
    result = subprocess.run(["bash", str(sandbox / "teardown.sh"), "-t", "production", "-c",
                             str(sandbox / "accelerator.prod-eu.yaml"), *args], capture_output=True, text=True,
                            env=env, input=answers)
    return result, log.read_text().splitlines() if log.exists() else []


def test_a_region_file_sends_every_call_to_its_own_host(sandbox):
    result, calls = region_run(sandbox, "-y")
    assert result.returncode == 0, result.stderr
    assert calls and all("host=https://prod-eu.example.com profile=" in call for call in calls)


def test_the_prompt_names_the_workspace_and_the_genie_agent(sandbox):
    result, calls = region_run(sandbox, answers="no\n")
    assert "https://prod-eu.example.com" in result.stdout
    assert "Genie agent" in result.stdout and "conversations" in result.stdout
    assert "experiment" not in result.stdout
    assert calls == []


def test_a_shell_host_for_another_workspace_refuses_before_any_call(sandbox):
    result, calls = region_run(sandbox, "-y", DATABRICKS_HOST="https://prod-us.example.com")
    assert result.returncode == 2
    assert "https://prod-us.example.com" in result.stderr and "https://prod-eu.example.com" in result.stderr
    assert "Nothing was changed" in result.stderr and calls == []


def test_a_shell_profile_for_another_workspace_refuses(sandbox):
    result, calls = region_run(sandbox, "-y", DATABRICKS_CONFIG_PROFILE="us")
    assert result.returncode == 2 and calls == []
    assert "us" in result.stderr and "https://prod-eu.example.com" in result.stderr


def test_a_profile_option_for_another_workspace_refuses(sandbox):
    result, calls = region_run(sandbox, "-y", "-p", "us")
    assert result.returncode == 2 and calls == []


def test_a_matching_profile_is_used_for_every_call(sandbox):
    result, calls = region_run(sandbox, "-y", "-p", "eu")
    assert result.returncode == 0, result.stderr
    assert calls and all("--profile eu" in call for call in calls)


def test_the_region_file_s_own_profile_is_used_and_checked(sandbox):
    region = REGION.replace('profile: ""', "profile: eu")
    result, calls = region_run(sandbox, "-y", region=region)
    assert result.returncode == 0, result.stderr
    assert calls and all("--profile eu" in call for call in calls)
    result, calls = region_run(sandbox, "-y", region=REGION.replace('profile: ""', "profile: us"))
    assert result.returncode == 2 and calls == []


def test_an_unknown_profile_refuses(sandbox):
    result, calls = region_run(sandbox, "-y", "-p", "nope")
    assert result.returncode == 2 and "nope" in result.stderr and calls == []


@pytest.mark.parametrize("config", CONFIG_PYTHON_REFUSES)
def test_a_region_file_without_a_profile_never_reads_the_cli_config(sandbox, config):
    result, calls = region_run(sandbox, "-y", config=config)
    assert result.returncode == 0, result.stderr
    assert calls and all("host=https://prod-eu.example.com profile=" in call for call in calls)


@pytest.mark.parametrize("config", CONFIG_PYTHON_REFUSES)
def test_a_profile_in_a_cli_config_python_cannot_read_refuses_with_a_message(sandbox, config):
    result, calls = region_run(sandbox, "-y", "-p", "eu", config=config)
    assert result.returncode == 2 and calls == []
    assert "Traceback" not in result.stderr
    assert str(sandbox / "databrickscfg") in result.stderr and "profile eu" in result.stderr
    assert "Nothing was changed" in result.stderr


@pytest.mark.parametrize("config", CONFIG_PYTHON_REFUSES)
def test_a_cli_config_python_cannot_read_does_not_stop_a_teardown_without_a_region_file(sandbox, config):
    (sandbox / "databrickscfg").write_text(config)
    log = sandbox / "calls.log"
    env = {key: value for key, value in os.environ.items() if not key.startswith("DATABRICKS_")}
    env.update(PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log), DATABRICKS_CONFIG_FILE=str(sandbox / "databrickscfg"))
    result = subprocess.run(["bash", str(sandbox / "teardown.sh"), "-y"], capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stderr
    assert "Traceback" not in result.stderr
    assert any(call.startswith("bundle destroy") for call in log.read_text().splitlines())


# the bind hint, whatever happens after the unbind

def test_a_destroy_that_fails_after_the_unbind_still_prints_the_bind_hint(sandbox):
    (sandbox / "bin" / "databricks").write_text(FAKE_DATABRICKS.replace(
        'exit 0', 'if [[ "$1 $2" == "bundle destroy" ]]; then echo "destroy failed" >&2; exit 1; fi\nexit 0'))
    log = sandbox / "calls.log"
    env = dict(os.environ, PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log))
    result = subprocess.run(["bash", str(sandbox / "teardown.sh"), "-y"], capture_output=True, text=True, env=env)
    assert result.returncode != 0
    assert "bundle deployment bind watchdog_db projects/jobs-watchdog -t dev" in result.stdout


def test_declining_to_delete_the_project_prints_the_bind_hint(sandbox):
    result, calls = run_with_input(sandbox, "yes\nnope\n", "--drop-lakebase")
    assert result.returncode == 0
    assert "Lakebase project kept." in result.stdout
    assert "bundle deployment bind watchdog_db" in result.stdout


# The redeploy steps the hint prints: runnable as printed, in the same workspace and with the same settings.

def plain_run(sandbox, *args, accelerator=ACCELERATOR):
    """teardown.sh without a region file, with a CLI config of the sandbox's own (profile eu)."""
    (sandbox / "accelerator.local.yaml").write_text(accelerator)
    (sandbox / "databrickscfg").write_text(CLI_CONFIG)
    log = sandbox / "calls.log"
    env = {key: value for key, value in os.environ.items() if not key.startswith("DATABRICKS_")}
    env.update(PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(log),
               DATABRICKS_CONFIG_FILE=str(sandbox / "databrickscfg"))
    result = subprocess.run(["bash", str(sandbox / "teardown.sh"), *args], capture_output=True, text=True, env=env)
    return result, log.read_text().splitlines() if log.exists() else []


def printed_commands(out):
    return [line.strip() for line in out.splitlines() if line.startswith("  ")]


def test_the_redeploy_steps_set_the_bundle_variables_first_and_carry_the_profile(sandbox):
    result, _ = plain_run(sandbox, "-y", "-p", "eu")
    assert result.returncode == 0, result.stderr
    commands = printed_commands(result.stdout)
    assert commands[0] == 'eval "$(python3 scripts/bundle_vars.py --export accelerator.local.yaml)"'
    cli = [command for command in commands if command.startswith("databricks ")]
    assert len(cli) == 7 and all(command.endswith(" --profile eu") for command in cli)


def test_after_a_region_teardown_the_redeploy_steps_read_the_region_file(sandbox):
    result, _ = region_run(sandbox, "-y", "-p", "eu")
    assert result.returncode == 0, result.stderr
    commands = printed_commands(result.stdout)
    assert commands[0].startswith('eval "$(python3 scripts/bundle_vars.py --export /')
    assert commands[0].endswith('/accelerator.prod-eu.yaml)"')
    bundle = [command for command in commands if command.startswith("databricks bundle ")]
    assert len(bundle) == 6 and all(" -t production " in command and command.endswith(" --profile eu")
                                    for command in bundle)


def test_a_region_teardown_without_a_profile_prints_the_host_the_redeploy_goes_to(sandbox):
    result, _ = region_run(sandbox, "-y")
    assert result.returncode == 0, result.stderr
    commands = printed_commands(result.stdout)
    assert commands[0] == "export DATABRICKS_HOST=https://prod-eu.example.com"
    assert commands[1].startswith('eval "$(python3 scripts/bundle_vars.py --export ')
    assert not any("--profile" in command for command in commands)


def test_the_redeploy_steps_wait_for_the_deleted_app_to_go_before_the_deploy(sandbox):
    result, _ = plain_run(sandbox, "-y", "-p", "eu", accelerator=ACCELERATOR + "app:\n  name: my-watchdog\n")
    wait = "databricks apps get my-watchdog --profile eu"
    assert wait in printed_commands(result.stdout) and "does not exist" in result.stdout
    assert result.stdout.index(wait) < result.stdout.index("databricks bundle deploy -t dev")


def test_dropping_the_lakebase_project_says_how_to_undo_it_within_7_days(sandbox):
    result, calls = plain_run(sandbox, "--drop-lakebase", "-y", "-p", "eu")
    assert result.returncode == 0, result.stderr
    assert calls[-1] == "postgres delete-project projects/jobs-watchdog --profile eu"  # the same soft delete as before
    assert "databricks postgres undelete-project projects/jobs-watchdog --profile eu" in result.stdout
    assert "7 days" in result.stdout and "--purge" in result.stdout


def test_any_bundle_target_can_be_torn_down(sandbox):
    result, calls = run(sandbox, [], "-t", "scratch", "-y")
    assert result.returncode == 0, result.stderr
    assert "bundle destroy -t scratch --auto-approve" in calls


def test_help_says_any_target_works_and_what_a_deleted_app_leaves_behind(sandbox):
    out = subprocess.run(["bash", str(sandbox / "teardown.sh"), "-h"], capture_output=True, text=True).stdout
    assert "dev|demo|production" not in out and "any target in databricks.yml" in out
    assert "/Workspace/Users/<old client ID>" in out
    assert "undelete-project" in out and "--purge" in out
