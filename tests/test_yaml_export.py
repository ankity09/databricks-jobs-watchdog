"""The Watchdog app's YAML export means the same to PyYAML, which the Python loader uses.

app/server/joblist/yaml.test.ts exports a job list whose notes and environment
labels are every scalar of tests/fixtures/yaml-scalars.json plus a few PyYAML
reads as something other than text, and pins the result in
tests/fixtures/yaml-export.json. This test reads that export with PyYAML: each
note and label must come back as the same text.
"""

import json
from pathlib import Path

import yaml

EXPORT = json.loads((Path(__file__).resolve().parent / "fixtures" / "yaml-export.json").read_text())


def test_pyyaml_reads_every_exported_note_back_as_the_same_text():
    loaded = yaml.safe_load(EXPORT["yaml"])
    notes = [job.get("notes") for job in loaded["jobs"] if job["job_name"] != "labels"]
    assert [(type(note).__name__, note) for note in notes] == [("str", text) for text in EXPORT["texts"]]


def test_pyyaml_reads_every_exported_label_back_as_the_same_text():
    loaded = yaml.safe_load(EXPORT["yaml"])
    labels = next(job for job in loaded["jobs"] if job["job_name"] == "labels")["environments"]
    # JavaScript lists integer-like keys such as 0 first, so the order differs; the texts must not
    assert sorted((type(label).__name__, label) for label in labels) == sorted(("str", text) for text in EXPORT["labels"])


def test_the_export_covers_the_awkward_cases():
    assert {"<<", "=", "yes", "1e3", "2024-11-05 10:30:00 +25:00"} <= set(EXPORT["texts"])
