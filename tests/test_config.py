import textwrap
from pathlib import Path

import pytest

from jobs_watchdog.config import (
    ConfigError,
    MonitoredWorkspace,
    load_accelerator,
    load_monitored_jobs,
    load_monitored_workspaces,
    parse_monitored_jobs,
    parse_monitored_workspaces,
)

REPO = Path(__file__).resolve().parents[1]


def write(tmp_path, text, name="jobs.yml"):
    path = tmp_path / name
    path.write_text(textwrap.dedent(text))
    return path


VALID_JOB = """
  - job_name: orders_ingest
    job_name_regex: "^orders_ingest_(dev|prod)$"
    schedule_type: continuous
    max_runtime_minutes: 60
    max_retries: 2
    severity: CRITICAL
    owner: data-platform
    enabled: true
"""


def test_example_config_loads():
    jobs, deps = load_monitored_jobs(REPO / "config" / "monitored_jobs.example.yml")
    names = {j.job_name for j in jobs}
    assert {"watchdog_demo_succeeds", "watchdog_demo_fails"} <= names
    enabled = {j.job_name for j in jobs if j.enabled}
    assert {"watchdog_demo_succeeds", "watchdog_demo_fails"} <= enabled
    assert any(d.dependency_type == "service" for d in deps)


def test_missing_file_names_the_path(tmp_path):
    missing = tmp_path / "nope.yml"
    with pytest.raises(ConfigError, match="nope.yml"):
        load_monitored_jobs(missing)


def test_invalid_yaml_is_a_config_error(tmp_path):
    path = write(tmp_path, "jobs: [unclosed")
    with pytest.raises(ConfigError):
        load_monitored_jobs(path)


def test_valid_continuous_job_loads(tmp_path):
    path = write(tmp_path, "jobs:" + VALID_JOB)
    jobs, deps = load_monitored_jobs(path)
    assert jobs[0].job_name == "orders_ingest"
    assert jobs[0].max_gap_minutes == 30  # continuous: how long the stream may have no run in progress
    assert deps == []


@pytest.mark.parametrize(
    "field,value,needle",
    [
        ("schedule_type", "weekly", "schedule_type"),
        ("severity", "LOW", "severity"),
        ("job_name_regex", "'(unclosed'", "job_name_regex"),
        ("max_runtime_minutes", "'abc'", "max_runtime_minutes"),
        ("max_retries", "-1", "max_retries"),
    ],
)
def test_bad_field_names_job_and_field(tmp_path, field, value, needle):
    lines = [line for line in VALID_JOB.splitlines() if not line.strip().startswith(field + ":")]
    lines.append(f"    {field}: {value}")
    path = write(tmp_path, "jobs:" + "\n".join(lines) + "\n")
    with pytest.raises(ConfigError) as err:
        load_monitored_jobs(path)
    assert "orders_ingest" in str(err.value)
    assert needle in str(err.value)


def test_scheduled_job_needs_max_gap(tmp_path):
    job = VALID_JOB.replace("schedule_type: continuous", "schedule_type: scheduled")
    path = write(tmp_path, "jobs:" + job)
    with pytest.raises(ConfigError, match="max_gap_minutes"):
        load_monitored_jobs(path)


def test_duplicate_job_names_rejected(tmp_path):
    path = write(tmp_path, "jobs:" + VALID_JOB + VALID_JOB)
    with pytest.raises(ConfigError, match="duplicate"):
        load_monitored_jobs(path)


def test_job_dependency_must_name_a_configured_job(tmp_path):
    text = "jobs:" + VALID_JOB + """
dependencies:
  - job_name: orders_ingest
    depends_on: not_a_job
    dependency_type: job
"""
    with pytest.raises(ConfigError, match="not_a_job"):
        load_monitored_jobs(write(tmp_path, text))


def test_service_dependency_is_free_text(tmp_path):
    text = "jobs:" + VALID_JOB + """
dependencies:
  - job_name: orders_ingest
    depends_on: kafka
    dependency_type: service
"""
    _, deps = load_monitored_jobs(write(tmp_path, text))
    assert deps[0].depends_on == "kafka"


def test_bad_dependency_type_rejected(tmp_path):
    text = "jobs:" + VALID_JOB + """
dependencies:
  - job_name: orders_ingest
    depends_on: kafka
    dependency_type: friend
"""
    with pytest.raises(ConfigError, match="dependency_type"):
        load_monitored_jobs(write(tmp_path, text))


def test_accelerator_template_loads():
    settings = load_accelerator(REPO / "accelerator.yaml")
    for section in ("metadata", "target", "auth", "scan", "resources", "features"):
        assert section in settings
    assert settings["target"]["schema"] == "watchdog"


