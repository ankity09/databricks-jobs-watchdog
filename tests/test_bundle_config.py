import pytest
import yaml

from jobs_watchdog.config import load_monitored_jobs
from jobs_watchdog.settings import WIDGETS
from jobs_watchdog.sqlfiles import repo_root

JOB_FILE = repo_root() / "resources" / "watchdog_phase_1.job.yml"
SCAN_FILE = repo_root() / "resources" / "watchdog_scan.job.yml"
EXAMPLE_CONFIG = repo_root() / "config" / "monitored_jobs.example.yml"
CUSTOM_CHECK = repo_root() / "notebooks" / "09_custom_check_example.py"

# Demo job schedules as Quartz cron expressions, in UTC.
DEMO_SCHEDULES = {
    "watchdog_demo_succeeds": "0 0 * * * ?",  # hourly
    "watchdog_demo_fails": "0 0 0/4 * * ?",  # every 4 hours
    "watchdog_demo_slow": "0 30 0/4 * * ?",  # every 4 hours, 30 minutes past the hour
    "watchdog_demo_retries": "0 0 0/6 * * ?",  # every 6 hours
}


def load_job():
    return yaml.safe_load(JOB_FILE.read_text())["resources"]["jobs"]["watchdog_phase_1"]


def load_scan_job():
    return yaml.safe_load(SCAN_FILE.read_text())["resources"]["jobs"]["watchdog_scan"]


def load_bundle():
    return yaml.safe_load((repo_root() / "databricks.yml").read_text())


def demo_jobs():
    return load_bundle()["targets"]["demo"]["resources"]["jobs"]


def included_jobs():
    """Names of the jobs defined in the resource files that databricks.yml includes."""
    names = set()
    for pattern in load_bundle()["include"]:
        for path in repo_root().glob(pattern):
            names |= set((yaml.safe_load(path.read_text()) or {}).get("resources", {}).get("jobs", {}))
    return names


def test_every_task_notebook_exists():
    for task in load_job()["tasks"]:
        path = (JOB_FILE.parent / task["notebook_task"]["notebook_path"]).resolve()
        assert path.is_file(), task["task_key"]


def test_job_parameters_match_the_notebook_widgets():
    names = {parameter["name"] for parameter in load_job()["parameters"]}
    assert names == set(WIDGETS)


def test_scan_id_is_the_job_run_id():
    defaults = {parameter["name"]: parameter["default"] for parameter in load_job()["parameters"]}
    assert defaults["scan_id"] == "{{job.run_id}}"


def test_live_scan_and_validation_run_even_if_an_earlier_task_fails():
    run_if = {task["task_key"]: task.get("run_if") for task in load_job()["tasks"]}
    assert run_if["scan_jobs_api"] == "ALL_DONE"
    assert run_if["validate_phase_1"] == "ALL_DONE"


def test_bundle_declares_a_variable_for_every_parameter_but_scan_id():
    variables = set(load_bundle()["variables"])
    parameters = {parameter["name"] for parameter in load_job()["parameters"]}
    assert parameters - {"scan_id"} <= variables


def test_demo_target_notebooks_exist():
    jobs = load_bundle()["targets"]["demo"]["resources"]["jobs"]
    for job in jobs.values():
        for task in job["tasks"]:
            assert (repo_root() / task["notebook_task"]["notebook_path"]).resolve().is_file(), task["task_key"]


def test_phase_1_passes_the_code_version_tag():
    names = {parameter["name"] for parameter in load_job()["parameters"]}
    assert "code_version_tag" in names


def test_both_jobs_pass_the_pipeline_url_parameter_setting():
    for job in (load_job(), load_scan_job()):
        defaults = {p["name"]: p["default"] for p in job["parameters"]}
        assert defaults["pipeline_url_parameter"] == "${var.pipeline_url_parameter}"
    assert load_bundle()["variables"]["pipeline_url_parameter"]["default"] == "PIPELINE_URL"
    scan = yaml.safe_load((repo_root() / "accelerator.yaml").read_text())["scan"]
    assert scan["pipeline_url_parameter"] == "PIPELINE_URL"


def test_phase_1_stays_on_demand():
    assert "schedule" not in load_job()


def test_schedule_defaults_are_paused_and_the_scan_runs_every_twenty_minutes():
    variables = load_bundle()["variables"]
    assert variables["scan_schedule_status"]["default"] == "PAUSED"
    assert variables["demo_schedule_status"]["default"] == "PAUSED"
    assert variables["scan_schedule"]["default"] == "0 0/20 * * * ?"
    assert variables["code_version_tag"]["default"] == "code_version"


