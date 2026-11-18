"""Where teardown.sh sends a teardown, as shell lines for it to eval.

Usage:
  python3 scripts/region_host.py [--config accelerator-file] [--profile profile]

With a region file (an accelerator file with deploy.workspace_host), every call
goes to that workspace: it prints the profile to use, or exports
DATABRICKS_HOST and unsets DATABRICKS_CONFIG_PROFILE. If DATABRICKS_HOST or a
profile points at another workspace, or a profile must be checked in a CLI
config file Python cannot read, it says so and exits 2, before teardown.sh calls
anything. It always prints teardown_host, for the prompts.
"""

import argparse
import os
import shlex
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jobs_watchdog.config import ConfigError  # noqa: E402
from jobs_watchdog.regions import teardown_target  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", help="the accelerator or region file teardown.sh reads")
    parser.add_argument("--profile", default="", help="the profile given to teardown.sh with -p")
    args = parser.parse_args(argv)
    try:
        target = teardown_target(args.config, args.profile, os.environ)
    except ConfigError as err:
        print(f"teardown.sh: {err}. Nothing was changed.", file=sys.stderr)
        return 2
    if target.note:
        print(f"teardown.sh: {target.note}.", file=sys.stderr)
    lines = [f"teardown_host={shlex.quote(target.host)}", f"teardown_profile={shlex.quote(target.profile)}"]
    if target.checked and not target.profile:
        lines += [f"export DATABRICKS_HOST={shlex.quote(target.host)}", "unset DATABRICKS_CONFIG_PROFILE"]
    elif target.checked:
        lines.append("unset DATABRICKS_HOST")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
