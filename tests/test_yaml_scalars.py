"""tests/fixtures/yaml-scalars.json says how PyYAML reads each plain scalar.

The Watchdog app's YAML reader must read a job list the way the Python loader
does, so its test (app/shared/joblist/yamlOptions.test.ts) reads every scalar in
this file and checks the same type, str() and repr(). This test keeps the file
true to the PyYAML the loader uses.
"""

import json
from pathlib import Path

import pytest
import yaml

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "yaml-scalars.json"
SCALARS = json.loads(FIXTURE.read_text())["scalars"]


def test_the_fixture_covers_the_awkward_cases():
    texts = {row["text"] for row in SCALARS}
    assert {"y", "n", "1e3", "09", "2024-11-05", "2024-1-5", "12:30", ".inf", "=", "2024-02-30"} <= texts


@pytest.mark.parametrize("row", SCALARS, ids=lambda row: row["text"])
def test_pyyaml_reads_each_scalar_as_the_fixture_says(row):
    try:
        value = yaml.safe_load(f"v: {row['text']}")["v"]
    except Exception as err:
        assert row.get("error") == type(err).__name__
        return
    assert "error" not in row
    assert (type(value).__name__, str(value), repr(value)) == (row["type"], row["str"], row["repr"])