def test_accelerator_complete_check_rejects_empty_catalog():
    with pytest.raises(ConfigError, match="target.catalog"):
        load_accelerator(REPO / "accelerator.yaml", require_complete=True)


def _accelerator(tmp_path, catalog="main", region="us-east-2", mode="current_workspace", scope=""):
    text = f"""
metadata: {{name: databricks-jobs-watchdog}}
target: {{catalog: "{catalog}", schema: watchdog, region: "{region}"}}
auth: {{mode: {mode}, secret_scope: "{scope}", client_id_key: client_id, client_secret_key: client_secret}}
scan: {{lookback_hours: 48, monitored_jobs_path: ../config/monitored_jobs.example.yml}}
resources: {{}}
features: {{required: [unity_catalog], optional: []}}
"""
    return write(tmp_path, text, "accelerator.yaml")


def test_accelerator_complete_accepts_valid(tmp_path):
    settings = load_accelerator(_accelerator(tmp_path), require_complete=True)
    assert settings["target"]["catalog"] == "main"


def test_accelerator_rejects_bad_catalog_name(tmp_path):
    with pytest.raises(ConfigError, match="catalog"):
        load_accelerator(_accelerator(tmp_path, catalog="my-cat"), require_complete=True)


def test_accelerator_rejects_unknown_auth_mode(tmp_path):
    with pytest.raises(ConfigError, match="auth.mode"):
        load_accelerator(_accelerator(tmp_path, mode="pat"), require_complete=True)


def test_service_principal_mode_needs_secret_scope(tmp_path):
    with pytest.raises(ConfigError, match="secret_scope"):
        load_accelerator(_accelerator(tmp_path, mode="service_principal"), require_complete=True)


def test_exclude_regex_is_optional_and_loaded(tmp_path):
    path = write(tmp_path, "jobs:" + VALID_JOB + '    job_name_exclude_regex: "test"\n')
    jobs, _ = load_monitored_jobs(path)
    assert jobs[0].job_name_exclude_regex == "test"
    plain, _ = load_monitored_jobs(write(tmp_path, "jobs:" + VALID_JOB, name="plain.yml"))
    assert plain[0].job_name_exclude_regex is None


def test_exclude_regex_must_compile(tmp_path):
    path = write(tmp_path, "jobs:" + VALID_JOB + '    job_name_exclude_regex: "(unclosed"\n')
    with pytest.raises(ConfigError, match="job_name_exclude_regex"):
        load_monitored_jobs(path)


def _with_pattern(tmp_path, field, pattern):
    lines = [line for line in VALID_JOB.splitlines() if not line.strip().startswith(field + ":")]
    lines.append(f"    {field}: '{pattern}'")
    return write(tmp_path, "jobs:" + "\n".join(lines) + "\n")


def _pattern_error(tmp_path, field, pattern):
    with pytest.raises(ConfigError) as err:
        load_monitored_jobs(_with_pattern(tmp_path, field, pattern))
    return str(err.value)


def test_a_pattern_java_refuses_is_refused_with_the_construct(tmp_path):
    # The system-table scan matches with Spark's regexp_like, which compiles patterns as Java regex.
    assert _pattern_error(tmp_path, "job_name_regex", "^orders_ingest_(?P<env>dev|prod)$") == (
        "job orders_ingest: job_name_regex '^orders_ingest_(?P<env>dev|prod)$' uses a (?P<name>...) group, "
        "which the system-table scan can't run"
    )
    assert _pattern_error(tmp_path, "job_name_exclude_regex", "_copy{,2}$") == (
        "job orders_ingest: job_name_exclude_regex '_copy{,2}$' uses a { that is not a {n}, {n,} or {n,m} repeat, "
        "which the system-table scan can't run"
    )


def test_python_s_own_error_comes_before_java_s(tmp_path):
    assert _pattern_error(tmp_path, "job_name_exclude_regex", "(?P<copy>_test") == (
        "job orders_ingest: job_name_exclude_regex does not compile: missing ), unterminated subpattern at position 0"
    )


def test_a_character_name_is_refused_with_advice(tmp_path):
    assert _pattern_error(tmp_path, "job_name_exclude_regex", r"\N{EM DASH}test$") == (
        "job orders_ingest: job_name_exclude_regex '\\\\N{EM DASH}test$' uses a \\N{...} character name, "
        "which the system-table scan may not know; write the character itself"
    )


