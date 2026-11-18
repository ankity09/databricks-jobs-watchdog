"""Published examples make workspace and schedule semantics visible in YAML."""
from pathlib import Path

import yaml

from jobs_watchdog.config import load_monitored_jobs, load_monitored_workspaces
from jobs_watchdog.dependencies import dependency_loops, parent_jobs

ROOT = Path(__file__).resolve().parents[1]


def test_default_example_spells_out_the_schedule_type_of_every_job():
    raw = yaml.safe_load((ROOT / "config/monitored_jobs.example.yml").read_text())
    assert all(job.get("schedule_type") in {"scheduled", "continuous", "triggered"} for job in raw["jobs"])
    jobs, _ = load_monitored_jobs(ROOT / "config/monitored_jobs.example.yml")
    assert len([job for job in jobs if job.active]) == 4


def test_workspace_id_example_scopes_jobs_directly_without_enable_overrides():
    path = ROOT / "config/monitored_jobs.workspace-ids.example.yml"
    jobs, deps = load_monitored_jobs(path)
    workspaces = load_monitored_workspaces(path)
    assert len(workspaces) == 2 and len(jobs) == 6
    assert {job.schedule_type for job in jobs} == {"scheduled", "continuous", "triggered"}
    assert all(job.workspace_id is not None and job.enabled and not job.environments for job in jobs)
    assert len([job for job in jobs if job.applies_to("1111111111111111")]) == 3
    assert len([job for job in jobs if job.applies_to("2222222222222222")]) == 3
    assert all(not job.applies_to("3333333333333333") for job in jobs)
    assert not dependency_loops(deps)
    assert parent_jobs(deps) == {"orders_publish_lower": "orders_transform_lower", "orders_publish_production": "orders_transform_production"}
