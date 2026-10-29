#!/usr/bin/env bash
# Removes what the Watchdog bundle deployed.
#
#   ./teardown.sh [-t dev|demo] [-p profile] [--drop-schema] [-y]
#
# Default: `databricks bundle destroy` for the target, which deletes the
# watchdog_phase_1 and watchdog_scan jobs (and, for -t demo, the four demo
# jobs) and the bundle's workspace files. It does not delete the dashboard
# from notebook 08; move that to the trash in the workspace yourself.
#
# --drop-schema also drops <catalog>.<schema> with its tables and view
# (monitored_jobs, job_dependencies, findings, monitored_workspaces,
# monitored_job_environments and findings_latest;
# jobs_watchdog.upgrade.watchdog_objects). The bundle does not own the
# schema, because notebook 01 creates it, so it survives a plain teardown and
# keeps your findings history. You type the schema name to confirm unless -y.
# If the schema holds any other table, teardown stops before changing
# anything, even with -y, so a schema shared with other work is never dropped.
#
# Nothing else is created outside the bundle in Phase 1. If you set up a
# service principal, a secret scope, or grants on system tables for the
# Watchdog, remove those yourself (see docs/phase-1-runbook.md).
set -euo pipefail

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

target="dev"
drop_schema=false
assume_yes=false
profile_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target) target="$2"; shift 2 ;;
    -p|--profile) profile_args=(--profile "$2"); shift 2 ;;
    --drop-schema) drop_schema=true; shift ;;
    -y|--yes) assume_yes=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "teardown.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")"
vars="$(python3 scripts/bundle_vars.py --export)" || exit 2
eval "$vars"
schema_name="${BUNDLE_VAR_catalog}.${BUNDLE_VAR_schema}"

if $drop_schema; then
  listing="$(databricks tables list "$BUNDLE_VAR_catalog" "$BUNDLE_VAR_schema" --include-browse -o json \
    ${profile_args[@]+"${profile_args[@]}"})"
  extra="$(printf '%s' "$listing" | python3 -c '
import json, sys
text = sys.stdin.read().strip()
data = json.loads(text) if text else []
tables = data.get("tables", []) if isinstance(data, dict) else (data or [])
watchdog = {"monitored_jobs", "job_dependencies", "findings", "monitored_workspaces", "monitored_job_environments",
            "findings_latest"}
names = sorted({table.get("name", "") for table in tables} - watchdog)
print(" ".join(names))
')"
  if [[ -n "$extra" ]]; then
    echo "teardown.sh: ${schema_name} also holds other tables (${extra}); not dropping it, and nothing was changed." >&2
    exit 1
  fi
fi

destroy_args=(bundle destroy -t "$target")
if $assume_yes; then destroy_args+=(--auto-approve); fi
databricks "${destroy_args[@]}" ${profile_args[@]+"${profile_args[@]}"}

if $drop_schema; then
  if ! $assume_yes; then
    read -r -p "Drop ${schema_name} and every table in it? Type ${schema_name} to confirm: " answer
    if [[ "$answer" != "$schema_name" ]]; then
      echo "Schema kept."
      exit 0
    fi
  fi
  databricks schemas delete "$schema_name" --force ${profile_args[@]+"${profile_args[@]}"}
  echo "Dropped ${schema_name}."
fi
