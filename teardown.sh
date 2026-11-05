#!/usr/bin/env bash
# Removes what the Watchdog bundle deployed.
#
#   ./teardown.sh [-t dev|demo|production] [-p profile] [-c accelerator-file] [--drop-schema] [--drop-lakebase] [-y]
#
# -c reads the settings from that file instead of accelerator.local.yaml; use it
# with a region file to tear down one region's Watchdog (docs/multi-region.md).
#
# Default: `databricks bundle destroy` for the target, which deletes the
# watchdog_phase_1, watchdog_scan, watchdog_cleanup and watchdog_app_access jobs (and, for -t demo,
# the four demo jobs), the Watchdog app (watchdog_app), the copilot's MLflow
# experiment and the bundle's workspace files. It does not delete the dashboard
# from notebook 08; move that to the trash in the workspace yourself.
#
# The Lakebase project, its database and the database's owner role (watchdog_db,
# watchdog_database and watchdog_owner) are unbound from the bundle first, so a
# plain teardown keeps them and the job list the app holds survives. Without -y
# teardown asks once before it changes anything; after a plain teardown it prints
# the bind commands for deploying again with the list kept.
# --drop-lakebase also deletes the project, with everything in it, after the
# destroy. You type the project ID to confirm unless -y.
#
# --drop-schema also drops <catalog>.<schema> with its tables and view
# (monitored_jobs, job_dependencies, findings, monitored_workspaces,
# monitored_job_environments, config_loads and findings_latest;
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

# need_value "$@": stops with a message when the option in $1 has no value after it.
need_value() {
  if [[ $# -lt 2 ]]; then echo "teardown.sh: $1 needs a value" >&2; exit 2; fi
}

target="dev"
drop_schema=false
drop_lakebase=false
assume_yes=false
profile_args=()
config=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target) need_value "$@"; target="$2"; shift 2 ;;
    -p|--profile) need_value "$@"; profile_args=(--profile "$2"); shift 2 ;;
    -c|--config) need_value "$@"; config="$2"; shift 2 ;;
    --drop-schema) drop_schema=true; shift ;;
    --drop-lakebase) drop_lakebase=true; shift ;;
    -y|--yes) assume_yes=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "teardown.sh: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ -n "$config" ]]; then
  if [[ ! -f "$config" ]]; then echo "teardown.sh: the config file $config does not exist" >&2; exit 2; fi
  config="$(cd "$(dirname "$config")" && pwd)/$(basename "$config")"
fi
cd "$(dirname "$0")"
vars="$(python3 scripts/bundle_vars.py --export ${config:+"$config"})" || exit 2
eval "$vars"
schema_name="${BUNDLE_VAR_catalog}.${BUNDLE_VAR_schema}"
lakebase_project="${BUNDLE_VAR_lakebase_project_id:-jobs-watchdog}"

if $drop_schema; then
  listing="$(databricks tables list "$BUNDLE_VAR_catalog" "$BUNDLE_VAR_schema" --include-browse -o json \
    ${profile_args[@]+"${profile_args[@]}"})"
  extra="$(printf '%s' "$listing" | python3 -c '
import json, sys
text = sys.stdin.read().strip()
data = json.loads(text) if text else []
tables = data.get("tables", []) if isinstance(data, dict) else (data or [])
watchdog = {"monitored_jobs", "job_dependencies", "findings", "monitored_workspaces", "monitored_job_environments",
            "config_loads", "findings_latest"}
names = sorted({table.get("name", "") for table in tables} - watchdog)
print(" ".join(names))
')"
  if [[ -n "$extra" ]]; then
    echo "teardown.sh: ${schema_name} also holds other tables (${extra}); not dropping it, and nothing was changed." >&2
    exit 1
  fi
fi

# bundle destroy needs a value for every bundle variable, and warehouse_id has no default.
export BUNDLE_VAR_warehouse_id="${BUNDLE_VAR_warehouse_id:-unused-for-teardown}"

if ! $assume_yes; then
  keep_note="The Lakebase project ${lakebase_project} and its job list are kept (add --drop-lakebase to delete them)."
  if $drop_lakebase; then keep_note="The Lakebase project ${lakebase_project} is deleted afterwards."; fi
  read -r -p "Remove the Watchdog jobs, the app and its experiment from target ${target}? ${keep_note} Type yes to continue: " answer || answer=""
  if [[ "$answer" != "yes" ]]; then
    echo "Nothing was changed."
    exit 0
  fi
fi

# Unbind the Lakebase resources so the destroy leaves them alone. A bundle that
# never deployed them has nothing to unbind, which is fine.
for key in watchdog_database watchdog_owner watchdog_db; do
  databricks bundle deployment unbind "$key" -t "$target" ${profile_args[@]+"${profile_args[@]}"} || true
done

# The person has confirmed above (or passed -y), so the destroy does not ask again.
databricks bundle destroy -t "$target" --auto-approve ${profile_args[@]+"${profile_args[@]}"}

if ! $drop_lakebase; then
  branch="projects/${lakebase_project}/branches/${BUNDLE_VAR_lakebase_branch:-production}"
  echo "The Lakebase project ${lakebase_project} and its job list were kept. To deploy again and keep them,"
  echo "bind them before the next bundle deploy (the resource IDs are the Lakebase resource names):"
  echo "  databricks bundle deployment bind watchdog_db projects/${lakebase_project} -t ${target} --auto-approve"
  echo "  databricks bundle deployment bind watchdog_owner ${branch}/roles/watchdog-owner -t ${target} --auto-approve"
  echo "  databricks bundle deployment bind watchdog_database ${branch}/databases/${BUNDLE_VAR_lakebase_database:-watchdog} -t ${target} --auto-approve"
  echo "Then deploy, start the app, and give the new app's service principal access to the kept list:"
  echo "  databricks bundle deploy -t ${target}"
  echo "  databricks bundle run watchdog_app -t ${target}"
  echo "  databricks bundle run watchdog_app_access -t ${target}"
fi

if $drop_lakebase; then
  confirmed=true
  if ! $assume_yes; then
    read -r -p "Delete the Lakebase project ${lakebase_project} and everything in it? Type ${lakebase_project} to confirm: " answer
    [[ "$answer" == "$lakebase_project" ]] || confirmed=false
  fi
  if $confirmed; then
    databricks postgres delete-project "projects/${lakebase_project}" ${profile_args[@]+"${profile_args[@]}"}
    echo "Deleted the Lakebase project ${lakebase_project}."
  else
    echo "Lakebase project kept."
  fi
fi

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
