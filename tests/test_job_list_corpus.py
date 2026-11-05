"""The shared job-list corpus: the Python rules must give the expected result for every file.

The Watchdog app runs the same files through its TypeScript port of these rules
(app/shared/joblist/rules.test.ts), so the two rule sets cannot drift apart.
"""

import json
from pathlib import Path

import pytest

from jobs_watchdog.config import ConfigError, load_monitored_jobs, load_monitored_workspaces

CORPUS = Path(__file__).resolve().parent / "fixtures" / "job-lists"
EXPECTED = json.loads((CORPUS / "expected.json").read_text())


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