def test_accelerator_yaml_scan_settings_match_the_bundle_defaults():
    scan = yaml.safe_load((repo_root() / "accelerator.yaml").read_text())["scan"]
    variables = load_bundle()["variables"]
    assert scan["code_version_tag"] == variables["code_version_tag"]["default"]
    assert scan["schedule"] == variables["scan_schedule"]["default"]
    assert scan["schedule_status"] == variables["scan_schedule_status"]["default"]


def test_scan_job_keeps_the_tables_current_then_loads_config_then_scans():
    tasks = load_scan_job()["tasks"]
    assert [task["task_key"] for task in tasks] == ["create_tables", "load_config", "scan_system_tables",
                                                     "scan_jobs_api"]
    depends_on = {task["task_key"]: [dep["task_key"] for dep in task.get("depends_on", [])] for task in tasks}
    assert depends_on == {
        "create_tables": [],
        "load_config": ["create_tables"],
        "scan_system_tables": ["load_config"],
        "scan_jobs_api": ["scan_system_tables"],
    }


def test_both_scans_run_even_if_an_earlier_task_fails():
    run_if = {task["task_key"]: task.get("run_if") for task in load_scan_job()["tasks"]}
    assert run_if["scan_system_tables"] == "ALL_DONE"
    assert run_if["scan_jobs_api"] == "ALL_DONE"


def test_scan_job_runs_the_table_load_and_scan_notebooks():
    paths = {task["task_key"]: task["notebook_task"]["notebook_path"] for task in load_scan_job()["tasks"]}
    assert paths == {
        "create_tables": "../notebooks/01_create_tables.py",
        "load_config": "../notebooks/02_load_config.py",
        "scan_system_tables": "../notebooks/05_scan_system_tables.py",
        "scan_jobs_api": "../notebooks/06_scan_jobs_api.py",
    }


def test_every_scan_task_notebook_exists():
    for task in load_scan_job()["tasks"]:
        assert (SCAN_FILE.parent / task["notebook_task"]["notebook_path"]).resolve().is_file(), task["task_key"]


def test_scan_tasks_run_on_serverless_compute():
    assert "job_clusters" not in load_scan_job()
    for task in load_scan_job()["tasks"]:
        assert not {"job_cluster_key", "existing_cluster_id", "new_cluster"} & set(task), task["task_key"]


def test_scan_id_is_the_scan_job_run_id():
    defaults = {parameter["name"]: parameter["default"] for parameter in load_scan_job()["parameters"]}
    assert defaults["scan_id"] == "{{job.run_id}}"


def test_scan_job_parameters_come_from_the_bundle_variables():
    for parameter in load_scan_job()["parameters"]:
        if parameter["name"] != "scan_id":
            assert parameter["default"] == f"${{var.{parameter['name']}}}", parameter["name"]


def test_scan_job_parameters_are_all_widgets():
    names = {parameter["name"] for parameter in load_scan_job()["parameters"]}
    assert names <= set(WIDGETS)


def test_scan_schedule_uses_the_variables_and_runs_in_utc():
    job = load_scan_job()
    assert job["schedule"] == {
        "quartz_cron_expression": "${var.scan_schedule}",
        "timezone_id": "UTC",
        "pause_status": "${var.scan_schedule_status}",
    }
    assert job["max_concurrent_runs"] == 1


def test_scan_job_is_part_of_every_target():
    assert {"watchdog_phase_1", "watchdog_scan"} <= included_jobs()


def test_demo_target_still_deploys_the_phase_1_job():
    assert "watchdog_phase_1" in included_jobs()
    assert "watchdog_phase_1" not in demo_jobs()


def test_demo_target_has_the_four_sample_jobs():
    assert set(demo_jobs()) == set(DEMO_SCHEDULES)


@pytest.mark.parametrize("name", sorted(DEMO_SCHEDULES))
def test_demo_job_schedule_follows_demo_schedule_status(name):
    assert demo_jobs()[name]["schedule"] == {
        "quartz_cron_expression": DEMO_SCHEDULES[name],
        "timezone_id": "UTC",
        "pause_status": "${var.demo_schedule_status}",
    }


def test_demo_retries_task_allows_two_retries_ten_seconds_apart():
    task = demo_jobs()["watchdog_demo_retries"]["tasks"][0]
    assert task["max_retries"] == 2
    assert task["min_retry_interval_millis"] == 10000


def test_demo_retries_task_passes_its_attempt_number():
    task = demo_jobs()["watchdog_demo_retries"]["tasks"][0]
    assert task["notebook_task"]["base_parameters"]["attempt"] == "{{task.execution_count}}"


def test_demo_notebooks_compile():
    for job in demo_jobs().values():
        for task in job["tasks"]:
            path = repo_root() / task["notebook_task"]["notebook_path"]
            compile(path.read_text(), str(path), "exec")


