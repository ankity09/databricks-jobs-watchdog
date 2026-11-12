import json

import pytest

from jobs_watchdog.config import ConfigError
from jobs_watchdog.regions import (
    RegionDeploy,
    TeardownTarget,
    deploy_steps,
    load_regions,
    normal_host,
    region_env,
    teardown_target,
)
from jobs_watchdog.sqlfiles import load_sql, repo_root
from jobs_watchdog.upgrade import TABLES, VIEW_TEMPLATES, add_columns_statement, ddl_columns, render_view, view_names

REGION_FILE = """
target:
  catalog: main
  schema: watchdog
  region: eu-west-1
  warehouse_id: abc123
auth:
  mode: current_workspace
app:
  name: watchdog-app
deploy:
  workspace_host: https://example-eu.example.com/
  profile: ""
"""


def write(folder, name, text=REGION_FILE):
    path = folder / name
    path.write_text(text)
    return path


def region(**overrides):
    values = dict(name="prod-eu", path=repo_root() / "accelerator.yaml", host="https://example-eu.example.com",
                  profile="", catalog="main", schema="watchdog", warehouse_id="abc123")
    values.update(overrides)
    return RegionDeploy(**values)


def argv(steps):
    return [step.argv for step in steps]


def statement_body(step_argv):
    assert step_argv[:5] == ["databricks", "api", "post", "/api/2.0/sql/statements", "--json"]
    return json.loads(step_argv[5])


# load_regions


def test_load_regions_reads_a_folder_sorted_by_file_name(tmp_path):
    write(tmp_path, "accelerator.prod-us.yaml")
    write(tmp_path, "accelerator.lower.yaml")
    write(tmp_path, "accelerator.prod-eu.yaml")
    write(tmp_path, "notes.yaml", "nothing: here")
    regions = load_regions([tmp_path])
    assert [r.name for r in regions] == ["lower", "prod-eu", "prod-us"]
    assert regions[0].path == tmp_path / "accelerator.lower.yaml"


def test_load_regions_reads_given_files_and_keeps_their_order_sorted(tmp_path):
    first = write(tmp_path, "accelerator.b.yaml")
    second = write(tmp_path, "accelerator.a.yaml")
    assert [r.name for r in load_regions([first, second])] == ["a", "b"]


def test_load_regions_reads_the_values_a_deploy_needs(tmp_path):
    write(tmp_path, "accelerator.prod-eu.yaml")
    (r,) = load_regions([tmp_path])
    assert (r.catalog, r.schema, r.warehouse_id) == ("main", "watchdog", "abc123")
    assert r.host == "https://example-eu.example.com"  # no trailing slash
    assert r.profile == ""


def test_load_regions_reads_the_profile(tmp_path):
    write(tmp_path, "accelerator.x.yaml", REGION_FILE.replace('profile: ""', "profile: my-profile"))
    assert load_regions([tmp_path])[0].profile == "my-profile"


def test_load_regions_without_files_fails(tmp_path):
    with pytest.raises(ConfigError, match="no accelerator"):
        load_regions([tmp_path])


def test_load_regions_missing_warehouse_names_the_file_and_key(tmp_path):
    write(tmp_path, "accelerator.x.yaml", REGION_FILE.replace("  warehouse_id: abc123\n", ""))
    with pytest.raises(ConfigError) as err:
        load_regions([tmp_path])
    assert "accelerator.x.yaml" in str(err.value) and "target.warehouse_id" in str(err.value)


@pytest.mark.parametrize("host_line", ["", "  workspace_host: ''\n", "  workspace_host: http://insecure.example.com\n",
                                       "  workspace_host: example.example.com\n"])
def test_load_regions_bad_host_names_the_file_and_key(tmp_path, host_line):
    text = REGION_FILE.split("deploy:")[0] + "deploy:\n" + host_line + "  profile: ''\n"
    write(tmp_path, "accelerator.x.yaml", text)
    with pytest.raises(ConfigError) as err:
        load_regions([tmp_path])
    assert "accelerator.x.yaml" in str(err.value) and "deploy.workspace_host" in str(err.value)
    assert "https://" in str(err.value)


