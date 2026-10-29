from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS

import pytest

from jobs_watchdog.config import MonitoredJob
from jobs_watchdog.jobs_api import Target, collect_target, make_client, merge_not_found, resolve_jobs

NOW = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)
TARGET = Target(workspace_id="1001", workspace_name="analytics", host=None)


def monitored(name="orders", regex="orders", max_runtime=60, max_retries=1, enabled=True, exclude=None):
    return MonitoredJob(
        job_name=name,
        job_name_regex=regex,
        schedule_type="scheduled",
        max_gap_minutes=90,
        max_runtime_minutes=max_runtime,
        max_retries=max_retries,
        severity="CRITICAL",
        owner="data-team",
        enabled=enabled,
        notes="",
        job_name_exclude_regex=exclude,
    )


def ms(moment):
    return int(moment.timestamp() * 1000)


def task(key, life_cycle, result=None, run_id=None, attempt=0, message="", termination_type=None):
    details = NS(type=termination_type, code=None, message=None) if termination_type else None
    return NS(
        task_key=key,
        run_id=run_id,
        attempt_number=attempt,
        state=NS(life_cycle_state=life_cycle, result_state=result, state_message=message),
        status=NS(termination_details=details),
    )


def run(run_id, life_cycle, result=None, minutes_ago=10, tasks=(), message="", next_page_token=None,
        ended_minutes_ago=None, trigger=None, creator=None, git_commit=None):
    return NS(
        run_id=run_id,
        start_time=ms(NOW - timedelta(minutes=minutes_ago)),
        end_time=None if ended_minutes_ago is None else ms(NOW - timedelta(minutes=ended_minutes_ago)),
        state=NS(life_cycle_state=life_cycle, result_state=result, state_message=message),
        status=None,
        run_page_url=f"https://example.invalid/jobs/1/runs/{run_id}",
        tasks=list(tasks),
        next_page_token=next_page_token,
        trigger=trigger,
        creator_user_name=creator,
        git_source=None if git_commit is None else NS(git_snapshot=NS(used_commit=git_commit)),
    )


class FakeJobs:
    def __init__(self, jobs=(), runs=None, pages=None, outputs=None, list_error=None, output_error=None,
                 runs_error=None):
        self._jobs = list(jobs)
        self._runs = runs or {}
        self._by_id = {r.run_id: r for job_runs in self._runs.values() for r in job_runs}
        self._pages = pages or {}
        self._outputs = outputs or {}
        self._list_error = list_error
        self._output_error = output_error
        self._runs_error = runs_error or {}
        self.runs_yielded = 0

    def list(self, **kwargs):
        if self._list_error:
            raise self._list_error
        for job_id, name, *tags in self._jobs:
            yield NS(job_id=job_id, settings=NS(name=name, tags=tags[0] if tags else None))

    def list_runs(self, job_id=None, limit=None, **kwargs):
        if job_id in self._runs_error:
            raise self._runs_error[job_id]
        for item in self._runs.get(job_id, []):
            self.runs_yielded += 1
            yield item

    def get_run(self, run_id, page_token=None):
        if page_token:
            return self._pages[(run_id, page_token)]
        return self._by_id[run_id]

    def get_run_output(self, run_id):
        if self._output_error:
            raise self._output_error
        return NS(error=self._outputs.get(run_id), error_trace=None)


class FakeClient:
    def __init__(self, workspace_id="1001", **kwargs):
        self._workspace_id = workspace_id
        self.jobs = FakeJobs(**kwargs)

    def get_workspace_id(self):
        return int(self._workspace_id)


def by_check(rows):
    return {row["check_id"]: row for row in rows}


def test_resolve_jobs_uses_search_semantics_and_keeps_misses():
    client = FakeClient(jobs=[(1, "[dev someone] orders"), (2, "orders_backfill"), (3, "billing")])
    jobs = [monitored("orders", "orders"), monitored("payroll", "^payroll$")]
    resolved = resolve_jobs(client, jobs)
    assert [(job.job_name, job_id, name) for job, job_id, name, _tags in resolved] == [
        ("orders", 1, "[dev someone] orders"),
        ("orders", 2, "orders_backfill"),
        ("payroll", None, None),
    ]