def test_a_pattern_both_engines_compile_still_loads(tmp_path):
    jobs, _ = load_monitored_jobs(_with_pattern(tmp_path, "job_name_exclude_regex", r"(?<=_)(copy|test)\d{2,}$"))
    assert jobs[0].job_name_exclude_regex == r"(?<=_)(copy|test)\d{2,}$"


def test_enabled_must_be_true_or_false(tmp_path):
    path = write(tmp_path, "jobs:" + VALID_JOB.replace("enabled: true", 'enabled: "false"'))
    with pytest.raises(ConfigError, match="enabled must be true or false"):
        load_monitored_jobs(path)


WORKSPACES = """
jobs:
  - job_name: orders_ingest
    schedule_type: continuous
workspaces:
  - workspace_id: 1234567890123456
    environment: production
    notes: the production workspace
  - workspace_name: analytics-dev
    environment: lower
"""


def test_workspaces_map_ids_and_names_to_environments(tmp_path):
    workspaces = load_monitored_workspaces(write(tmp_path, WORKSPACES))
    assert workspaces == [
        MonitoredWorkspace("1234567890123456", None, "production", "the production workspace"),
        MonitoredWorkspace(None, "analytics-dev", "lower", ""),
    ]


def test_no_workspaces_section_means_no_environments(tmp_path):
    assert load_monitored_workspaces(write(tmp_path, "jobs:" + VALID_JOB)) == []


@pytest.mark.parametrize(
    "entry,message",
    [
        ("  - environment: production\n", "workspace_id or workspace_name"),
        ("  - workspace_id: 12\n", "environment"),
        ("  - workspace_id: abc\n    environment: production\n", "workspace_id must be digits"),
        ("  - workspace_id: 12\n    environment: prod east\n", "environment must be"),
    ],
)
def test_bad_workspace_entries_are_rejected(tmp_path, entry, message):
    path = write(tmp_path, "jobs:" + VALID_JOB + "workspaces:\n" + entry)
    with pytest.raises(ConfigError, match=message):
        load_monitored_workspaces(path)


def test_a_workspace_listed_twice_is_rejected(tmp_path):
    entry = "  - workspace_name: analytics-dev\n    environment: lower\n"
    path = write(tmp_path, "jobs:" + VALID_JOB + "workspaces:\n" + entry + entry)
    with pytest.raises(ConfigError, match="listed twice"):
        load_monitored_workspaces(path)


def test_workspace_names_differing_only_in_case_are_listed_twice(tmp_path):
    entries = "  - workspace_name: Analytics-Dev\n    environment: lower\n" \
              "  - workspace_name: analytics-dev\n    environment: production\n"
    path = write(tmp_path, "jobs:" + VALID_JOB + "workspaces:\n" + entries)
    with pytest.raises(ConfigError, match="listed twice"):
        load_monitored_workspaces(path)


ENVIRONMENTS = """
defaults:
  schedule_type: scheduled
  severity: WARNING
  owner: data-platform
  job_name_exclude_regex: "_test(_|$)"
  max_gap_minutes: 120
workspaces:
  - workspace_name: prod-workspace
    environment: production
  - workspace_name: dev-workspace
    environment: lower
jobs:
  - job_name: orders_ingest
    job_name_regex: "^orders_ingest_(prod|dev)$"
    schedule_type: continuous
    severity: CRITICAL
    max_retries: 3
    min_attempt_minutes: 10
    environments:
      lower: {severity: WARNING, enabled: false}
  - job_name: orders_enrich
    job_name_regex: "^orders_enrich_(prod|dev)$"
    enabled: false
    environments:
      production: {enabled: true, max_gap_minutes: 90, owner: enrich-team}
"""


def test_defaults_fill_every_key_a_job_leaves_out(tmp_path):
    jobs, _ = load_monitored_jobs(write(tmp_path, ENVIRONMENTS))
    ingest, enrich = jobs
    assert (ingest.severity, ingest.owner, ingest.job_name_exclude_regex) == ("CRITICAL", "data-platform", "_test(_|$)")
    assert ingest.schedule_type == "continuous"
    assert (enrich.schedule_type, enrich.max_gap_minutes, enrich.severity) == ("scheduled", 120, "WARNING")


def test_min_attempt_minutes_loads(tmp_path):
    jobs, _ = load_monitored_jobs(write(tmp_path, ENVIRONMENTS))
    assert jobs[0].min_attempt_minutes == 10 and jobs[1].min_attempt_minutes is None