def test_load_regions_without_a_deploy_section_fails_on_the_host(tmp_path):
    write(tmp_path, "accelerator.x.yaml", REGION_FILE.split("deploy:")[0])
    with pytest.raises(ConfigError, match="deploy.workspace_host"):
        load_regions([tmp_path])


def test_load_regions_incomplete_accelerator_names_the_file(tmp_path):
    write(tmp_path, "accelerator.x.yaml", REGION_FILE.replace("  catalog: main\n", ""))
    with pytest.raises(ConfigError, match="target.catalog"):
        load_regions([tmp_path])


def test_load_regions_rejects_two_files_with_the_same_name(tmp_path):
    one, two = tmp_path / "one", tmp_path / "two"
    one.mkdir()
    two.mkdir()
    write(one, "accelerator.x.yaml")
    write(two, "accelerator.x.yaml")
    with pytest.raises(ConfigError, match="twice"):
        load_regions([one, two])


def test_the_shipped_example_region_files_load():
    names = [r.name for r in load_regions([repo_root() / "config" / "regions"])]
    assert names == ["example-lower", "example-prod-eu"]


# region_env


def test_region_env_adds_bundle_variables_and_the_host(tmp_path):
    path = write(tmp_path, "accelerator.prod-eu.yaml")
    env = region_env(region(path=path), {"PATH": "/bin"})
    assert env["PATH"] == "/bin"
    assert env["DATABRICKS_HOST"] == "https://example-eu.example.com"
    assert env["BUNDLE_VAR_catalog"] == "main"
    assert env["BUNDLE_VAR_warehouse_id"] == "abc123"
    assert env["BUNDLE_VAR_region"] == "eu-west-1"


def test_region_env_leaves_the_host_to_the_profile_when_one_is_set(tmp_path):
    path = write(tmp_path, "accelerator.prod-eu.yaml")
    env = region_env(region(path=path, profile="my-profile"), {"DATABRICKS_HOST": "https://other.example.com"})
    assert "DATABRICKS_HOST" not in env


def test_region_env_replaces_bundle_variables_left_over_from_another_region(tmp_path):
    path = write(tmp_path, "accelerator.prod-eu.yaml")
    base = {"BUNDLE_VAR_catalog": "stale", "BUNDLE_VAR_secret_scope": "stale", "BUNDLE_VAR_demo_schedule_status": "UNPAUSED"}
    env = region_env(region(path=path), base)
    assert env["BUNDLE_VAR_catalog"] == "main"
    assert "BUNDLE_VAR_secret_scope" not in env
    assert env["BUNDLE_VAR_demo_schedule_status"] == "UNPAUSED"


def test_region_env_does_not_change_the_base_env(tmp_path):
    path = write(tmp_path, "accelerator.prod-eu.yaml")
    base = {"PATH": "/bin"}
    region_env(region(path=path), base)
    assert base == {"PATH": "/bin"}


# deploy_steps


def test_deploy_steps_validate_deploy_run_without_the_table_step():
    steps = deploy_steps(region(), validate_only=False, run_app=True, ensure_tables=False)
    assert argv(steps) == [
        ["databricks", "bundle", "validate", "--strict", "-t", "production"],
        ["databricks", "bundle", "deploy", "-t", "production"],
        ["databricks", "bundle", "run", "watchdog_app", "-t", "production"],
        ["databricks", "bundle", "run", "watchdog_app_access", "-t", "production"],
    ]


def test_deploy_steps_give_the_app_access_to_a_kept_job_list_last_unless_told_not_to():
    steps = deploy_steps(region(), validate_only=False, run_app=False, ensure_tables=False)
    assert [s.label for s in steps][-1] == "app access"
    steps = deploy_steps(region(), validate_only=False, run_app=True, ensure_tables=False, app_access=False)
    assert [s.label for s in steps][-1] == "run app"


