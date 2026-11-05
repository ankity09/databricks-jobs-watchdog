"""Validate and deploy the Watchdog in each region.

Usage:
  python3 scripts/deploy_regions.py config/regions
  python3 scripts/deploy_regions.py config/regions/accelerator.prod-eu.yaml --validate-only
  python3 scripts/deploy_regions.py config/regions --only prod-eu --no-app-run

Each region file (accelerator.<region>.yaml) is an accelerator file plus a
deploy section; see docs/multi-region.md. For each region, in turn:

  1. databricks bundle validate --strict -t production
  2. the Watchdog tables and views, if a fresh region lacks them (the copilot's
     Genie agent needs them before the first deploy); --skip-ensure-tables turns
     this off
  3. databricks bundle deploy -t production
  4. databricks bundle run watchdog_app -t production; --no-app-run skips it
  5. databricks bundle run watchdog_app_access -t production: after a teardown
     and a new deploy, it gives the new app access to the job list the teardown
     kept, and otherwise changes nothing; --skip-app-access skips it

--validate-only runs step 1 and nothing else. A failed step skips the rest of
that region and the script carries on with the next one. It prints a summary
table at the end and exits 1 if any step failed, 2 if a region file is wrong.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jobs_watchdog.config import ConfigError  # noqa: E402
from jobs_watchdog.regions import STATEMENTS_API, deploy_steps, load_regions, region_env, region_names  # noqa: E402

POLL_LIMIT_SECONDS = 600
POLL_INTERVAL_SECONDS = 5.0  # between two checks of a statement that has not finished; tests set it to 0
_SECRET_NAME = re.compile(r"SECRET|TOKEN|PASSWORD|CREDENTIAL", re.IGNORECASE)
_TOKEN_SHAPE = re.compile(r"\bdapi[0-9a-zA-Z]{16,}\b")


def redact(text, env):
    """text with secret-looking environment values and personal access tokens hidden."""
    for name, value in env.items():
        if _SECRET_NAME.search(name) and value and len(value) >= 4:
            text = text.replace(value, "***")
    return _TOKEN_SHAPE.sub("***", text)


def _run(argv, env):
    try:
        done = subprocess.run(argv, capture_output=True, text=True, env=env)
    except OSError as err:
        return 127, "", f"could not run {argv[0]!r}: {err}. Install the Databricks CLI and put it on PATH."
    return done.returncode, done.stdout, done.stderr


def _statement_result(argv, env, profile_args):
    """Run a statement API call and wait for it. Returns (ok, message, response)."""
    code, out, err = _run(argv, env)
    if code != 0:
        return False, (err or out).strip(), None
    deadline = time.monotonic() + POLL_LIMIT_SECONDS
    while True:
        try:
            response = json.loads(out)
        except ValueError:
            return False, f"unreadable response from the statement API: {out.strip()[:200]}", None
        status = response.get("status") or {}
        state = status.get("state")
        if state == "SUCCEEDED":
            return True, "", response
        if state in ("PENDING", "RUNNING"):
            if time.monotonic() > deadline:
                return False, "the statement did not finish in 10 minutes", None
            time.sleep(POLL_INTERVAL_SECONDS)
            code, out, err = _run(["databricks", "api", "get", f"{STATEMENTS_API}/{response.get('statement_id', '')}"]
                                  + profile_args, env)
            if code != 0:
                return False, (err or out).strip(), None
            continue
        message = (status.get("error") or {}).get("message") or f"statement ended as {state}"
        return False, message, None


def run_step(step, env):
    """Returns (result, detail): result is ok, exists or FAILED."""
    profile_args = step.argv[-2:] if step.argv[-2:-1] == ["--profile"] else []
    if step.only_if_missing:
        ok, message, response = _statement_result(step.only_if_missing, env, profile_args)
        if not ok:
            return "FAILED", message
        rows = ((response.get("result") or {}).get("data_array")) or []
        if rows:
            return "exists", ""
    if step.argv[1:3] == ["api", "post"]:
        ok, message, _ = _statement_result(step.argv, env, profile_args)
        return ("ok", "") if ok else ("FAILED", message)
    code, out, err = _run(step.argv, env)
    if code == 0:
        return "ok", ""
    return "FAILED", "\n".join(((err or "") + (out or "")).strip().splitlines()[-20:])


def deploy_region(region, args, results):
    env = region_env(region, os.environ)
    # A profile named in the environment could send this deploy to another workspace than the region's host.
    if env.pop("DATABRICKS_CONFIG_PROFILE", None):
        print(f"[{region.name}] ignoring DATABRICKS_CONFIG_PROFILE from the environment; "
              f"this region deploys to {region.host}.", file=sys.stderr, flush=True)
    steps = deploy_steps(region, args.validate_only, not args.no_app_run, not args.skip_ensure_tables,
                         not args.skip_app_access)
    failed = False
    for step in steps:
        if failed:
            results.append((region.name, step.label, "skipped"))
            continue
        print(f"[{region.name}] {step.label} ...", flush=True)
        result, detail = run_step(step, env)
        results.append((region.name, step.label, result))
        if result == "FAILED":
            failed = True
            print(f"[{region.name}] {step.label} failed:\n{redact(detail, env)}", file=sys.stderr, flush=True)
    return not failed


def summary(results):
    rows = [("region", "step", "result")] + results
    widths = [max(len(row[i]) for row in rows) for i in range(3)]
    lines = [" | ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)).rstrip() for row in rows]
    lines.insert(1, "-+-".join("-" * width for width in widths))
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="+", help="region files, or folders holding accelerator.<region>.yaml files")
    parser.add_argument("--only", help="deploy one region: the part of the file name between accelerator. and .yaml; "
                        "only that region's file is read and checked")
    parser.add_argument("--validate-only", action="store_true", help="run bundle validate and nothing else")
    parser.add_argument("--no-app-run", action="store_true", help="deploy the bundle but do not run bundle run watchdog_app")
    parser.add_argument("--skip-ensure-tables", action="store_true",
                        help="do not create the Watchdog tables and views before the deploy")
    parser.add_argument("--skip-app-access", action="store_true",
                        help="do not run the watchdog_app_access job after the deploy")
    args = parser.parse_args(argv)
    try:
        regions = load_regions(args.paths, only=args.only)
        if args.only and not regions:
            print(f"deploy_regions: no region named {args.only!r}; found {', '.join(region_names(args.paths))}",
                  file=sys.stderr)
            return 2
    except ConfigError as err:
        print(f"deploy_regions: {err}", file=sys.stderr)
        return 2
    results = []
    all_ok = True
    for region in regions:
        all_ok = deploy_region(region, args, results) and all_ok
    print()
    print(summary(results))
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
