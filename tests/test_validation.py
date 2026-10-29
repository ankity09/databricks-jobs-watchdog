from jobs_watchdog.validation import phase_1_checks

TABLES = {"monitored_jobs": True, "job_dependencies": True, "findings": True, "monitored_workspaces": True,
          "findings_latest": True}
BY_SOURCE = [{"source": "JOBS_API", "scan_id": "9", "status": "HEALTHY", "findings": 4},
             {"source": "SYSTEM_TABLES", "scan_id": "9", "status": "FAILED", "findings": 2}]


def outcome(**overrides):
    values = dict(tables=TABLES, enabled_jobs=2, by_source=BY_SOURCE, missing=[], duplicates=[])
    values.update(overrides)
    return {name: (passed, detail) for name, passed, detail in phase_1_checks(**values)}


def test_everything_in_place_passes():
    results = outcome()
    assert all(passed for passed, _ in results.values())
    assert list(results) == ["tables exist", "config has enabled jobs", "both sources wrote findings",
                             "every enabled job has findings", "no duplicate keys"]


def test_missing_table_fails_and_names_it():
    passed, detail = outcome(tables=dict(TABLES, findings=False))["tables exist"]
    assert not passed and "findings" in detail


def test_no_enabled_jobs_fails():
    assert not outcome(enabled_jobs=0)["config has enabled jobs"][0]


def test_a_missing_source_fails_and_names_it():
    passed, detail = outcome(by_source=BY_SOURCE[:1])["both sources wrote findings"]
    assert not passed and "SYSTEM_TABLES" in detail


def test_jobs_without_findings_fail_and_are_listed():
    passed, detail = outcome(missing=[{"job_name": "orders", "source": "JOBS_API"}])["every enabled job has findings"]
    assert not passed and "orders (JOBS_API)" in detail


def test_duplicates_fail():
    dup = [{"scan_id": "9", "job_name": "orders", "check_id": "live_run_status", "source": "JOBS_API", "copies": 2}]
    assert not outcome(duplicates=dup)["no duplicate keys"][0]


def test_one_reachable_workspace_is_enough_and_the_rest_are_warnings():
    from jobs_watchdog.validation import service_principal_verdict

    required, warnings = service_principal_verdict([
        ("analytics (1001)", True, "reached"),
        ("sandbox (2002)", False, "PermissionDenied: not a workspace user"),
    ])
    assert required == []
    assert warnings == ["service principal on sandbox (2002): PermissionDenied: not a workspace user"]


def test_no_reachable_workspace_is_a_required_failure():
    from jobs_watchdog.validation import service_principal_verdict

    required, warnings = service_principal_verdict([
        ("analytics (1001)", False, "timeout"),
        ("sandbox (2002)", False, "no URL in system.access.workspaces_latest"),
    ])
    assert len(required) == 1 and "2 workspaces" in required[0]
    assert len(warnings) == 2


def test_no_workspaces_to_try_is_a_required_failure():
    from jobs_watchdog.validation import service_principal_verdict

    required, warnings = service_principal_verdict([])
    assert len(required) == 1 and "no workspaces" in required[0]
    assert warnings == []


def test_tables_detail_names_every_object_checked():
    assert "monitored_workspaces" in outcome()["tables exist"][1]