def test_deploy_steps_add_the_profile_to_every_command():
    steps = deploy_steps(region(profile="my-profile"), validate_only=False, run_app=True)
    assert all(s.argv[-2:] == ["--profile", "my-profile"] for s in steps)


def test_deploy_steps_validate_only_is_just_the_validate_and_never_touches_tables():
    steps = deploy_steps(region(), validate_only=True, run_app=True)
    assert argv(steps) == [["databricks", "bundle", "validate", "--strict", "-t", "production"]]


def test_deploy_steps_no_app_run_leaves_out_the_app_run():
    steps = deploy_steps(region(), validate_only=False, run_app=False, ensure_tables=False, app_access=False)
    assert [s.argv[1:3] for s in steps] == [["bundle", "validate"], ["bundle", "deploy"]]


def test_deploy_steps_validate_first_then_tables_then_deploy():
    steps = deploy_steps(region(), validate_only=False, run_app=True)
    labels = [s.label for s in steps]
    assert labels[0] == "validate"
    assert labels[-3:] == ["deploy", "run app", "app access"]
    assert all(label.startswith("tables") for label in labels[1:-3])


def test_ensure_tables_runs_every_setup_file_in_sorted_order_with_named_parameters():
    steps = deploy_steps(region(), validate_only=False, run_app=False)
    setup = [s for s in steps
             if s.label.startswith("tables: ") and not s.label.startswith(("tables: view", "tables: columns of "))]
    files = sorted((repo_root() / "sql" / "setup").glob("*.sql"))
    assert len(setup) == len(files)
    for step, path in zip(setup, files):
        body = statement_body(step.argv)
        assert body["statement"] == load_sql(str(path.relative_to(repo_root())))
        assert body["warehouse_id"] == "abc123"
        assert body["wait_timeout"] == "50s"
        assert body["parameters"] == [{"name": "catalog", "value": "main", "type": "STRING"},
                                      {"name": "schema", "value": "watchdog", "type": "STRING"}]
        assert step.only_if_missing is None
        assert step.label.endswith(path.stem)


def test_ensure_tables_upgrades_every_table_after_the_setup_files_and_before_the_views():
    # as notebook 01 does: a view can name a column that only the newer table has
    steps = deploy_steps(region(), validate_only=False, run_app=False)
    tables = [s for s in steps if s.label.startswith("tables: ")]
    kinds = ["view" if s.label.startswith("tables: view ") else "columns" if s.label.startswith("tables: columns of ")
             else "setup" for s in tables]
    assert kinds == sorted(kinds, key=["setup", "columns", "view"].index)
    reads = [s for s in tables if s.label.startswith("tables: columns of ")]
    assert [s.label for s in reads] == [f"tables: columns of {table}" for table, _ in TABLES]
    for step, (table, _) in zip(reads, TABLES):
        body = statement_body(step.argv)
        assert "information_schema.columns" in body["statement"] and "lower(:table)" in body["statement"]
        assert body["parameters"] == [{"name": "catalog", "value": "main", "type": "STRING"},
                                      {"name": "schema", "value": "watchdog", "type": "STRING"},
                                      {"name": "table", "value": table, "type": "STRING"}]
        assert step.follow_up is not None and step.only_if_missing is None


def test_a_findings_table_from_phase_1_2_gets_only_parent_job_added():
    from jobs_watchdog.regions import add_missing_columns

    relpath = dict(TABLES)["findings"]
    declared = ddl_columns(relpath)
    phase_1_2 = [[column.name] for column in declared if column.name != "parent_job"]
    command, done = add_missing_columns(region(profile="my-profile"), "findings", relpath, phase_1_2)
    body = statement_body(command)
    assert body["statement"] == add_columns_statement("findings", [c for c in declared if c.name == "parent_job"])
    assert body["parameters"] == [{"name": "catalog", "value": "main", "type": "STRING"},
                                  {"name": "schema", "value": "watchdog", "type": "STRING"}]
    assert body["warehouse_id"] == "abc123" and command[-2:] == ["--profile", "my-profile"]
    assert done == "added parent_job"


