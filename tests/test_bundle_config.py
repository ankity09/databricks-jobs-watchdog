import yaml

from jobs_watchdog.settings import WIDGETS
from jobs_watchdog.sqlfiles import repo_root

JOB_FILE = repo_root() / "resources" / "watchdog_phase_1.job.yml"


def load_job():
    return yaml.safe_load(JOB_FILE.read_text())["resources"]["jobs"]["watchdog_phase_1"]


def load_bundle():
    return yaml.safe_load((repo_root() / "databricks.yml").read_text())


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
