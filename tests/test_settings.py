import pytest

from jobs_watchdog.settings import WIDGETS, read_settings, widget_defaults

ACCELERATOR = """
target:
  catalog: main
  schema: watchdog
  region: us-east-1
auth:
  mode: current_workspace
  secret_scope: ""
scan:
  lookback_hours: 24
  monitored_jobs_path: config/monitored_jobs.example.yml
"""


def write(folder, name, text):
    (folder / name).write_text(text)


def test_defaults_come_from_accelerator_yaml(tmp_path):
    write(tmp_path, "accelerator.yaml", ACCELERATOR)
    defaults = widget_defaults(tmp_path)
    assert set(defaults) == set(WIDGETS)
    assert defaults["catalog"] == "main"
    assert defaults["lookback_hours"] == "24"
    assert defaults["scan_id"] == ""
    assert defaults["client_secret_key"] == "client_secret"


def test_local_copy_wins_over_the_tracked_file(tmp_path):
    write(tmp_path, "accelerator.yaml", ACCELERATOR)
    write(tmp_path, "accelerator.local.yaml", ACCELERATOR.replace("catalog: main", "catalog: ops"))
    assert widget_defaults(tmp_path)["catalog"] == "ops"


def test_missing_file_gives_built_in_defaults(tmp_path):
    defaults = widget_defaults(tmp_path)
    assert defaults["schema"] == "watchdog"
    assert defaults["lookback_hours"] == "48"
    assert defaults["catalog"] == ""


def test_read_settings_validates_and_converts(tmp_path):
    settings = read_settings({"catalog": "main", "schema": "watchdog", "lookback_hours": "12",
                              "monitored_jobs_path": "config/jobs.yml"}, tmp_path)
    assert settings.lookback_hours == 12
    assert settings.monitored_jobs_path == tmp_path / "config" / "jobs.yml"


def test_absolute_paths_are_kept(tmp_path):
    settings = read_settings({"monitored_jobs_path": "/Volumes/main/ops/files/jobs.yml"}, tmp_path)
    assert str(settings.monitored_jobs_path) == "/Volumes/main/ops/files/jobs.yml"


def test_empty_catalog_explains_where_to_set_it(tmp_path):
    with pytest.raises(ValueError, match="catalog is empty"):
        read_settings({"catalog": " "}, tmp_path)


def test_bad_schema_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="schema"):
        read_settings({"catalog": "main", "schema": "my schema"}, tmp_path)


@pytest.mark.parametrize("hours", ["0", "-3", "two"])
def test_lookback_hours_must_be_a_positive_whole_number(tmp_path, hours):
    with pytest.raises(ValueError, match="lookback_hours"):
        read_settings({"lookback_hours": hours}, tmp_path)


def test_service_principal_needs_a_secret_scope(tmp_path):
    with pytest.raises(ValueError, match="secret_scope"):
        read_settings({"auth_mode": "service_principal", "secret_scope": ""}, tmp_path)


def test_unknown_auth_mode_is_rejected(tmp_path):
    with pytest.raises(ValueError, match="auth_mode"):
        read_settings({"auth_mode": "pat"}, tmp_path)


def test_values_are_trimmed(tmp_path):
    settings = read_settings({"catalog": " main ", "scan_id": " 123 "}, tmp_path)
    assert (settings.catalog, settings.scan_id) == ("main", "123")


def test_a_broken_accelerator_file_is_an_error_not_a_silent_fallback(tmp_path):
    from jobs_watchdog.config import ConfigError

    write(tmp_path, "accelerator.yaml", ACCELERATOR)
    write(tmp_path, "accelerator.local.yaml", "target:\n  catalog: main\n schema: broken-indent\n")
    with pytest.raises(ConfigError, match="accelerator.local.yaml"):
        widget_defaults(tmp_path)


def test_pipeline_url_parameter_defaults_to_PIPELINE_URL(tmp_path):
    assert widget_defaults(tmp_path)["pipeline_url_parameter"] == "PIPELINE_URL"
