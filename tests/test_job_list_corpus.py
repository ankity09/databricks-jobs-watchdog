"""The shared job-list corpus: the Python rules must give the expected result for every file.

The Watchdog app runs the same files through its TypeScript port of these rules
(app/shared/joblist/rules.test.ts), so the two rule sets cannot drift apart.
stored.json holds the form the app stores each loadable file in (its TypeScript
test pins it); the scan reads that form, so it must mean the same as the YAML.
"""

import json
from pathlib import Path

import pytest

from jobs_watchdog.config import (
    ConfigError,
    load_monitored_jobs,
    load_monitored_workspaces,
    parse_monitored_jobs,
    parse_monitored_workspaces,
)

CORPUS = Path(__file__).resolve().parent / "fixtures" / "job-lists"
EXPECTED = json.loads((CORPUS / "expected.json").read_text())
STORED = json.loads((CORPUS / "stored.json").read_text())


def load_both(path):
    load_monitored_jobs(path)
    load_monitored_workspaces(path)


def test_every_fixture_has_an_expectation_and_every_expectation_a_fixture():
    assert {p.name for p in CORPUS.glob("*.yml")} == set(EXPECTED)


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_the_python_rules_match_the_corpus(name):
    expected = EXPECTED[name]
    if expected["ok"]:
        load_both(CORPUS / name)
        return
    with pytest.raises(ConfigError) as err:
        load_both(CORPUS / name)
    assert expected["error_contains"] in str(err.value)


def test_every_loadable_fixture_has_its_stored_form():
    assert set(STORED) == {name for name, expected in EXPECTED.items() if expected["ok"]}


@pytest.mark.parametrize("name", sorted(STORED))
def test_the_stored_form_means_the_same_to_the_python_loader_as_the_yaml(name):
    # The scan reads the stored JSON (config_source lakebase); the person imported the YAML.
    assert parse_monitored_jobs(STORED[name], "the stored list") == load_monitored_jobs(CORPUS / name)
    assert parse_monitored_workspaces(STORED[name], "the stored list") == load_monitored_workspaces(CORPUS / name)


def test_the_stored_form_holds_text_where_the_yaml_held_numbers_booleans_and_dates():
    stored = STORED["valid_text_from_other_types.yml"]
    assert [job["job_name"] for job in stored["jobs"]] == ["20241105", "True", "2024-11-05", "750"]
    assert all(isinstance(value, str) for job in stored["jobs"] for key, value in job.items()
               if key in ("job_name", "owner", "notes", "job_name_exclude_regex"))
