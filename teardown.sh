#!/usr/bin/env bash
# Removes what the Watchdog bundle deployed.
#
#   ./teardown.sh [-t dev|demo] [-p profile] [--drop-schema] [-y]
#
# Default: `databricks bundle destroy` for the target, which deletes the
# watchdog_phase_1 job (and, for -t demo, the two demo jobs) and the bundle's
# workspace files.
#
# --drop-schema also drops <catalog>.<schema> with its three tables
# (monitored_jobs, job_dependencies, findings). The bundle does not own the
# schema, because notebook 01 creates it, so it survives a plain teardown and
# keeps your findings history. You type the schema name to confirm unless -y.
#
# Nothing else is created outside the bundle in Phase 1. If you set up a
# service principal, a secret scope, or grants on system tables for the
# Watchdog, remove those yourself (see docs/phase-1-runbook.md).
set -euo pipefail

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; }

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
eval "$(python3 scripts/bundle_vars.py --export)"

destroy_args=(bundle destroy -t "$target")
if $assume_yes; then destroy_args+=(--auto-approve); fi
databricks "${destroy_args[@]}" ${profile_args[@]+"${profile_args[@]}"}

if $drop_schema; then
  schema_name="${BUNDLE_VAR_catalog}.${BUNDLE_VAR_schema}"
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
