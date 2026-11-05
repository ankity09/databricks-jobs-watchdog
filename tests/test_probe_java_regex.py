"""scripts/probe_java_regex.py refreshes the java column of tests/fixtures/regex-patterns.json.

It asks a SQL warehouse whether Spark's regexp_like compiles each pattern. Here a
fake databricks CLI answers instead, from a list of the patterns "Java refuses",
so the tests need no workspace.
"""

import json
import os
import subprocess
import sys

import pytest

from jobs_watchdog.java_regex import NAMED_CHARACTER
from jobs_watchdog.sqlfiles import repo_root

FIXTURE = repo_root() / "tests" / "fixtures" / "regex-patterns.json"
SCRIPT = repo_root() / "scripts" / "probe_java_regex.py"

# Answers the statement API as a warehouse would: the pattern arrives hex-encoded in the
# parameter; a pattern in FAKE_REFUSED fails as regexp_like fails; FAKE_PENDING=1 makes the
# first answer PENDING, and the poll (api get) then gives the result.
FAKE_DATABRICKS = """#!{python}
import json, os, sys
log = os.environ["FAKE_LOG"]
args = sys.argv[1:]
with open(log, "a") as f:
    f.write(json.dumps(args) + "\\n")
refused = set(json.load(open(os.environ["FAKE_REFUSED"])))
def answer(pattern, statement_id):
    if pattern in refused:
        message = "[INVALID_PARAMETER_VALUE.PATTERN] The value of parameter(s) `regexp` in `regexp_like` is invalid"
        return {{"statement_id": statement_id, "status": {{"state": "FAILED", "error": {{"message": message}}}}}}
    return {{"statement_id": statement_id, "status": {{"state": "SUCCEEDED"}}, "result": {{"data_array": [["false"]]}}}}
if args[:3] == ["api", "post", "/api/2.0/sql/statements"]:
    body = json.loads(args[args.index("--json") + 1])
    pattern = bytes.fromhex(body["parameters"][0]["value"]).decode("utf-8")
    if os.environ.get("FAKE_PENDING") == "1":
        print(json.dumps({{"statement_id": body["parameters"][0]["value"], "status": {{"state": "PENDING"}}}}))
    else:
        print(json.dumps(answer(pattern, "s1")))
elif args[:2] == ["api", "get"]:
    hexed = args[2].rsplit("/", 1)[1]
    print(json.dumps(answer(bytes.fromhex(hexed).decode("utf-8"), hexed)))
else:
    sys.exit("unexpected call: " + " ".join(args))
"""


def script():
    sys.path.insert(0, str(repo_root() / "scripts"))
    try:
        import probe_java_regex
    finally:
        sys.path.remove(str(repo_root() / "scripts"))
    return probe_java_regex


# A slice of the fixture for the runs: the \N{...} rows, rows with NUL, U+2029 and U+FFFF, a row only Python
# 3.10 to 3.12 compile, one only 3.11 and later compile, one no Python compiles, and a few plain ones.
KEEP = {"a{,3}", "(?i)^orders", "(?P<x>a)(?P=x)", "\\b{g}", "(?t)a", "(?>a)", "("}
ODD = (0x00, 0x2029, 0xFFFF)


def rows():
    every = json.loads(FIXTURE.read_text())["patterns"]
    return [row for row in every if row["pattern"] in KEEP or "\\N{" in row["pattern"]
            or any(chr(code) in row["pattern"] for code in ODD)]


def java_refused():
    """What the warehouse said: every row with a java construct, except the \\N{...} names, which Java knows."""
    return [row["pattern"] for row in rows() if row.get("java") and row["java"] != NAMED_CHARACTER
            or row["pattern"] in POLICY_REFUSED_BY_JAVA_TOO]


# \N{...} rows Java refuses as well (a Unicode 14 name and an alias); the other \N rows it compiles.
POLICY_REFUSED_BY_JAVA_TOO = ("\\N{MELTING FACE}", "\\N{NBSP}")


@pytest.fixture
def sandbox(tmp_path):
    data = json.loads(FIXTURE.read_text())
    data["patterns"] = rows()
    (tmp_path / "regex-patterns.json").write_text(script().dump_fixture(data))
    (tmp_path / "canonical.json").write_text(script().dump_fixture(data))
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "databricks").write_text(FAKE_DATABRICKS.format(python=sys.executable))
    (bin_dir / "databricks").chmod(0o755)
    (tmp_path / "refused.json").write_text(json.dumps(java_refused()))
    return tmp_path


