# Databricks notebook source
# MAGIC %md
# MAGIC # Shared setup
# MAGIC
# MAGIC The other notebooks run this one with `%run ./_setup`. It:
# MAGIC
# MAGIC - finds the repo root and adds it to `sys.path`, so `import jobs_watchdog` works both in a Git folder and in a bundle deployment;
# MAGIC - defines `define_widgets(*names)`, which creates the widgets a notebook needs, with defaults from `accelerator.local.yaml` (or `accelerator.yaml`);
# MAGIC - defines `settings(*names)`, which reads and checks those widgets;
# MAGIC - defines `short_error(err)`, which keeps the first line of an error.
# MAGIC
# MAGIC After you pull new code into the Git folder, restart Python on the notebook (or detach and reattach) so it loads the new `jobs_watchdog` code.

# COMMAND ----------

import os
import sys
from pathlib import Path


def _find_repo_root():
    here = Path(os.getcwd()).resolve()
    for folder in (here, *here.parents):
        if (folder / "jobs_watchdog").is_dir() and (folder / "sql").is_dir():
            return folder
    raise RuntimeError(f"Cannot find the repo root above {here}. Open these notebooks from the repo's notebooks folder.")


REPO_ROOT = _find_repo_root()
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# COMMAND ----------

from jobs_watchdog.settings import read_settings, widget_defaults


def define_widgets(*names):
    """Create text widgets for these settings, defaulting to the accelerator.yaml values."""
    defaults = widget_defaults(REPO_ROOT)
    for name in names:
        dbutils.widgets.text(name, defaults[name], name)


def settings(*names):
    """Read and check the widgets. Raises ValueError that says what to fix."""
    return read_settings({name: dbutils.widgets.get(name) for name in names}, REPO_ROOT)


def short_error(err):
    """The error type and its first line, for PASS and FAIL output."""
    lines = str(err).strip().splitlines()
    return f"{type(err).__name__}: {lines[0][:300] if lines else ''}"
