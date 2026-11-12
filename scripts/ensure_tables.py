"""Create the Watchdog schema, tables and views before the first deploy, if they are missing.

Usage:
  python3 scripts/ensure_tables.py [accelerator.local.yaml] [--profile <your-profile>]

bundle deploy creates the copilot's Genie agent over the Watchdog tables, and
Genie refuses a space over a schema that does not exist. So a fresh workspace
needs the tables first. This runs, through the SQL Statement Execution API on
target.warehouse_id, every file in sql/setup (each CREATE ... IF NOT EXISTS),
then each view in sql/views that is missing, as scripts/deploy_regions.py
does for each region. It is safe to run again. The catalog must exist, and the
identity you sign in as needs USE CATALOG and CREATE SCHEMA on it, and CAN USE
on the warehouse. With no path it reads accelerator.local.yaml when present,
otherwise accelerator.yaml.
"""

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from deploy_regions import redact, run_step  # noqa: E402
from jobs_watchdog.config import ConfigError  # noqa: E402
from jobs_watchdog.regions import ensure_tables_steps, workspace_target  # noqa: E402
from jobs_watchdog.settings import accelerator_file  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", nargs="?", help="accelerator file (default: accelerator.local.yaml, else accelerator.yaml)")
    parser.add_argument("--profile", default="", help="Databricks CLI profile for the workspace")
    args = parser.parse_args(argv)
    path = Path(args.path) if args.path else accelerator_file(ROOT)
    try:
        target = workspace_target(path, args.profile)
    except ConfigError as err:
        print(f"ensure_tables: {err}", file=sys.stderr)
        return 2
    env = dict(os.environ)
    for step in ensure_tables_steps(target):
        print(f"{step.label} ...", flush=True)
        result, detail = run_step(step, env)
        if result == "FAILED":
            print(f"{step.label} failed:\n{redact(detail, env)}", file=sys.stderr, flush=True)
            return 1
        if result == "exists":
            print(f"{step.label}: exists, left as it is", flush=True)
    print(f"{target.catalog}.{target.schema} has the Watchdog tables and views. Next: bundle deploy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
