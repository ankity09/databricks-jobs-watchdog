import pytest

from jobs_watchdog.states import (
    category_from_termination,
    status_from_api,
    status_from_system_table,
)


@pytest.mark.parametrize(
    "result_state,expected",
    [
        ("SUCCEEDED", "HEALTHY"),
        ("FAILED", "FAILED"),
        ("ERROR", "FAILED"),
        ("TIMED_OUT", "FAILED"),
        ("CANCELLED", "WARNING"),
        ("SKIPPED", "WARNING"),
        ("BLOCKED", "WARNING"),
        (None, None),
        ("SOMETHING_NEW", "UNKNOWN"),
    ],
)
def test_system_table_states(result_state, expected):
    assert status_from_system_table(result_state) == expected


@pytest.mark.parametrize(
    "life_cycle",
    ["RUNNING", "PENDING", "QUEUED", "BLOCKED", "WAITING_FOR_RETRY", "TERMINATING"],
)
def test_api_in_progress_is_healthy(life_cycle):
    assert status_from_api(life_cycle, None) == "HEALTHY"


@pytest.mark.parametrize(
    "life_cycle,result_state,expected",
    [
        ("INTERNAL_ERROR", None, "FAILED"),
        ("SKIPPED", None, "WARNING"),
        ("TERMINATED", "SUCCESS", "HEALTHY"),
        ("TERMINATED", "EXCLUDED", "HEALTHY"),
        ("TERMINATED", "DISABLED", "HEALTHY"),
        ("TERMINATED", "SUCCESS_WITH_FAILURES", "WARNING"),
        ("TERMINATED", "FAILED", "FAILED"),
        ("TERMINATED", "TIMEDOUT", "FAILED"),
        ("TERMINATED", "UPSTREAM_FAILED", "FAILED"),
        ("TERMINATED", "CANCELED", "WARNING"),
        ("TERMINATED", "UPSTREAM_CANCELED", "WARNING"),
        ("TERMINATED", "MAXIMUM_CONCURRENT_RUNS_REACHED", "WARNING"),
        ("TERMINATED", None, "UNKNOWN"),
        (None, None, "UNKNOWN"),
    ],
)
def test_api_final_states(life_cycle, result_state, expected):
    assert status_from_api(life_cycle, result_state) == expected


def test_api_accepts_enum_like_values():
    class FakeEnum:
        def __init__(self, value):
            self.value = value

    assert status_from_api(FakeEnum("TERMINATED"), FakeEnum("FAILED")) == "FAILED"


@pytest.mark.parametrize(
    "termination_type,expected",
    [
        ("CLIENT_ERROR", "FUNCTIONAL"),
        ("INTERNAL_ERROR", "INFRASTRUCTURE"),
        ("CLOUD_FAILURE", "INFRASTRUCTURE"),
        ("SUCCESS", "NONE"),
        (None, "FUNCTIONAL"),
        ("SOMETHING_NEW", "FUNCTIONAL"),
    ],
)
def test_termination_type_to_category(termination_type, expected):
    assert category_from_termination(termination_type) == expected