def test_example_config_has_slow_and_retries_jobs_that_warn():
    jobs = {job.job_name: job for job in load_monitored_jobs(EXAMPLE_CONFIG)[0]}
    assert jobs["watchdog_demo_slow"].enabled
    assert jobs["watchdog_demo_slow"].max_runtime_minutes == 1
    assert jobs["watchdog_demo_retries"].enabled
    assert jobs["watchdog_demo_retries"].max_retries == 1


def test_example_config_makes_succeeds_depend_on_fails():
    _, dependencies = load_monitored_jobs(EXAMPLE_CONFIG)
    assert any(
        (dep.job_name, dep.depends_on, dep.dependency_type) == ("watchdog_demo_succeeds", "watchdog_demo_fails", "job")
        for dep in dependencies
    )


def test_example_config_sets_an_anchored_job_name_exclude_regex_in_defaults():
    import re

    pattern = yaml.safe_load(EXAMPLE_CONFIG.read_text())["defaults"]["job_name_exclude_regex"]
    assert re.search(pattern, "daily_revenue_report_test") and re.search(pattern, "orders_test_prod")
    assert not re.search(pattern, "daily_revenue_report_latest") and not re.search(pattern, "contest_scores")
    assert all(job.job_name_exclude_regex == pattern for job in load_monitored_jobs(EXAMPLE_CONFIG)[0])


def test_example_config_labels_workspaces_and_changes_settings_by_environment():
    raw = yaml.safe_load(EXAMPLE_CONFIG.read_text())
    assert {entry["environment"] for entry in raw["workspaces"]} == {"production", "lower"}
    jobs = {job.job_name: job for job in load_monitored_jobs(EXAMPLE_CONFIG)[0]}
    assert jobs["orders_ingest"].settings_for("production").severity == "CRITICAL"
    assert jobs["orders_ingest"].settings_for("lower").severity == "WARNING"
    assert jobs["orders_ingest"].min_attempt_minutes == 10
    assert jobs["orders_enrich"].settings_for("lower").enabled is False
    assert jobs["daily_revenue_report"].settings_for("lower").owner == "analytics-dev"
    assert jobs["watchdog_demo_succeeds"].owner == "platform-team"  # from the defaults


def test_example_config_regexes_match_the_names_its_comments_describe():
    import re

    jobs = {job.job_name: job for job in load_monitored_jobs(EXAMPLE_CONFIG)[0]}

    def watched(job_name, real_name):
        job = jobs[job_name]
        excluded = job.job_name_exclude_regex and re.search(job.job_name_exclude_regex, real_name)
        return bool(re.search(job.job_name_regex, real_name)) and not excluded

    for real_name in ("orders_ingest_prod", "orders_ingest_eu_prod", "orders_ingest_dev"):
        assert watched("orders_ingest", real_name)
    assert not watched("orders_ingest", "orders_ingest_test_prod")
    assert watched("orders_enrich", "orders_enrich_web_prod") and watched("orders_enrich", "orders_enrich_mobile_eu_dev")
    assert not watched("orders_enrich", "orders_enrich_prod")
    assert watched("daily_revenue_report", "daily_revenue_report_eu_prod")
    assert watched("daily_revenue_export", "daily_revenue_export_prod")


def test_example_config_has_a_child_job_and_service_dependencies():
    _, dependencies = load_monitored_jobs(EXAMPLE_CONFIG)
    kinds = {(dep.job_name, dep.depends_on, dep.dependency_type) for dep in dependencies}
    assert ("daily_revenue_export", "daily_revenue_report", "child_job") in kinds
    assert {dep.depends_on for dep in dependencies if dep.dependency_type == "service"} >= {"kafka", "config_api"}


def test_custom_check_example_compiles_and_writes_custom_rows():
    text = CUSTOM_CHECK.read_text()
    compile(text, str(CUSTOM_CHECK), "exec")
    assert text.startswith("# Databricks notebook source")
    assert "What it does" in text and "What to look for" in text
    assert "CUSTOM" in text and "service_connectivity" in text
    assert "finalize_rows(" in text and "write_findings(" in text


@pytest.mark.parametrize("name", sorted(DEMO_SCHEDULES))
def test_demo_jobs_carry_a_code_version_tag_like_a_ci_deploy(name):
    assert demo_jobs()[name]["tags"]["code_version"] == "${bundle.git.branch}@${bundle.git.commit}"


@pytest.mark.parametrize("name", sorted(DEMO_SCHEDULES))
def test_demo_jobs_carry_a_pipeline_url_parameter_like_a_ci_deploy(name):
    defaults = {p["name"]: p["default"] for p in demo_jobs()[name].get("parameters", [])}
    assert defaults["PIPELINE_URL"] == "${bundle.git.origin_url}"
