"""tests/fixtures/regex-patterns.json says what Python's re.compile makes of each pattern.

The Python loader checks job_name_regex and job_name_exclude_regex with
re.compile, on whatever Python the scan's serverless compute runs (3.10 in our
test workspace, newer elsewhere). The Watchdog app checks patterns with a port
of Python's parser (app/shared/joblist/pyregex.ts) that accepts a pattern only
when Python 3.10 to 3.14 all compile it; its test reads this file. This test
keeps the file true to the Python it runs on: a row's verdict for this version
is its python entry for the version, else its error.
"""

import json
import re
import sys
import warnings
from pathlib import Path

import pytest

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "regex-patterns.json"
DATA = json.loads(FIXTURE.read_text())
PATTERNS = DATA["patterns"]
VERSION = f"{sys.version_info.major}.{sys.version_info.minor}"


def compile_error(pattern):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            re.compile(pattern)
        except re.error as err:
            return str(err)
        except Exception as err:  # the loader catches only re.error, so these stop the load too
            return str(err)
    return None


def test_the_fixture_covers_both_directions_and_the_python_versions():
    errors = {row["pattern"]: row["error"] for row in PATTERNS}
    assert errors["(?i)^orders"] is None and errors["(?P<x>a)(?P=x)"] is None
    for refused in ("^orders_\\p{L}+$", "\\k<x>", "^orders\\i", "(?<=prod_.*)orders", "(?<x>a)", "[]"):
        assert errors[refused]
    # newer Pythons accept these, but the 3.10 that serverless notebooks may run refuses them
    for newer in ("(?>a)", "a*+", "\\z"):
        assert errors[newer] and any(v is None for v in next(r for r in PATTERNS if r["pattern"] == newer)["python"].values())
    assert DATA["versions"] == ["3.10", "3.11", "3.12", "3.13", "3.14"]


@pytest.mark.skipif(VERSION not in DATA["versions"], reason=f"the fixture covers Python {DATA['versions']}")
@pytest.mark.parametrize("row", PATTERNS, ids=lambda row: row["pattern"])
def test_this_python_compiles_each_pattern_as_the_fixture_says(row):
    assert compile_error(row["pattern"]) == row.get("python", {}).get(VERSION, row["error"])