def test_successful_run_is_healthy():
    client = FakeClient(jobs=[(1, "orders")], runs={1: [run(11, "TERMINATED", "SUCCESS")]})
    rows = by_check(collect_target(client, TARGET, [monitored()], NOW))
    status = rows["live_run_status"]
    assert status["status"] == "HEALTHY"
    assert status["failure_category"] == "NONE"
    assert status["run_id"] == "11"
    assert status["job_id"] == "1"
    assert status["run_page_url"].endswith("/runs/11")
    assert status["source"] == "JOBS_API"
    assert status["workspace_id"] == "1001"
    assert status["workspace_name"] == "analytics"
    assert rows["live_task_failures"]["status"] == "HEALTHY"
    assert rows["live_long_runtime"]["status"] == "HEALTHY"
    assert rows["retry_loop"]["status"] == "HEALTHY"


def test_failed_task_reports_keys_and_output_error():
    failed = run(11, "TERMINATED", "FAILED", tasks=[
        task("extract", "TERMINATED", "SUCCESS", run_id=111),
        task("load", "TERMINATED", "FAILED", run_id=112, message="state text", termination_type="CLIENT_ERROR"),
    ])
    client = FakeClient(jobs=[(1, "orders")], runs={1: [failed]}, outputs={112: "ZeroDivisionError: division by zero"})
    rows = by_check(collect_target(client, TARGET, [monitored()], NOW))
    tasks = rows["live_task_failures"]
    assert tasks["status"] == "FAILED"
    assert tasks["failed_task_keys"] == ["load"]
    assert "ZeroDivisionError" in tasks["error_summary"]
    assert tasks["failure_category"] == "FUNCTIONAL"
    assert rows["live_run_status"]["status"] == "FAILED"


def test_denied_output_keeps_state_message():
    failed = run(11, "TERMINATED", "FAILED", tasks=[
        task("load", "TERMINATED", "FAILED", run_id=112, message="Task load failed with an exception"),
    ])
    client = FakeClient(jobs=[(1, "orders")], runs={1: [failed]}, output_error=PermissionError("denied"))
    rows = by_check(collect_target(client, TARGET, [monitored()], NOW))
    assert rows["live_task_failures"]["status"] == "FAILED"
    assert "Task load failed with an exception" in rows["live_task_failures"]["error_summary"]


def test_task_pages_are_followed():
    first = run(11, "RUNNING", tasks=[task("extract", "RUNNING")], next_page_token="p2")
    second = NS(tasks=[task("load", "TERMINATED", "FAILED", run_id=112)], next_page_token=None)
    client = FakeClient(jobs=[(1, "orders")], runs={1: [first]}, pages={(11, "p2"): second},
                        outputs={112: "boom"})
    rows = by_check(collect_target(client, TARGET, [monitored()], NOW))
    assert rows["live_run_status"]["status"] == "HEALTHY"
    assert rows["live_task_failures"]["status"] == "FAILED"
    assert rows["live_task_failures"]["failed_task_keys"] == ["load"]


def test_run_past_its_limit_is_a_warning():
    client = FakeClient(jobs=[(1, "orders")], runs={1: [run(11, "RUNNING", minutes_ago=95)]})
    rows = by_check(collect_target(client, TARGET, [monitored(max_runtime=60)], NOW))
    long_run = rows["live_long_runtime"]
    assert long_run["status"] == "WARNING"
    assert long_run["failure_category"] == "SLA_EXCEEDED"
    assert "95" in long_run["error_summary"]


def test_attempts_above_max_retries_is_a_retry_loop():
    retried = run(11, "RUNNING", tasks=[
        task("load", "TERMINATED", "FAILED", run_id=112, attempt=0),
        task("load", "TERMINATED", "FAILED", run_id=113, attempt=1),
        task("load", "RUNNING", run_id=114, attempt=2),
    ])
    client = FakeClient(jobs=[(1, "orders")], runs={1: [retried]})
    rows = by_check(collect_target(client, TARGET, [monitored(max_retries=1)], NOW))
    assert rows["retry_loop"]["status"] == "WARNING"
    assert rows["retry_loop"]["failure_category"] == "RETRY_LOOP"
    assert rows["retry_loop"]["failed_task_keys"] == ["load"]
    assert rows["live_task_failures"]["status"] == "HEALTHY"


