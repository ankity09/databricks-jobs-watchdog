# The Jobs API scan

Notebook 06 reads live job state from each workspace's Jobs API, through the Databricks SDK for
Python. System tables give history for every workspace at once, about an hour behind. The Jobs API
gives the run happening right now and the error text of failed tasks, one workspace at a time. The
code is `jobs_watchdog/jobs_api.py`; notebook 04 walks one job through the same calls and shows the
raw fields.

Nothing in this scan writes to a job. It only reads.

## The calls, in order

For each workspace the scan visits:

1. **Which workspace answered.** `w.get_workspace_id()`. If the ID differs from the workspace the
   scan meant to reach, it stops for that workspace (see [the workspace ID guard](#the-workspace-id-guard)).
2. **Find the jobs.** `w.jobs.list(limit=100)` lists the jobs this identity can see, 100 per page.
   Each enabled monitored job's `job_name_regex` is searched in every job name. One listing serves
   all monitored jobs.

Then, for each job that matched:

3. **`w.jobs.list_runs(job_id=..., limit=2)`**: the two newest runs, newest first (REST:
   `jobs/runs/list`).
4. **`w.jobs.get_run(run_id=...)`**: the newest run with every task (REST: `jobs/runs/get`).
5. **`w.jobs.get_run_output(run_id=<task run ID>)`**: the error text, once for each failed task
   (REST: `jobs/runs/get-output`).

So a workspace costs one call plus one call per page of jobs, and each matched job costs two calls
plus one per failed task.

## Fields the Watchdog reads

### From list_runs (each run)

| Field | Used for |
|---|---|
| `run_id` | which run to read in full, and `findings.run_id` |
| `start_time` | milliseconds since the epoch; sorting, and how long a run has been going |
| `state.life_cycle_state` | where the run is: QUEUED, PENDING, RUNNING, TERMINATING, TERMINATED, SKIPPED, INTERNAL_ERROR |
| `state.result_state` | how it ended: SUCCESS, FAILED, TIMEDOUT, CANCELED, and others |
| `run_page_url` | `findings.run_page_url` |

The second run is read only for context: when the newest run is still going, the summary adds how
the run before it ended.

Notebook 04 shows the same rule for `started_by`: the creator is listed only for one-time runs.

### From get_run (the newest run)

| Field | Used for |
|---|---|
| `state.life_cycle_state`, `state.result_state`, `state.state_message` | `live_run_status` |
| `status.termination_details.type` | `failure_category` (CLIENT_ERROR, INTERNAL_ERROR, CLOUD_FAILURE, SUCCESS) |
| `start_time` | `run_start_time`, `run_duration_seconds`, and `live_long_runtime` |
| `end_time` | `run_end_time`; empty while the run is still going |
| `trigger` | `trigger_type` (see [trigger_type](data-model.md#trigger_type)) |
| `creator_user_name` | `triggered_by`, on ONE_TIME runs only |
| `git_source.git_snapshot.used_commit` | `code_version` on a job without the code version tag: the commit of the run the row judged |
| `run_page_url` | the link on every row about this run |
| `tasks[]` | the task checks below |
| `next_page_token` | the next page of tasks, when there is one |

For each task in `tasks[]`:

| Field | Used for |
|---|---|
| `task_key` | `failed_task_keys` and the error summary |
| `run_id` | the task run ID, used to call `get_run_output` |
| `attempt_number` | which attempt this is; 0 is the first try |
| `state.life_cycle_state`, `state.result_state` | whether the task failed |
| `state.state_message` | the fallback error text |
| `status.termination_details.type` | `failure_category` of a task failure |

### From get_run_output (each failed task)

| Field | Used for |
|---|---|
| `error` | the error text in `error_summary` |

For a multi-task job, `get_run_output` takes the task's run ID, not the job run's ID. Reading output
needs the same permission as reading the run. If the call fails, the task's `state_message` is used
instead, and the task still counts as failed.

### From jobs.list (each job)

| Field | Used for |
|---|---|
| `settings.name` | the name each monitored job's regex is searched in |
| `settings.tags` | `job_tags`, and the value of the tag named by `code_version_tag` |
| `job_parameters` (on the run) | `pipeline_url`: the value, or else the default, of the parameter named by `pipeline_url_parameter` |

The scan lists the jobs once per workspace, so the tags come from that listing. The tag is read from the job's current definition, so every row shows the version deployed now, including rows about older runs. For a job without the tag, each row shows the git commit of the run it judged, when that run came from a Git source.

## Run timing

`run_start_time` and `run_end_time` are the run's `start_time` and `end_time`, in UTC. How
`run_duration_seconds` is computed depends on whether the run is still going:

- **Finished:** `end_time` minus `start_time`.
- **Still going:** the time from `start_time` to the scan's own clock. It grows with each scan.
- **Finished without an `end_time`:** no duration. A duration is never negative.

`live_long_runtime` uses the same clock. For the newest run, while it is in progress, it counts whole
minutes since `start_time`.

## From states to statuses

System tables and the Jobs API spell states differently:

| System tables | Jobs API |
|---|---|
| SUCCEEDED | SUCCESS |
| CANCELLED | CANCELED |
| TIMED_OUT | TIMEDOUT |
| ERROR | INTERNAL_ERROR (a life cycle state) |

So each source has its own mapping (`jobs_watchdog/states.py`).

### Jobs API

The life cycle state is read first:

| life_cycle_state | Status |
|---|---|
| RUNNING, PENDING, QUEUED, BLOCKED, WAITING_FOR_RETRY, TERMINATING | HEALTHY (in progress) |
| INTERNAL_ERROR | FAILED |
| SKIPPED | WARNING |

Otherwise the result state decides:

| result_state | Status |
|---|---|
| SUCCESS, EXCLUDED, DISABLED | HEALTHY |
| SUCCESS_WITH_FAILURES | WARNING |
| FAILED, TIMEDOUT, UPSTREAM_FAILED | FAILED |
| CANCELED, UPSTREAM_CANCELED, MAXIMUM_CONCURRENT_RUNS_REACHED | WARNING |
| no result | UNKNOWN |
| any other value | UNKNOWN |

### System tables

| result_state | Status |
|---|---|
| SUCCEEDED | HEALTHY |
| FAILED, ERROR, TIMED_OUT | FAILED |
| CANCELLED, SKIPPED, BLOCKED | WARNING |
| no finished run | UNKNOWN |
| any other value | UNKNOWN |

### Termination type to failure_category

On a FAILED or WARNING run or task row, `status.termination_details.type` (Jobs API) or
`termination_type` (system tables) gives the category:

| Termination type | failure_category |
|---|---|
| INTERNAL_ERROR, CLOUD_FAILURE | INFRASTRUCTURE |
| CLIENT_ERROR, SUCCESS, or empty | FUNCTIONAL |

Some checks have their own category instead: `live_long_runtime` gives SLA_EXCEEDED, `retry_loop`
gives RETRY_LOOP, and every UNKNOWN row gives COVERAGE. HEALTHY rows give NONE.
[data-model.md](data-model.md#failure_category) has the full order.

## The checks

| check_id | Rule |
|---|---|
| `live_run_status` | The newest run's state, mapped as above. A job with no runs is UNKNOWN, and gets no other Jobs API rows. |
| `live_task_failures` | A task fails when its newest attempt ended FAILED or TIMEDOUT, or its life cycle is INTERNAL_ERROR. Any failed task makes the row FAILED, even while the run continues. `failed_task_keys` lists them, and `error_summary` holds `<task_key>: <error>` for each, separated by vertical bars. |
| `live_long_runtime` | When `max_runtime_minutes` is set: WARNING if the newest run is still in progress and has been going longer than the limit, in whole minutes since `start_time`. |
| `retry_loop` | When `max_retries` is set: WARNING if any task's newest attempt has an `attempt_number` above `max_retries`. With `max_retries: 1`, a task on its third try (attempt 2) is a retry loop. Set `max_retries` below the job's own task retry limit: a job never retries past its own limit, so an equal value never fires. |
| `not_found` | No job this identity can see matches the regex. With several workspaces, a job found in any of them gets no row, and the row counts only the workspaces that answered. |
| `api_unreachable` | The workspace or the job could not be read. |

Two details:

- **Attempts.** A retried task appears once per attempt. The task checks look at each task's newest
  attempt, so a task that failed and then succeeded on retry is not a live failure. Its attempts
  still count toward `retry_loop`.
- **Upstream failures.** Tasks with result UPSTREAM_FAILED never ran, so they are not listed in
  `failed_task_keys`. The upstream task that failed is listed, and the run itself shows FAILED.

## Paging

- **Tasks.** A run with many tasks (more than 100) comes back in pages. Recent SDK versions merge the
  pages inside `get_run`. The Watchdog also follows `next_page_token` itself, so older SDK versions
  work too, and it stops if the API ever returns the same token twice.
- **Runs.** `list_runs` in the SDK is an iterator that keeps fetching pages until it has every run of
  the job, so `limit=2` only sets the page size. The Watchdog takes the first two runs and stops, so
  only the first page is ever fetched.
- **Jobs.** `jobs.list` is read in full, 100 jobs per page, once per workspace.

## When something cannot be read

A failure never stops the scan. It becomes an `api_unreachable` row (status UNKNOWN, category
COVERAGE), and the scan moves on.

| What failed | Rows written | error_summary |
|---|---|---|
| The workspace: sign-in, network, listing jobs | one row per enabled monitored job, with no `job_id` | `<ErrorType>: <message>` |
| One job: listing or reading its runs | one row for that job, with its `job_id` | `<ErrorType>: <message>` |
| No URL for a workspace (service principal mode) | one row per enabled monitored job | `No URL for this workspace in system.access.workspaces_latest` |
| Reading a failed task's output | no extra row; the task keeps its state message | |

### The workspace ID guard

Before it reads anything, the scan asks the API which workspace answered. If that differs from the
workspace it meant to reach, for example because a URL now points at another workspace, it writes
`api_unreachable` rows whose summary starts with `WORKSPACE_ID_MISMATCH`, and reads nothing else from
that host. Findings are never written under the wrong workspace.

## Which workspaces are visited

| auth_mode | Workspaces | Identity |
|---|---|---|
| `current_workspace` | only the workspace running the notebook | the notebook's own identity (you, or the job's "run as") |
| `service_principal` | every workspace that has jobs in this region (`sql/explore/10_workspaces_in_region.sql`) and has a URL in `system.access.workspaces_latest` | a service principal, signing in with an OAuth secret from a secret scope |

In service principal mode, a job found in any of the workspaces gets no `not_found` row, and a job
found in none gets one `not_found` row with no workspace. Service principal mode is covered by unit
tests; run notebook 00 in that mode before you rely on it.

Each workspace's rows carry its environment label, from the `workspaces` section of your config. See
[monitored_workspaces](data-model.md#monitored_workspaces).

## Permissions

- **CAN VIEW** on a job is enough to see it in `jobs.list`, read its runs and read task output.
  Workspace admins can see every job.
- `jobs.list` returns only the jobs the identity can see. A job without CAN VIEW therefore shows up
  as `not_found` from the Jobs API, even though the system table scan still sees it (system tables
  follow Unity Catalog grants, not job permissions). If the two sources disagree like that, check the
  job's permissions.
- **CAN MANAGE RUN is never needed.** Phase 1 never starts, stops or repairs a run.
- In service principal mode, the service principal must also be added to every workspace it visits.

[phase-1-runbook.md](phase-1-runbook.md) has the steps for each role.

## SDK notes

- The Databricks SDK for Python (`databricks-sdk`) comes with serverless notebooks and jobs. Nothing
  needs installing.
- `current_workspace` mode uses `WorkspaceClient()`, which picks up the notebook's own credentials.
- `service_principal` mode builds `WorkspaceClient(host=<url>, client_id=..., client_secret=...,
  auth_type="oauth-m2m")` for each workspace. Pinning `auth_type` keeps the notebook's own
  credentials from being picked up by mistake.
- The SDK returns states as enums. The Watchdog compares their text values, and reads every field
  with a default, so a field an older SDK version lacks reads as empty instead of failing.
- Regexes run with Python's `re.search`, like Spark's `regexp_like` in the system table scan: both
  find the pattern anywhere in the name unless it is anchored.
