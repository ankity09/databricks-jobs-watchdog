"""Print bundle variables from accelerator.yaml.

Usage:
  eval "$(python3 scripts/bundle_vars.py --export [accelerator.local.yaml])"
  databricks bundle deploy -t dev --profile <your-profile>

Without --export it prints --var flags instead. With no path it uses
accelerator.local.yaml when present, otherwise accelerator.yaml.
"""

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from jobs_watchdog.bundle_vars import as_exports, as_flags, bundle_variables  # noqa: E402
from jobs_watchdog.config import ConfigError  # noqa: E402
from jobs_watchdog.settings import accelerator_file  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", nargs="?", help="accelerator file (default: accelerator.local.yaml, else accelerator.yaml)")
    parser.add_argument("--export", action="store_true", help="print export BUNDLE_VAR_... lines instead of --var flags")
    args = parser.parse_args(argv)
    path = Path(args.path) if args.path else accelerator_file(ROOT)
    try:
        variables = bundle_variables(path)
    except ConfigError as err:
        print(f"bundle_vars: {err}", file=sys.stderr)
        return 2
    print(as_exports(variables) if args.export else as_flags(variables))
    return 0


if __name__ == "__main__":
    sys.exit(main())