def test_a_current_table_needs_no_upgrade_and_an_unreadable_one_stops_the_step():
    from jobs_watchdog.regions import add_missing_columns

    relpath = dict(TABLES)["findings"]
    # information_schema keeps column names as they were written, so the match ignores case
    assert add_missing_columns(region(), "findings", relpath, [[c.name.upper()] for c in ddl_columns(relpath)]) is None
    # the setup files made sure the table exists, so no columns means the identity cannot see it
    with pytest.raises(ValueError, match=r"cannot see the columns of main\.watchdog\.findings"):
        add_missing_columns(region(), "findings", relpath, [])


def test_ensure_tables_creates_each_view_only_when_it_is_missing():
    steps = deploy_steps(region(), validate_only=False, run_app=False)
    views = [s for s in steps if s.label.startswith("tables: view ")]
    assert [s.label for s in views] == [f"tables: view {name}" for name in view_names()]
    for step, relpath, name in zip(views, VIEW_TEMPLATES, view_names()):
        assert statement_body(step.argv)["statement"] == render_view(relpath, "main", "watchdog")
        check = statement_body(step.only_if_missing)
        assert "information_schema.views" in check["statement"]
        assert check["warehouse_id"] == "abc123"
        assert {"name": "view", "value": name, "type": "STRING"} in check["parameters"]
        assert {"name": "catalog", "value": "main", "type": "STRING"} in check["parameters"]
        assert {"name": "schema", "value": "watchdog", "type": "STRING"} in check["parameters"]


def test_ensure_tables_commands_carry_the_profile():
    steps = deploy_steps(region(profile="my-profile"), validate_only=False, run_app=False)
    for step in steps:
        assert step.argv[-2:] == ["--profile", "my-profile"]
        if step.only_if_missing:
            assert step.only_if_missing[-2:] == ["--profile", "my-profile"]


def test_the_view_statement_is_a_create_or_replace_so_it_must_be_guarded():
    steps = deploy_steps(region(), validate_only=False, run_app=False)
    view = next(s for s in steps if s.only_if_missing)
    assert "CREATE OR REPLACE VIEW" in statement_body(view.argv)["statement"]


def test_the_gitlab_example_has_a_matrix_job_per_stage_and_the_region_script():
    import yaml

    ci = yaml.safe_load((repo_root() / "ci" / "gitlab-ci.example.yml").read_text())
    assert ci["stages"] == ["validate", "deploy"]
    for name in ("validate", "deploy"):
        job = ci[name]
        assert job["parallel"]["matrix"][0]["REGION"]
        assert job["environment"]["name"] == "$REGION"
        assert "scripts/deploy_regions.py config/regions/accelerator.$REGION.yaml" in job["script"][0]
    assert "--validate-only" in ci["validate"]["script"][0]
    assert ci["deploy"]["rules"][0]["when"] == "manual"
    assert ci["variables"]["DATABRICKS_CLI_VERSION"] == "1.23.0"


def test_merge_request_validation_signs_in_without_the_protected_deploy_secret():
    # GitLab gives protected variables only to protected refs, so a merge request never sees the deploy secret.
    # A variable set in Settings outranks a job's variables: block, so the validate job sets both on its
    # command line; otherwise the deploy ID from Settings would go out with the validate secret.
    import yaml

    ci = yaml.safe_load((repo_root() / "ci" / "gitlab-ci.example.yml").read_text())
    assert "variables" not in ci["validate"] and "variables" not in ci["deploy"]
    assert ci["validate"]["script"][0].startswith(
        'DATABRICKS_CLIENT_ID="$VALIDATE_CLIENT_ID" DATABRICKS_CLIENT_SECRET="$VALIDATE_CLIENT_SECRET" '
        "python3 scripts/deploy_regions.py "
    )
    header = (repo_root() / "ci" / "gitlab-ci.example.yml").read_text().split("stages:")[0]
    assert "outranks" in header and "command line" in header


