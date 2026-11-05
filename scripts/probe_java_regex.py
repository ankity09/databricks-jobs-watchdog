"""Check the java column of tests/fixtures/regex-patterns.json against Spark's regexp_like, and refresh it.

Usage:
  python3 scripts/probe_java_regex.py --warehouse-id <warehouse ID> --profile <profile>
  python3 scripts/probe_java_regex.py --warehouse-id <warehouse ID> --profile <profile> --check

Why: the system-table scan matches job names with Spark SQL's regexp_like, which
compiles each pattern as Java regex, and one pattern Java refuses fails that scan
for every job. So the loader (jobs_watchdog/java_regex.py) and the app
(app/shared/joblist/javaregex.ts) refuse such patterns. The java field of
regex-patterns.json pins what both say about each pattern some Python from 3.10
to 3.14 compiles: null when Java compiles it, else the construct Java stops at.
One answer is policy, not Java's: every \\N{...} is refused, also where Java
knows the name.

What it does: for each of those patterns it runs
SELECT regexp_like('x', <pattern>) on the warehouse through the Databricks CLI,
which reads no table and changes nothing (the pattern goes hex-encoded, so NUL
and line separators arrive intact). It works out each row's java value with
java_regex.py and compares. When every answer agrees, it writes the column back
and names the rows that changed. When an answer disagrees, it lists the patterns
and writes nothing: fix the check in both ports, then run it again. With --check
it only compares, and exits 1 when the column would change or an answer
disagrees.

When to run it: after you add rows to regex-patterns.json or change the Java
check, and after the SQL warehouses move to a new Spark or Java version (see the
Databricks SQL release notes). Java's regex has changed between versions (JDK 9
added \\N{...} names and \\b{g}), and the checks follow JDK 17. pytest checks
java_regex.py against the column on every run, and vitest checks javaregex.ts,
but neither can reach a warehouse.

It needs the Databricks CLI (1.23 or newer) signed in with the profile, CAN USE
on a Pro or Serverless SQL warehouse in that workspace, and Python 3.10 or newer.
A run takes a few minutes.
"""

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jobs_watchdog.java_regex import NAMED_CHARACTER, java_regex_problem  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "regex-patterns.json"
STATEMENTS_API = "/api/2.0/sql/statements"
STATEMENT = "SELECT regexp_like('x', decode(unhex(:pattern_hex), 'UTF-8')) AS compiles"
REFUSED = "INVALID_PARAMETER_VALUE.PATTERN"  # regexp_like's error for a pattern Java cannot compile
POLL_SECONDS = 2.0
POLL_LIMIT_SECONDS = 300
ATTEMPTS = 3
# Characters json.dumps writes raw that editors and str.splitlines() take for line breaks; the file escapes them.
ESCAPED = (0x85, 0x2028, 0x2029, 0xFFFF)
_MISSING = object()


def some_python_compiles(row):
    """True when Python 3.10 to 3.14, or some of them, compile the row's pattern: the rows with a java field."""
    return row["error"] is None or any(verdict is None for verdict in row.get("python", {}).values())


def dump_fixture(data):
    """The fixture's text, one pattern row per line, as the file is kept."""
    rows = [json.dumps(row, ensure_ascii=False) for row in data["patterns"]]
    lines = ["{", f' "about": {json.dumps(data["about"], ensure_ascii=False)},', f' "versions": {json.dumps(data["versions"])},',
             ' "patterns": [', *[f"  {row}," for row in rows[:-1]], f"  {rows[-1]}", " ]", "}"]
    text = "\n".join(lines) + "\n"
    for code in ESCAPED:
        text = text.replace(chr(code), "\\u%04x" % code)
    return text


def _cli(argv):
    done = subprocess.run(argv, capture_output=True, text=True)
    return done.returncode, done.stdout, done.stderr


