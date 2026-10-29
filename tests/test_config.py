import textwrap
from pathlib import Path

import pytest

from jobs_watchdog.config import (
    ConfigError,
    MonitoredWorkspace,
    load_accelerator,
    load_monitored_jobs,
    load_monitored_workspaces,
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
    assert jobs[0].max_gap_minutes is None
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