# teardown_target


def test_hosts_compare_without_case_scheme_or_a_trailing_slash():
    assert normal_host("HTTPS://Prod-EU.example.com/") == normal_host("prod-eu.example.com") == "https://prod-eu.example.com"
    assert normal_host("") == "" and normal_host(None) == ""


def test_a_default_profile_is_a_profile_like_any_other(tmp_path):
    config = tmp_path / "databrickscfg"
    config.write_text("[DEFAULT]\nhost = https://prod-eu.example.com\n")
    region_file = write(tmp_path, "accelerator.prod-eu.yaml", REGION_FILE.replace("example-eu.example.com", "prod-eu.example.com"))
    target = teardown_target(region_file, "DEFAULT", {"DATABRICKS_CONFIG_FILE": str(config)})
    assert (target.host, target.profile, target.checked) == ("https://prod-eu.example.com", "DEFAULT", True)


def test_without_a_region_host_nothing_is_checked_and_the_shell_host_is_shown(tmp_path):
    env = {"DATABRICKS_CONFIG_FILE": str(tmp_path / "none"), "DATABRICKS_HOST": "https://a.example.com/"}
    target = teardown_target(None, "", env)
    assert (target.host, target.profile, target.checked) == ("https://a.example.com", "", False)


def test_a_cli_config_python_cannot_read_is_read_only_when_a_region_file_and_a_profile_need_it(tmp_path):
    config = tmp_path / "databrickscfg"
    config.write_text("host = https://prod-eu.example.com\n[eu]\nhost = https://prod-eu.example.com\n")
    env = {"DATABRICKS_CONFIG_FILE": str(config)}
    region_file = write(tmp_path, "accelerator.prod-eu.yaml", REGION_FILE.replace("example-eu.example.com", "prod-eu.example.com"))
    # a region file with no profile checks only the host, and never reads the file
    assert teardown_target(region_file, "", env) == TeardownTarget("https://prod-eu.example.com", "", True)
    # without a region file nothing is checked, so the file only names the workspace, when it can
    plain = teardown_target(None, "eu", env)
    assert (plain.host, plain.checked) == ("", False) and str(config) in plain.note
    # a profile to check against the region's host needs the file
    with pytest.raises(ConfigError, match=r"cannot read .*databrickscfg.* so the profile eu cannot be checked"):
        teardown_target(region_file, "eu", env)


def test_the_view_check_ignores_case_as_information_schema_stores_names_in_lower_case():
    steps = deploy_steps(region(schema="Watchdog"), validate_only=False, run_app=False)
    check = next(s for s in steps if s.only_if_missing)
    body = json.loads(check.only_if_missing[check.only_if_missing.index("--json") + 1])
    assert "lower(:schema)" in body["statement"] and "lower(:view)" in body["statement"]


def test_the_docs_say_what_the_teardown_and_redeploy_test_showed_and_how_to_check_one():
    # A full teardown and redeploy ran on 2026-11-05. The teardown gave the old app's objects to the identity that ran
    # it, and the new app answered no_access until the access job ran, then worked with no restart.
    guide = " ".join((repo_root() / "docs" / "multi-region.md").read_text().split())
    assert "2026-11-05" in guide and "503 `no_access`" in guide and "no restart" in guide
    assert "gives everything it owned to the identity that ran the teardown" in guide
    steps = guide[guide.index("### Check the handover after a redeploy"):]
    assert "has_schema_privilege" in steps and "pg_namespace" in steps and "Job list" in steps
    for name in ("DEPLOY.md", "CHANGELOG.md", "docs/multi-region.md", "docs/app.md", "notebooks/11_grant_app_access.py",
                 "jobs_watchdog/app_access.py", "app/server/db/schema.ts", "resources/watchdog_app_access.job.yml"):
        text = " ".join((repo_root() / name).read_text().split())
        assert "has not been run" not in text and "as Databricks describes" not in text, name
