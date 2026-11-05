#!/usr/bin/env bash
# Removes what the Watchdog bundle deployed.
#
#   ./teardown.sh [-t dev|demo|production] [-p profile] [-c accelerator-file] [--drop-schema] [--drop-lakebase] [-y]
#
# -c reads the settings from that file instead of accelerator.local.yaml; use it
# with a region file to tear down one region's Watchdog (docs/multi-region.md).
# A region file names its workspace (deploy.workspace_host), and every call goes
# there: if DATABRICKS_HOST, -p, the file's deploy.profile or
# DATABRICKS_CONFIG_PROFILE points at another workspace, teardown stops before
# it changes anything. The prompts name the workspace.
#
# Default: `databricks bundle destroy` for the target, which deletes the
# watchdog_phase_1, watchdog_scan, watchdog_cleanup and watchdog_app_access
# jobs (and, for -t demo, the four demo jobs), the Watchdog app (watchdog_app),
# the copilot's Genie agent with everyone's copilot conversations, and the
# bundle's workspace files. It does not delete the dashboard from notebook 08;
# move that to the trash in the workspace yourself.
#
# The Lakebase project, its database and the database's owner role (watchdog_db,
# watchdog_database and watchdog_owner) are unbound from the bundle first, so a
# plain teardown keeps them and the job list the app holds survives. Without -y
# teardown asks once before it changes anything. Whenever the project is kept
# after the unbind (a plain teardown, a declined --drop-lakebase, or a destroy
# that failed), it prints the commands for deploying again with the list kept.
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

# ask "question": prints the question (also when stdin is not a terminal, which read -p skips)
# and reads one line into answer; end of input reads as no answer.
ask() {
  printf '%s' "$1"
  read -r answer || answer=""
}

# need_value "$@": stops with a message when the option in $1 has no value after it.
need_value() {
  if [[ $# -lt 2 ]]; then echo "teardown.sh: $1 needs a value" >&2; exit 2; fi
}

target="dev"
drop_schema=false
drop_lakebase=false
assume_yes=false
profile=""
config=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target) need_value "$@"; target="$2"; shift 2 ;;
    -p|--profile) need_value "$@"; profile="$2"; shift 2 ;;
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

# Which workspace every call goes to; a region file whose host the shell disagrees with stops here.
host_vars="$(python3 scripts/region_host.py ${config:+--config "$config"} --profile "$profile")" || exit 2
eval "$host_vars"
profile_args=()
if [[ -n "${teardown_profile:-}" ]]; then profile_args=(--profile "$teardown_profile"); fi
where="${teardown_host:+ in ${teardown_host}}"

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
  ask "Remove the Watchdog jobs, the app and the copilot's Genie agent (with everyone's copilot conversations) from target ${target}${where}? ${keep_note} Type yes to continue: "
  if [[ "$answer" != "yes" ]]; then
    echo
    echo "Nothing was changed."
    exit 0
  fi
fi

# After the unbind the bundle no longer holds the Lakebase project. Whenever it is
# still there at the end (a plain teardown, a declined --drop-lakebase, or a
# destroy that failed), say how to deploy again with the job list kept.
unbound=false
project_deleted=false
print_bind_hint() {
  if $unbound && ! $project_deleted; then
    local branch="projects/${lakebase_project}/branches/${BUNDLE_VAR_lakebase_branch:-production}"
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
}
trap print_bind_hint EXIT

# Unbind the Lakebase resources so the destroy leaves them alone. A bundle that
# never deployed them has nothing to unbind, which is fine.
for key in watchdog_database watchdog_owner watchdog_db; do
  databricks bundle deployment unbind "$key" -t "$target" ${profile_args[@]+"${profile_args[@]}"} || true
done
unbound=true

# The person has confirmed above (or passed -y), so the destroy does not ask again.
databricks bundle destroy -t "$target" --auto-approve ${profile_args[@]+"${profile_args[@]}"}

if $drop_lakebase; then
  confirmed=true
  if ! $assume_yes; then
    ask "Delete the Lakebase project ${lakebase_project}${where} and everything in it? Type ${lakebase_project} to confirm: "
    [[ "$answer" == "$lakebase_project" ]] || confirmed=false
  fi
  if $confirmed; then
    databricks postgres delete-project "projects/${lakebase_project}" ${profile_args[@]+"${profile_args[@]}"}
    project_deleted=true
    echo "Deleted the Lakebase project ${lakebase_project}."
  else
    echo "Lakebase project kept."
  fi
fi

if $drop_schema; then
  if ! $assume_yes; then
    ask "Drop ${schema_name}${where} and every table in it? Type ${schema_name} to confirm: "
    if [[ "$answer" != "$schema_name" ]]; then
      echo "Schema kept."
      exit 0
    fi
  fi
  databricks schemas delete "$schema_name" --force ${profile_args[@]+"${profile_args[@]}"}
  echo "Dropped ${schema_name}."
fi