def test_environment_overrides_apply_only_in_their_environment(tmp_path):
    ingest, enrich = load_monitored_jobs(write(tmp_path, ENVIRONMENTS))[0]
    lower = ingest.settings_for("lower")
    assert (lower.severity, lower.enabled, lower.max_retries) == ("WARNING", False, 3)
    assert ingest.settings_for("production") == ingest
    assert ingest.settings_for(None) == ingest
    production = enrich.settings_for("production")
    assert (production.enabled, production.max_gap_minutes, production.owner) == (True, 90, "enrich-team")
    assert enrich.settings_for("lower").enabled is False


def test_a_job_is_active_when_any_environment_switches_it_on(tmp_path):
    ingest, enrich = load_monitored_jobs(write(tmp_path, ENVIRONMENTS))[0]
    assert ingest.active and enrich.active
    assert not enrich.enabled


def test_environment_labels_must_be_defined_in_workspaces(tmp_path):
    text = ENVIRONMENTS.replace("lower: {severity: WARNING, enabled: false}", "staging: {enabled: false}")
    with pytest.raises(ConfigError, match="staging.*workspaces"):
        load_monitored_jobs(write(tmp_path, text))


@pytest.mark.parametrize(
    "override,message",
    [
        ("lower: {severity: LOUD}", "severity"),
        ("lower: {max_retries: -1}", "max_retries"),
        ("lower: {enabled: \"no\"}", "enabled"),
        ("lower: {colour: red}", "colour"),
        ("lower: warning", "mapping"),
    ],
)
def test_bad_environment_overrides_are_rejected(tmp_path, override, message):
    text = ENVIRONMENTS.replace("lower: {severity: WARNING, enabled: false}", override)
    with pytest.raises(ConfigError, match=message):
        load_monitored_jobs(write(tmp_path, text))


def test_unknown_keys_in_a_job_or_defaults_are_rejected(tmp_path):
    with pytest.raises(ConfigError, match="enviroments"):
        load_monitored_jobs(write(tmp_path, ENVIRONMENTS.replace("    environments:\n      lower", "    enviroments:\n      lower")))
    with pytest.raises(ConfigError, match="defaults.*severty"):
        load_monitored_jobs(write(tmp_path, ENVIRONMENTS.replace("  severity: WARNING\n  owner", "  severty: WARNING\n  owner")))


def test_defaults_cannot_set_names_or_patterns(tmp_path):
    text = ENVIRONMENTS.replace("defaults:\n", "defaults:\n  job_name_regex: \"x\"\n")
    with pytest.raises(ConfigError, match="defaults.*job_name_regex"):
        load_monitored_jobs(write(tmp_path, text))


TRIGGERED_JOB = """
  - job_name: export
    job_name_regex: "^export$"
    schedule_type: triggered
"""


def test_triggered_jobs_need_no_gap_limit(tmp_path):
    jobs, _ = load_monitored_jobs(write(tmp_path, "jobs:" + TRIGGERED_JOB))
    assert (jobs[0].schedule_type, jobs[0].max_gap_minutes) == ("triggered", None)


def test_triggered_jobs_reject_a_gap_limit(tmp_path):
    path = write(tmp_path, "jobs:" + TRIGGERED_JOB + "    max_gap_minutes: 60\n")
    with pytest.raises(ConfigError, match="triggered jobs have no schedule check"):
        load_monitored_jobs(path)


def test_triggered_jobs_reject_a_gap_limit_in_an_environment(tmp_path):
    text = ("workspaces:\n  - workspace_id: \"1001\"\n    environment: lower\njobs:" + TRIGGERED_JOB
            + "    environments:\n      lower: {max_gap_minutes: 60}\n")
    with pytest.raises(ConfigError, match="environments lower"):
        load_monitored_jobs(write(tmp_path, text))


def test_triggered_jobs_ignore_a_gap_limit_from_defaults(tmp_path):
    jobs, _ = load_monitored_jobs(write(tmp_path, "defaults:\n  max_gap_minutes: 90\njobs:" + TRIGGERED_JOB))
    assert jobs[0].max_gap_minutes is None


def _family(extra_dependencies):
    return """
jobs:
  - job_name: parent_a
    schedule_type: triggered
  - job_name: parent_b
    schedule_type: triggered
  - job_name: child
    schedule_type: triggered
dependencies:
  - job_name: child
    depends_on: parent_a
    dependency_type: child_job
""" + extra_dependencies


def test_a_job_can_have_only_one_parent(tmp_path):
    second = "  - job_name: child\n    depends_on: parent_b\n    dependency_type: child_job\n"
    with pytest.raises(ConfigError, match="only one parent"):
        load_monitored_jobs(write(tmp_path, _family(second)))


