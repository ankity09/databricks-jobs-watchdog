"""tests/fixtures/regex-patterns.json says what Python's re.compile makes of each pattern.

The Python loader checks job_name_regex and job_name_exclude_regex with
re.compile, on whatever Python the scan's serverless compute runs (3.10 in our
test workspace, newer elsewhere). The Watchdog app checks patterns with a port
of Python's parser (app/shared/joblist/pyregex.ts) that accepts a pattern only
when Python 3.10 to 3.14 all compile it; its test reads this file. This test
keeps the file true to the Python it runs on: a row's verdict for this version
is its python entry for the version, else its error.

Both then check that the system-table scan's Java regex (Spark's regexp_like)
can run the pattern: jobs_watchdog/java_regex.py here, javaregex.ts in the app.
A row's java field is that check's verdict, pinned against regexp_like;
scripts/probe_java_regex.py asks a SQL warehouse again and refreshes it.
"""

import json
import re
import sys
import warnings
from pathlib import Path

import pytest

from jobs_watchdog.java_regex import NAMED_CHARACTER, java_regex_problem

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


def compiles_somewhere(row):
    return row["error"] is None or any(verdict is None for verdict in row.get("python", {}).values())


def test_every_pattern_some_python_compiles_has_a_java_verdict_and_only_those():
    assert [row["pattern"] for row in PATTERNS if compiles_somewhere(row) != ("java" in row)] == []
    java = {row["pattern"]: row["java"] for row in PATTERNS if "java" in row}
    # Java refuses these, and Python 3.10 to 3.14 all compile them
    for refused in ("(?P<x>a)(?P=x)", "a{,3}", "(?#a comment)a", "(?a)\\w", "\\0", "[\\b]", "(a)(?<=\\1)b",
                    "(?<=(?:ab|cd){2})x", "(?x)[ ]", "[a[]", "[&&]", "\\b{gx}", "(?x)a#c\r("):
        assert java[refused], refused
    # and runs these
    for runs in ("(?i)^orders", "\\101", "a{2147483647}", "\\b{g}", "(?<=(?:ab){2})x", "(?x)a{2 }", "[a[b]]", "(?u)\\w"):
        assert java[runs] is None, runs
    assert java["\\N{EM DASH}"] == NAMED_CHARACTER  # policy: Java knows this name, and others it does not


@pytest.mark.skipif(VERSION not in DATA["versions"], reason=f"the fixture covers Python {DATA['versions']}")
@pytest.mark.parametrize("row", [row for row in PATTERNS if "java" in row], ids=lambda row: row["pattern"])
def test_the_java_check_gives_each_pattern_this_python_compiles_its_verdict(row):
    if compile_error(row["pattern"]) is not None:
        pytest.skip(f"Python {VERSION} refuses this pattern, so the loader never asks Java")
    assert java_regex_problem(row["pattern"]) == row["java"]


def test_the_changelog_says_which_patterns_now_fail_to_load_and_why():
    text = (Path(__file__).resolve().parents[1] / "CHANGELOG.md").read_text()
    latest = text[text.index("\n## "):text.index("\n## ", text.index("\n## ") + 1)]
    for words in ("(?P<name>...)", "\\N{...}", "fails to load", "regexp_like", "Java"):
        assert words in latest, words