def regexp_like_compiles(pattern, warehouse_id, profile_args):
    """True when regexp_like compiles the pattern, False when it refuses it. Raises RuntimeError on any other answer."""
    body = {"warehouse_id": warehouse_id, "statement": STATEMENT, "wait_timeout": "30s", "disposition": "INLINE",
            "format": "JSON_ARRAY", "parameters": [{"name": "pattern_hex", "value": pattern.encode("utf-8").hex(), "type": "STRING"}]}
    argv = ["databricks", "api", "post", STATEMENTS_API, "--json", json.dumps(body)] + profile_args
    for _ in range(ATTEMPTS):
        code, out, err = _cli(argv)
        if code == 0:
            break
    else:
        raise RuntimeError(f"the statement API call failed: {(err or out).strip()[-300:]}")
    deadline = time.monotonic() + POLL_LIMIT_SECONDS
    polls = 0
    while True:
        try:
            response = json.loads(out)
        except ValueError:
            raise RuntimeError(f"unreadable answer from the statement API: {out.strip()[:200]}") from None
        status = response.get("status") or {}
        state = status.get("state")
        if state == "SUCCEEDED":
            return True
        if state == "FAILED":
            message = (status.get("error") or {}).get("message") or ""
            if REFUSED in message:
                return False
            raise RuntimeError(f"the statement for {pattern!r} failed: {message[:300]}")
        if state not in ("PENDING", "RUNNING"):
            raise RuntimeError(f"the statement for {pattern!r} ended as {state}")
        if time.monotonic() > deadline:
            raise RuntimeError(f"the statement for {pattern!r} did not finish in {POLL_LIMIT_SECONDS} seconds")
        if polls:
            time.sleep(POLL_SECONDS)
        polls += 1
        code, out, err = _cli(["databricks", "api", "get", f"{STATEMENTS_API}/{response.get('statement_id', '')}"] + profile_args)
        if code != 0:
            raise RuntimeError(f"polling the statement failed: {(err or out).strip()[-300:]}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--warehouse-id", required=True, help="the SQL warehouse that runs the statements")
    parser.add_argument("--profile", default="", help="the Databricks CLI profile to sign in with (default: the CLI's default)")
    parser.add_argument("--check", action="store_true", help="only compare; exit 1 if the column would change")
    parser.add_argument("--fixture", default=str(FIXTURE), help="the regex fixture (default: the repo's)")
    parser.add_argument("--threads", type=int, default=8, help="statements at a time (default: 8)")
    args = parser.parse_args(argv)
    path = Path(args.fixture)
    data = json.loads(path.read_text())
    rows = [row for row in data["patterns"] if some_python_compiles(row)]
    profile_args = ["--profile", args.profile] if args.profile else []
    try:
        with ThreadPoolExecutor(args.threads) as pool:
            compiles = list(pool.map(lambda row: regexp_like_compiles(row["pattern"], args.warehouse_id, profile_args), rows))
    except RuntimeError as err:
        print(f"probe_java_regex: {err}. Nothing was written.", file=sys.stderr)
        return 2
    print(f"{len(rows)} patterns checked with regexp_like: {compiles.count(False)} refused, {compiles.count(True)} compile.")
    disagree, changed = [], []
    for row, ok in zip(rows, compiles):
        construct = java_regex_problem(row["pattern"])
        if (construct is None) != ok and construct != NAMED_CHARACTER:
            disagree.append(f"  {row['pattern']!r}: regexp_like {'compiles' if ok else 'refuses'} it, "
                            f"and the check says {construct or 'it compiles'}")
        if row.get("java", _MISSING) != construct:
            changed.append(f"  {row['pattern']!r}: {row.get('java', 'no java field')!r} -> {construct!r}")
        row["java"] = construct
    for row in data["patterns"]:
        if not some_python_compiles(row) and "java" in row:
            changed.append(f"  {row['pattern']!r}: no Python compiles it, so it has no java field")
            del row["java"]
    if disagree:
        print("regexp_like and jobs_watchdog/java_regex.py disagree on these. Fix the check in java_regex.py and "
              "app/shared/joblist/javaregex.ts, then run this again. Nothing was written.")
        print("\n".join(disagree))
        return 1
    if args.check:
        if changed:
            print("The java column is out of date; run this without --check to refresh it:")
            print("\n".join(changed))
            return 1
        print("The java column is up to date.")
        return 0
    path.write_text(dump_fixture(data))
    if changed:
        print(f"Wrote the java column to {path}; it changed for:")
        print("\n".join(changed))
    else:
        print(f"The java column in {path} was up to date.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