def test_list_permission_error_marks_every_job_unreachable():
    client = FakeClient(list_error=PermissionError("user cannot list jobs"))
    jobs = [monitored("orders"), monitored("billing", "billing")]
    rows = collect_target(client, TARGET, jobs, NOW)
    assert [(r["job_name"], r["check_id"], r["status"]) for r in rows] == [
        ("orders", "api_unreachable", "UNKNOWN"),
        ("billing", "api_unreachable", "UNKNOWN"),
    ]
    assert "user cannot list jobs" in rows[0]["error_summary"]
    assert rows[0]["failure_category"] == "COVERAGE"


def test_one_unreadable_job_does_not_stop_the_others():
    client = FakeClient(jobs=[(1, "orders"), (2, "billing")],
                        runs={2: [run(21, "TERMINATED", "SUCCESS")]},
                        runs_error={1: PermissionError("no CAN VIEW on job 1")})
    rows = collect_target(client, TARGET, [monitored("orders"), monitored("billing", "billing")], NOW)
    orders = [r for r in rows if r["job_name"] == "orders"]
    billing = by_check(r for r in rows if r["job_name"] == "billing")
    assert [(r["check_id"], r["job_id"]) for r in orders] == [("api_unreachable", "1")]
    assert billing["live_run_status"]["status"] == "HEALTHY"


def test_no_runs_is_unknown():
    client = FakeClient(jobs=[(1, "orders")], runs={1: []})
    rows = by_check(collect_target(client, TARGET, [monitored()], NOW))
    assert rows["live_run_status"]["status"] == "UNKNOWN"
    assert rows["live_run_status"]["failure_category"] == "COVERAGE"


def test_no_regex_match_is_not_found():
    client = FakeClient(jobs=[(1, "billing")])
    rows = collect_target(client, TARGET, [monitored("orders", "^orders$")], NOW)
    assert [(r["check_id"], r["status"], r["job_id"]) for r in rows] == [("not_found", "UNKNOWN", None)]
    assert rows[0]["error_summary"] == (
        "No job that this identity can see in this workspace matches ^orders$. "
        "Check the regex, and that the identity has CAN VIEW on the job.")


def test_workspace_id_mismatch_is_unreachable():
    client = FakeClient(workspace_id="2002", jobs=[(1, "orders")])
    rows = collect_target(client, TARGET, [monitored()], NOW)
    assert [(r["check_id"], r["status"]) for r in rows] == [("api_unreachable", "UNKNOWN")]
    assert rows[0]["error_summary"].startswith("WORKSPACE_ID_MISMATCH")


def test_reads_at_most_two_runs():
    runs = [run(10 + i, "TERMINATED", "SUCCESS", minutes_ago=10 * (i + 1)) for i in range(5)]
    client = FakeClient(jobs=[(1, "orders")], runs={1: runs})
    collect_target(client, TARGET, [monitored()], NOW)
    assert client.jobs.runs_yielded == 2


def test_running_run_mentions_the_previous_result():
    runs = [run(12, "RUNNING", minutes_ago=5), run(11, "TERMINATED", "FAILED", minutes_ago=70)]
    client = FakeClient(jobs=[(1, "orders")], runs={1: runs})
    status = by_check(collect_target(client, TARGET, [monitored()], NOW))["live_run_status"]
    assert status["status"] == "HEALTHY"
    assert "FAILED" in status["error_summary"]


def test_now_must_be_timezone_aware():
    with pytest.raises(ValueError, match="timezone"):
        collect_target(FakeClient(), TARGET, [monitored()], datetime(2026, 10, 28, 12, 0))


def test_disabled_jobs_are_skipped():
    client = FakeClient(jobs=[(1, "orders")], runs={1: [run(11, "TERMINATED", "SUCCESS")]})
    assert collect_target(client, TARGET, [monitored(enabled=False)], NOW) == []


def test_limits_left_empty_skip_their_checks():
    client = FakeClient(jobs=[(1, "orders")], runs={1: [run(11, "TERMINATED", "SUCCESS")]})
    rows = by_check(collect_target(client, TARGET, [monitored(max_runtime=None, max_retries=None)], NOW))
    assert set(rows) == {"live_run_status", "live_task_failures"}