def test_a_child_job_may_also_depend_on_other_jobs(tmp_path):
    other = "  - job_name: child\n    depends_on: parent_b\n    dependency_type: job\n"
    _, deps = load_monitored_jobs(write(tmp_path, _family(other)))
    assert len(deps) == 2


PINNED = """
workspaces:
  - workspace_id: "1111"
    environment: production
  - workspace_id: "2222"
    environment: lower
jobs:
  - job_name: orders_ingest
    job_ids: [123456789012345, "234567890123456"]
    max_gap_minutes: 60
    environments:
      lower: {job_ids: ["345678901234567"]}
  - job_name: orders_enrich
    job_name_regex: "^orders_enrich_(prod|dev)$"
    max_gap_minutes: 60
"""


def test_job_ids_load_as_digit_strings(tmp_path):
    ingest, enrich = load_monitored_jobs(write(tmp_path, PINNED))[0]
    assert ingest.job_ids == ("123456789012345", "234567890123456")
    assert ingest.settings_for("lower").job_ids == ("345678901234567",)
    assert ingest.settings_for("production").job_ids == ingest.job_ids
    assert ingest.listed_job_ids == ("123456789012345", "234567890123456", "345678901234567")
    assert ingest.job_name_regex == "^orders_ingest$"  # the default pattern stays, used only where no IDs apply
    assert enrich.job_ids == () and enrich.listed_job_ids == ()


@pytest.mark.parametrize(
    "job_ids,message",
    [
        ("[]", "one or more"),
        ("123", "list"),
        ("[12a]", "whole numbers"),
        ("[true]", "whole numbers"),
        ("[-5]", "whole numbers"),
        ("[1.5]", "whole numbers"),
        ("[7, \"7\"]", "listed twice"),
    ],
)
def test_bad_job_ids_are_rejected(tmp_path, job_ids, message):
    text = PINNED.replace('job_ids: [123456789012345, "234567890123456"]', f"job_ids: {job_ids}")
    with pytest.raises(ConfigError, match=message):
        load_monitored_jobs(write(tmp_path, text))


def test_bad_job_ids_in_an_environment_name_the_environment(tmp_path):
    text = PINNED.replace('lower: {job_ids: ["345678901234567"]}', "lower: {job_ids: [x1]}")
    with pytest.raises(ConfigError, match="environments.lower.*whole numbers"):
        load_monitored_jobs(write(tmp_path, text))


def test_defaults_cannot_set_job_ids(tmp_path):
    text = "defaults:\n  job_ids: [1]\n" + PINNED
    with pytest.raises(ConfigError, match="defaults.*job_ids"):
        load_monitored_jobs(write(tmp_path, text))


def test_a_continuous_job_keeps_its_own_gap_limit(tmp_path):
    jobs, _ = load_monitored_jobs(write(tmp_path, "jobs:" + VALID_JOB + "    max_gap_minutes: 10\n"))
    assert (jobs[0].schedule_type, jobs[0].max_gap_minutes) == ("continuous", 10)


def test_an_environment_can_change_a_continuous_jobs_gap_limit(tmp_path):
    text = ("workspaces:\n  - workspace_id: \"1001\"\n    environment: lower\njobs:" + VALID_JOB
            + "    environments:\n      lower: {max_gap_minutes: 5}\n")
    job = load_monitored_jobs(write(tmp_path, text))[0][0]
    assert job.max_gap_minutes == 30
    assert job.settings_for("lower").max_gap_minutes == 5


def test_a_gap_limit_from_defaults_does_not_apply_to_continuous_jobs(tmp_path):
    # a scheduled job's gap between runs (hours) is not a stream's allowed downtime (minutes)
    jobs, _ = load_monitored_jobs(write(tmp_path, "defaults:\n  max_gap_minutes: 1440\njobs:" + VALID_JOB))
    assert jobs[0].max_gap_minutes == 30


def test_a_document_from_any_source_gets_the_same_rules():
    data = {"jobs": [{"job_name": "orders_ingest", "max_gap_minutes": 60}],
            "workspaces": [{"workspace_id": 123, "environment": "lower"}]}
    jobs, deps = parse_monitored_jobs(data, "Lakebase job list version 3")
    assert [j.job_name for j in jobs] == ["orders_ingest"] and deps == []
    assert parse_monitored_workspaces(data, "Lakebase job list version 3")[0].workspace_id == "123"


def test_errors_name_the_source():
    with pytest.raises(ConfigError, match="Lakebase job list version 3 lists no jobs"):
        parse_monitored_jobs({"jobs": []}, "Lakebase job list version 3")