def probe(sandbox, *args, **env_extra):
    env = dict(os.environ, PATH=f"{sandbox / 'bin'}:{os.environ['PATH']}", FAKE_LOG=str(sandbox / "calls.log"),
               FAKE_REFUSED=str(sandbox / "refused.json"), **env_extra)
    return subprocess.run([sys.executable, str(SCRIPT), "--warehouse-id", "0123456789abcdef", "--profile", "example",
                           "--fixture", str(sandbox / "regex-patterns.json"), *args],
                          capture_output=True, text=True, env=env)


def calls(sandbox):
    return [json.loads(line) for line in (sandbox / "calls.log").read_text().splitlines()]


def test_the_fixture_is_written_in_the_layout_it_is_kept_in():
    text = FIXTURE.read_text()
    assert script().dump_fixture(json.loads(text)) == text


def test_the_slice_holds_every_kind_of_row():
    kinds = rows()
    assert len(kinds) >= 12 and any("java" not in row for row in kinds)
    assert all(any(chr(code) in row["pattern"] for row in kinds) for code in ODD)


def test_when_the_warehouse_agrees_the_column_is_written_back_unchanged(sandbox):
    result = probe(sandbox)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (sandbox / "regex-patterns.json").read_text() == (sandbox / "canonical.json").read_text()
    some_python = [row for row in rows() if "java" in row]
    assert len([c for c in calls(sandbox) if c[:2] == ["api", "post"]]) == len(some_python)
    assert f"{len(some_python)} patterns" in result.stdout


def test_each_call_asks_the_given_warehouse_with_the_given_profile_and_changes_nothing(sandbox):
    probe(sandbox)
    post = next(c for c in calls(sandbox) if c[:2] == ["api", "post"])
    assert post[-2:] == ["--profile", "example"]
    body = json.loads(post[post.index("--json") + 1])
    assert body["warehouse_id"] == "0123456789abcdef"
    assert body["statement"] == "SELECT regexp_like('x', decode(unhex(:pattern_hex), 'UTF-8')) AS compiles"


def test_a_stale_column_is_refreshed(sandbox):
    data = json.loads((sandbox / "regex-patterns.json").read_text())
    row = next(row for row in data["patterns"] if row["pattern"] == "a{,3}")
    row["java"] = None
    (sandbox / "regex-patterns.json").write_text(json.dumps(data))
    result = probe(sandbox)
    assert result.returncode == 0, result.stdout + result.stderr
    assert (sandbox / "regex-patterns.json").read_text() == (sandbox / "canonical.json").read_text()
    assert "a{,3}" in result.stdout


def test_a_pattern_the_warehouse_and_the_check_disagree_on_is_listed_and_nothing_is_written(sandbox):
    (sandbox / "refused.json").write_text(json.dumps(java_refused() + ["(?i)^orders"]))
    before = (sandbox / "regex-patterns.json").read_text()
    result = probe(sandbox)
    assert result.returncode == 1
    assert "(?i)^orders" in result.stdout + result.stderr
    assert (sandbox / "regex-patterns.json").read_text() == before


def test_check_only_compares(sandbox):
    assert probe(sandbox, "--check").returncode == 0
    data = json.loads((sandbox / "regex-patterns.json").read_text())
    next(row for row in data["patterns"] if row["pattern"] == "a{,3}")["java"] = None
    (sandbox / "regex-patterns.json").write_text(json.dumps(data))
    stale = (sandbox / "regex-patterns.json").read_text()
    result = probe(sandbox, "--check")
    assert result.returncode == 1 and "a{,3}" in result.stdout
    assert (sandbox / "regex-patterns.json").read_text() == stale


def test_a_statement_still_running_is_polled(sandbox):
    result = probe(sandbox, FAKE_PENDING="1")
    assert result.returncode == 0, result.stdout + result.stderr
    assert any(c[:2] == ["api", "get"] for c in calls(sandbox))


def test_the_script_holds_no_workspace_id_or_host():
    text = SCRIPT.read_text()
    assert "cloud.databricks.com" not in text and "azuredatabricks" not in text and "gcp.databricks" not in text
    assert "<warehouse ID>" in text and "<profile>" in text
