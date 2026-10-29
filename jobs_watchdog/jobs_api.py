"""Read job health from the Jobs API, one workspace at a time.

For each enabled monitored job, the collector finds the matching jobs in the
workspace (jobs.list plus the job's regex), reads the newest run, pages through
its tasks, and fetches the error text of failed tasks. It returns
findings-shaped dicts with source JOBS_API; findings.finalize_rows fills the
columns that are the same for the whole scan. Nothing here writes to Databricks.

Task paging, error text from get_run_output, and the workspace ID guard are
ported from an earlier pilot collector.
"""

import itertools
import re
from dataclasses import dataclass
from datetime import datetime, timezone

from jobs_watchdog.config import AUTH_MODES
from jobs_watchdog.states import API_FAILED_RESULTS, API_IN_PROGRESS, as_text, failure_category, status_from_api

SOURCE = "JOBS_API"
SUMMARY_CHARS = 1000
_TASK_MESSAGE_CHARS = 400
_NOT_HERE = "No job in this workspace matches {regex}."
_NOWHERE = "No job in any of the {count} workspaces checked matches {regex}."


@dataclass(frozen=True)
class Target:
    """A workspace to scan. host is None when scanning the current workspace."""

    workspace_id: str
    workspace_name: str | None
    host: str | None


class WorkspaceIdMismatch(Exception):
    """The API answered for a different workspace than the target."""


def make_client(mode, host, client_id, client_secret):
    """A WorkspaceClient for one target.

    current_workspace uses the identity running the notebook. service_principal
    signs in to host with OAuth machine-to-machine credentials.
    """
    if mode not in AUTH_MODES:
        raise ValueError(f"unknown auth mode {mode!r}; use current_workspace or service_principal")
    if mode == "service_principal":
        values = (("host", host), ("client_id", client_id), ("client_secret", client_secret))
        missing = [name for name, value in values if not value]
        if missing:
            raise ValueError(f"service_principal mode needs {', '.join(missing)}")

    from databricks.sdk import WorkspaceClient

    if mode == "current_workspace":
        return WorkspaceClient()
    return WorkspaceClient(host=host, client_id=client_id, client_secret=client_secret, auth_type="oauth-m2m")


def resolve_jobs(client, jobs):
    """Match each monitored job's regex against the job names in a workspace.

    Returns (monitored_job, job_id, real_name) tuples: one per matching job, or
    (monitored_job, None, None) when nothing matches. The regex can match
    anywhere in the name, like regexp_like in the system table scan, so it also
    matches names that a bundle's development mode prefixes.
    """
    listed = []
    for job in client.jobs.list(limit=100):
        name = getattr(getattr(job, "settings", None), "name", None)
        if name:
            listed.append((job.job_id, name))
    resolved = []
    for monitored in jobs:
        pattern = re.compile(monitored.job_name_regex)
        hits = [(job_id, name) for job_id, name in listed if pattern.search(name)]
        if hits:
            resolved.extend((monitored, job_id, name) for job_id, name in hits)
        else:
            resolved.append((monitored, None, None))
    return resolved


def collect_target(client, target, jobs, now):
    """Findings rows for one workspace.

    API errors never escape: a workspace that cannot be read gives one
    api_unreachable row per job, and a job that cannot be read gives one
    api_unreachable row for that job while the others are still checked.
    """
    if now.tzinfo is None:
        raise ValueError("now must include a timezone")
    jobs = [job for job in jobs if job.enabled]
    if not jobs:
        return []
    try:
        actual = str(client.get_workspace_id())
        if actual != str(target.workspace_id):
            raise WorkspaceIdMismatch(
                f"WORKSPACE_ID_MISMATCH: the API answered as workspace {actual}, expected {target.workspace_id}"
            )
        resolved = resolve_jobs(client, jobs)
    except Exception as err:
        return [_unreachable(target, job, None, err) for job in jobs]

    rows = []
    for job, job_id, _real_name in resolved:
        if job_id is None:
            summary = _NOT_HERE.format(regex=job.job_name_regex)
            rows.append(_row(target, job, None, "not_found", "UNKNOWN", error_summary=summary))
            continue
        try:
            rows.extend(_job_rows(client, target, job, job_id, now))
        except Exception as err:
            rows.append(_unreachable(target, job, job_id, err))
    return rows


def unreachable_rows(target, jobs, reason):
    """api_unreachable rows for every enabled job, for a workspace that cannot be scanned."""
    return [_row(target, job, None, "api_unreachable", "UNKNOWN", error_summary=reason) for job in jobs if job.enabled]


