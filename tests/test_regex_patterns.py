"""tests/fixtures/regex-patterns.json says what Python's re.compile makes of each pattern.

The Python loader checks job_name_regex and job_name_exclude_regex with
re.compile. The Watchdog app checks them with a port of Python's parser
(app/shared/joblist/pyregex.ts), whose test reads this file and must agree.
This test keeps the file true to the Python the loader runs on.
"""

import json
import re
import warnings
from pathlib import Path

import pytest

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "regex-patterns.json"
PATTERNS = json.loads(FIXTURE.read_text())["patterns"]


def compile_error(pattern):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            re.compile(pattern)
        except re.error as err:
            return str(err), None
        except Exception as err:  # the loader catches only re.error, so these stop the load too
            return str(err), type(err).__name__
    return None, None


def test_the_fixture_covers_both_directions():
    errors = {row["pattern"]: row["error"] for row in PATTERNS}
    for accepted in ("(?i)^orders", "(?>a)", "a*+"):
        assert errors[accepted] is None
    for refused in ("^orders_\\p{L}+$", "\\k<x>", "^orders\\i", "(?<=prod_.*)orders", "(?<x>a)", "[]"):
        assert errors[refused]


@pytest.mark.parametrize("row", PATTERNS, ids=lambda row: row["pattern"])
def test_python_compiles_each_pattern_as_the_fixture_says(row):
    assert compile_error(row["pattern"]) == (row["error"], row.get("raises"))