def _not_found(job_name, workspace_id):
    return {"job_name": job_name, "workspace_id": workspace_id, "workspace_name": None, "check_id": "not_found",
            "status": "UNKNOWN", "job_id": None, "error_summary": f"No job in this workspace matches {job_name}."}


def test_merge_not_found_drops_jobs_found_in_another_workspace():
    found = {"job_name": "orders", "workspace_id": "1001", "check_id": "live_run_status", "job_id": "1"}
    rows = merge_not_found([found, _not_found("orders", "2002")], [monitored("orders")])
    assert rows == [found]


def test_merge_not_found_collapses_jobs_found_nowhere():
    rows = merge_not_found([_not_found("orders", "1001"), _not_found("orders", "2002")],
                           [monitored("orders", "^orders$")])
    assert len(rows) == 1
    assert rows[0]["workspace_id"] is None and rows[0]["environment"] is None
    assert rows[0]["error_summary"] == (
        "No job that this identity can see in any of the 2 workspaces checked matches ^orders$. "
        "Check the regex, and CAN VIEW on the job.")


def test_merge_not_found_keeps_a_single_workspace_row():
    row = _not_found("orders", "1001")
    assert merge_not_found([row], [monitored("orders")]) == [row]


def test_merge_not_found_counts_only_workspaces_that_answered():
    unreachable = {"job_name": "orders", "workspace_id": "2002", "check_id": "api_unreachable", "job_id": None}
    row = _not_found("orders", "1001")
    assert merge_not_found([row, unreachable], [monitored("orders")]) == [row, unreachable]


def test_make_client_rejects_unknown_mode():
    with pytest.raises(ValueError, match="auth mode"):
        make_client("token", None, None, None)


def test_make_client_needs_service_principal_values():
    with pytest.raises(ValueError, match="client_secret"):
        make_client("service_principal", "https://example.invalid", "abc", None)


def test_make_client_service_principal_uses_oauth(monkeypatch):
    captured = {}

    class FakeWorkspaceClient:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setattr("databricks.sdk.WorkspaceClient", FakeWorkspaceClient)
    make_client("service_principal", "https://example.invalid", "abc", "s3cret")
    assert captured == {"host": "https://example.invalid", "client_id": "abc", "client_secret": "s3cret",
                        "auth_type": "oauth-m2m"}


def test_unreachable_rows_cover_every_enabled_job():
    from jobs_watchdog.jobs_api import unreachable_rows

    jobs = [monitored("orders"), monitored("billing", "billing"), monitored("old", "old", enabled=False)]
    rows = unreachable_rows(Target("2002", None, None), jobs, "No URL for this workspace")
    assert [(r["job_name"], r["check_id"], r["status"], r["error_summary"]) for r in rows] == [
        ("orders", "api_unreachable", "UNKNOWN", "No URL for this workspace"),
        ("billing", "api_unreachable", "UNKNOWN", "No URL for this workspace"),
    ]


def test_explain_job_shows_runs_tasks_and_errors():
    from jobs_watchdog.jobs_api import explain_job

    failed = run(11, "TERMINATED", "FAILED", tasks=[
        task("extract", "TERMINATED", "SUCCESS", run_id=111),
        task("load", "TERMINATED", "FAILED", run_id=112, termination_type="CLIENT_ERROR"),
    ])
    client = FakeClient(jobs=[(1, "orders")], runs={1: [failed]}, outputs={112: "ValueError: bad row"})
    explained = explain_job(client, 1)
    assert [r["run_id"] for r in explained["runs"]] == [11]
    assert explained["runs"][0]["result_state"] == "FAILED"
    assert [(t["task_key"], t["result_state"], t["termination_type"]) for t in explained["tasks"]] == [
        ("extract", "SUCCESS", None), ("load", "FAILED", "CLIENT_ERROR")]
    assert explained["errors"] == [{"task_key": "load", "task_run_id": 112, "error": "ValueError: bad row"}]


def test_explain_job_with_no_runs():
    from jobs_watchdog.jobs_api import explain_job

    assert explain_job(FakeClient(runs={1: []}), 1) == {"runs": [], "tasks": [], "errors": []}