def explain_job(client, job_id):
    """The Jobs API fields the Watchdog reads, for one job's newest run.

    Notebook 04 shows these as tables: the newest runs from list_runs, every
    task of the newest run from get_run, and the error text of failed tasks
    from get_run_output.
    """
    runs = list(itertools.islice(client.jobs.list_runs(job_id=job_id, limit=2), 2))
    runs.sort(key=lambda item: getattr(item, "start_time", None) or 0, reverse=True)
    if not runs:
        return {"runs": [], "tasks": [], "errors": []}
    run, tasks = _full_run(client, runs[0].run_id)
    errors = []
    for key, task in sorted(_latest_attempts(tasks).items()):
        if not _failed(task):
            continue
        try:
            error = getattr(client.jobs.get_run_output(run_id=task.run_id), "error", None)
        except Exception as err:
            error = f"could not read the output: {type(err).__name__}: {err}"
        errors.append({"task_key": key, "task_run_id": getattr(task, "run_id", None), "error": error})
    return {
        "runs": [_fields(item, run_id=item.run_id, run_page_url=getattr(item, "run_page_url", None)) for item in runs],
        "tasks": [_fields(task, task_key=getattr(task, "task_key", None), task_run_id=getattr(task, "run_id", None),
                          attempt_number=_attempt(task)) for task in tasks],
        "errors": errors,
    }


def merge_not_found(rows, jobs, workspaces_checked):
    """Combine not_found rows from a scan of several workspaces.

    A job found in any workspace keeps none of its not_found rows. A job found
    in none keeps one row, with no workspace when more than one was checked.
    """
    regex = {job.job_name: job.job_name_regex for job in jobs}
    found = {row["job_name"] for row in rows if row.get("job_id") is not None}
    merged, collapsed = [], set()
    for row in rows:
        if row["check_id"] != "not_found":
            merged.append(row)
        elif row["job_name"] in found or row["job_name"] in collapsed:
            continue
        elif workspaces_checked <= 1:
            merged.append(row)
        else:
            collapsed.add(row["job_name"])
            summary = _NOWHERE.format(count=workspaces_checked, regex=regex.get(row["job_name"], row["job_name"]))
            merged.append(dict(row, workspace_id=None, workspace_name=None, error_summary=summary))
    return merged


def _job_rows(client, target, job, job_id, now):
    # list_runs pages through every run of the job, so take only the first two
    runs = list(itertools.islice(client.jobs.list_runs(job_id=job_id, limit=2), 2))
    runs.sort(key=lambda item: getattr(item, "start_time", None) or 0, reverse=True)
    if not runs:
        return [_row(target, job, job_id, "live_run_status", "UNKNOWN", error_summary="The job has no runs.")]
    previous = runs[1] if len(runs) > 1 else None
    run, tasks = _full_run(client, runs[0].run_id)
    latest = _latest_attempts(tasks)
    rows = [
        _live_run_status(target, job, job_id, run, previous),
        _live_task_failures(client, target, job, job_id, run, latest),
    ]
    if job.max_runtime_minutes is not None:
        rows.append(_live_long_runtime(target, job, job_id, run, now))
    if job.max_retries is not None:
        rows.append(_retry_loop(target, job, job_id, run, latest))
    return rows


def _full_run(client, run_id):
    """get_run plus every page of its tasks."""
    run = client.jobs.get_run(run_id=run_id)
    tasks = list(getattr(run, "tasks", None) or [])
    token = getattr(run, "next_page_token", None)
    seen = set()
    while token:
        if token in seen:
            raise ValueError("the Jobs API returned the same task page token twice")
        seen.add(token)
        page = client.jobs.get_run(run_id=run_id, page_token=token)
        tasks.extend(getattr(page, "tasks", None) or [])
        token = getattr(page, "next_page_token", None)
    return run, tasks


def _latest_attempts(tasks):
    """The newest attempt of each task, by task_key."""
    latest = {}
    for task in tasks:
        key = str(getattr(task, "task_key", None) or "unnamed_task")
        if key not in latest or _attempt(task) >= _attempt(latest[key]):
            latest[key] = task
    return latest


def _live_run_status(target, job, job_id, run, previous):
    state = getattr(run, "state", None)
    life_cycle = as_text(getattr(state, "life_cycle_state", None))
    result = as_text(getattr(state, "result_state", None))
    status = status_from_api(life_cycle, result)
    if life_cycle in API_IN_PROGRESS:
        summary = f"Newest run is {life_cycle}."
        before = as_text(getattr(getattr(previous, "state", None), "result_state", None))
        if before:
            summary += f" The run before it ended {before}."
    else:
        summary = f"Newest run ended {result or life_cycle or 'with no state'}."
        message = getattr(state, "state_message", None)
        if message and status != "HEALTHY":
            summary += f" {message}"
    return _row(target, job, job_id, "live_run_status", status, run=run,
                termination_type=_termination_type(run), error_summary=summary)


