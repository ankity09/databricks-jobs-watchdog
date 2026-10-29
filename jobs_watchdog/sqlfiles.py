"""Load the repo's one-statement SQL files and run them with named parameters.

Each file under sql/ holds exactly one statement. Object names reach SQL
only through IDENTIFIER(:catalog || '.' || :schema || '.<table>'), and every
value is a named parameter, so the same file runs in a notebook (through
spark.sql with args) and in the SQL editor (which shows parameter fields).
"""

import re
from pathlib import Path

from jobs_watchdog.identifiers import validate_identifier

ALLOWED_PARAMS = {"catalog", "schema", "region", "lookback_hours", "scan_id", "code_version_tag"}
_PARAM = re.compile(r"(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)")


def repo_root():
    """The repository root (the folder that holds sql/ and notebooks/)."""
    return Path(__file__).resolve().parents[1]


def _code_only(text):
    """Return text with comments and string literals blanked out."""
    out, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if text.startswith("--", i):
            end = text.find("\n", i)
            i = n if end == -1 else end
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        if ch == "'":
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == "'":
                    break
                j += 1
            out.append("''")
            i = j + 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def parameters(text):
    """Names of the named parameter markers a statement uses."""
    return set(_PARAM.findall(_code_only(text)))


def load_sql(relpath):
    """Read a SQL file relative to the repo root, without its final semicolon."""
    text = (repo_root() / relpath).read_text().rstrip()
    if text.endswith(";"):
        text = text[:-1].rstrip()
    if ";" in _code_only(text):
        raise ValueError(f"{relpath} must hold exactly one statement")
    return text


def run_sql(spark, relpath, **params):
    """Run one SQL file with named parameters and return the DataFrame."""
    unknown = set(params) - ALLOWED_PARAMS
    if unknown:
        raise ValueError(f"unknown SQL parameters {sorted(unknown)}; allowed are {sorted(ALLOWED_PARAMS)}")
    for key in ("catalog", "schema"):
        if key in params:
            validate_identifier(params[key], key)
    text = load_sql(relpath)
    used = parameters(text)
    missing = used - set(params)
    if missing:
        raise ValueError(f"{relpath} needs parameters {sorted(missing)}")
    return spark.sql(text, args={key: params[key] for key in sorted(used)})