def test_exclude_regex_skips_test_copies():
    client = FakeClient(jobs=[(1, "orders_prod"), (2, "orders_test_prod"), (3, "orders_prod_20261018")])
    resolved = resolve_jobs(client, [monitored("orders", "^orders_prod", exclude="test")])
    assert [(job_id, name) for _job, job_id, name, _tags in resolved] == [(1, "orders_prod"), (3, "orders_prod_20261018")]


def test_rows_carry_run_timing_trigger_tags_and_code_version():
    finished = run(11, "TERMINATED", "SUCCESS", minutes_ago=30, ended_minutes_ago=5, trigger="ONE_TIME",
                   creator="someone@example.com")
    client = FakeClient(jobs=[(1, "orders", {"code_version": "orders-main@abc123", "team": "data"})],
                        runs={1: [finished]})
    target = Target("1001", "analytics", None, "production")
    row = by_check(collect_target(client, target, [monitored()], NOW))["live_run_status"]
    assert row["run_start_time"] == NOW - timedelta(minutes=30)
    assert row["run_end_time"] == NOW - timedelta(minutes=5)
    assert row["run_duration_seconds"] == 25 * 60
    assert (row["trigger_type"], row["triggered_by"]) == ("ONE_TIME", "someone@example.com")
    assert row["job_tags"] == {"code_version": "orders-main@abc123", "team": "data"}
    assert row["code_version"] == "orders-main@abc123"
    assert (row["environment"], row["schedule_type"]) == ("production", "scheduled")


def test_scheduled_runs_name_no_one_as_the_trigger():
    client = FakeClient(jobs=[(1, "orders")], runs={1: [run(11, "TERMINATED", "SUCCESS", trigger="PERIODIC",
                                                          creator="owner@example.com")]})
    row = by_check(collect_target(client, TARGET, [monitored()], NOW))["live_run_status"]
    assert (row["trigger_type"], row["triggered_by"]) == ("SCHEDULE", None)


def test_code_version_falls_back_to_the_commit_the_run_used():
    client = FakeClient(jobs=[(1, "orders")], runs={1: [run(11, "TERMINATED", "SUCCESS", git_commit="9f8e7d")]})
    row = by_check(collect_target(client, TARGET, [monitored()], NOW))["live_run_status"]
    assert row["code_version"] == "9f8e7d"


def test_a_run_still_going_has_no_end_and_counts_to_now():
    client = FakeClient(jobs=[(1, "orders")], runs={1: [run(11, "RUNNING", minutes_ago=7)]})
    row = by_check(collect_target(client, TARGET, [monitored()], NOW))["live_run_status"]
    assert row["run_end_time"] is None and row["run_duration_seconds"] == 7 * 60


def test_code_version_tag_can_be_switched_off():
    client = FakeClient(jobs=[(1, "orders", {"code_version": "x"})], runs={1: [run(11, "TERMINATED", "SUCCESS")]})
    row = by_check(collect_target(client, TARGET, [monitored()], NOW, code_version_tag=""))["live_run_status"]
    assert row["code_version"] is None and row["job_tags"] == {"code_version": "x"}


def test_a_finished_run_without_an_end_time_has_no_duration():
    finished = run(11, "TERMINATED", "SUCCESS", minutes_ago=30)
    finished.end_time = 0
    row = by_check(collect_target(FakeClient(jobs=[(1, "orders")], runs={1: [finished]}), TARGET, [monitored()],
                                  NOW))["live_run_status"]
    assert row["run_end_time"] is None and row["run_duration_seconds"] is None


def test_a_run_that_started_after_the_scan_began_never_has_a_negative_duration():
    late = run(11, "RUNNING", minutes_ago=-2)
    row = by_check(collect_target(FakeClient(jobs=[(1, "orders")], runs={1: [late]}), TARGET, [monitored()],
                                  NOW))["live_run_status"]
    assert row["run_duration_seconds"] == 0


def test_explain_job_names_who_started_only_one_time_runs():
    from jobs_watchdog.jobs_api import explain_job

    runs = [run(12, "TERMINATED", "SUCCESS", minutes_ago=5, trigger="PERIODIC", creator="owner@example.com"),
            run(11, "TERMINATED", "SUCCESS", minutes_ago=60, trigger="ONE_TIME", creator="someone@example.com")]
    explained = explain_job(FakeClient(runs={1: runs}), 1)
    assert [r["started_by"] for r in explained["runs"]] == [None, "someone@example.com"]