def _live_task_failures(client, target, job, job_id, run, latest):
    failed = [(key, task) for key, task in sorted(latest.items()) if _failed(task)]
    if not failed:
        return _row(target, job, job_id, "live_task_failures", "HEALTHY", run=run,
                    error_summary="No failed tasks in the newest run.")
    summary = " | ".join(f"{key}: {_task_error(client, task)}" for key, task in failed)
    return _row(target, job, job_id, "live_task_failures", "FAILED", run=run,
                termination_type=_termination_type(failed[0][1]) or _termination_type(run),
                failed_task_keys=[key for key, _task in failed], error_summary=summary)


def _live_long_runtime(target, job, job_id, run, now):
    limit = job.max_runtime_minutes
    life_cycle = as_text(getattr(getattr(run, "state", None), "life_cycle_state", None))
    start_ms = getattr(run, "start_time", None)
    if life_cycle in API_IN_PROGRESS and start_ms:
        minutes = int((now.timestamp() * 1000 - start_ms) // 60000)
        if minutes > limit:
            return _row(target, job, job_id, "live_long_runtime", "WARNING", run=run,
                        error_summary=f"The newest run has been going for {minutes} minutes. The limit is {limit}.")
        summary = f"The newest run has been going for {minutes} minutes, within the {limit}-minute limit."
    else:
        summary = f"No run in progress. The limit is {limit} minutes."
    return _row(target, job, job_id, "live_long_runtime", "HEALTHY", run=run, error_summary=summary)


def _retry_loop(target, job, job_id, run, latest):
    limit = job.max_retries
    over = sorted(key for key, task in latest.items() if _attempt(task) > limit)
    if over:
        return _row(target, job, job_id, "retry_loop", "WARNING", run=run, failed_task_keys=over,
                    error_summary=f"Retried more than {limit} time(s) in the newest run: {', '.join(over)}.")
    return _row(target, job, job_id, "retry_loop", "HEALTHY", run=run,
                error_summary=f"No task retried more than {limit} time(s) in the newest run.")


def _task_error(client, task):
    """The task's error text, or its state message when the output is unreadable."""
    state = getattr(task, "state", None)
    message = getattr(state, "state_message", None) or ""
    run_id = getattr(task, "run_id", None)
    if run_id is not None:
        try:
            output = client.jobs.get_run_output(run_id=run_id)
            message = getattr(output, "error", None) or message
        except Exception:
            pass  # without access to the output, the task's state still stands
    message = " ".join(str(message).split())
    return message[:_TASK_MESSAGE_CHARS] or as_text(getattr(state, "result_state", None)) or "failed"


def _failed(task):
    state = getattr(task, "state", None)
    result = as_text(getattr(state, "result_state", None))
    return result in API_FAILED_RESULTS or as_text(getattr(state, "life_cycle_state", None)) == "INTERNAL_ERROR"


def _fields(item, **first):
    """The state fields of a run or task, after any fields given."""
    state = getattr(item, "state", None)
    details = getattr(getattr(item, "status", None), "termination_details", None)
    start = getattr(item, "start_time", None)
    return {
        **first,
        "start_time": datetime.fromtimestamp(start / 1000, tz=timezone.utc).isoformat() if start else None,
        "life_cycle_state": as_text(getattr(state, "life_cycle_state", None)),
        "result_state": as_text(getattr(state, "result_state", None)),
        "termination_type": as_text(getattr(details, "type", None)),
        "termination_code": as_text(getattr(details, "code", None)),
        "state_message": getattr(state, "state_message", None) or None,
    }


def _attempt(task):
    return getattr(task, "attempt_number", None) or 0


def _termination_type(item):
    details = getattr(getattr(item, "status", None), "termination_details", None)
    return as_text(getattr(details, "type", None))


def _unreachable(target, job, job_id, err):
    summary = str(err) if isinstance(err, WorkspaceIdMismatch) else f"{type(err).__name__}: {err}"
    return _row(target, job, job_id, "api_unreachable", "UNKNOWN", error_summary=summary)


def _row(target, job, job_id, check_id, status, run=None, termination_type=None, failed_task_keys=None,
         error_summary=None):
    run_id = getattr(run, "run_id", None)
    return {
        "workspace_id": str(target.workspace_id),
        "workspace_name": target.workspace_name,
        "job_id": None if job_id is None else str(job_id),
        "job_name": job.job_name,
        "check_id": check_id,
        "status": status,
        "failure_category": failure_category(check_id, status, termination_type),
        "run_id": None if run_id is None else str(run_id),
        "run_page_url": getattr(run, "run_page_url", None),
        "failed_task_keys": failed_task_keys,
        "error_summary": None if error_summary is None else str(error_summary)[:SUMMARY_CHARS],
        "source": SOURCE,
    }
