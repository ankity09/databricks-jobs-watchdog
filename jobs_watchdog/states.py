"""Map Databricks run states to Watchdog statuses.

System tables and the Jobs API spell states differently (SUCCEEDED versus
SUCCESS, CANCELLED versus CANCELED, TIMED_OUT versus TIMEDOUT), so each
source has its own mapping. Statuses are HEALTHY, WARNING, FAILED, UNKNOWN.
"""

SYSTEM_FAILED_RESULTS = {"FAILED", "ERROR", "TIMED_OUT"}
API_FAILED_RESULTS = {"FAILED", "TIMEDOUT"}

_SYSTEM_STATUS = {
    "SUCCEEDED": "HEALTHY",
    "FAILED": "FAILED",
    "ERROR": "FAILED",
    "TIMED_OUT": "FAILED",
    "CANCELLED": "WARNING",
    "SKIPPED": "WARNING",
    "BLOCKED": "WARNING",
}

_API_IN_PROGRESS = {"RUNNING", "PENDING", "QUEUED", "BLOCKED", "WAITING_FOR_RETRY", "TERMINATING"}

_API_RESULT_STATUS = {
    "SUCCESS": "HEALTHY",
    "EXCLUDED": "HEALTHY",
    "DISABLED": "HEALTHY",
    "SUCCESS_WITH_FAILURES": "WARNING",
    "FAILED": "FAILED",
    "TIMEDOUT": "FAILED",
    "UPSTREAM_FAILED": "FAILED",
    "CANCELED": "WARNING",
    "UPSTREAM_CANCELED": "WARNING",
    "MAXIMUM_CONCURRENT_RUNS_REACHED": "WARNING",
}

_TERMINATION_CATEGORY = {
    "CLIENT_ERROR": "FUNCTIONAL",
    "INTERNAL_ERROR": "INFRASTRUCTURE",
    "CLOUD_FAILURE": "INFRASTRUCTURE",
    "SUCCESS": "NONE",
}


def as_text(value):
    """Return an SDK enum's value, a plain string, or None."""
    if value is None:
        return None
    return getattr(value, "value", value)


def status_from_system_table(result_state):
    """Status for a system-table run row; None means the run is still open."""
    result_state = as_text(result_state)
    if result_state is None:
        return None
    return _SYSTEM_STATUS.get(result_state, "UNKNOWN")


def status_from_api(life_cycle_state, result_state):
    """Status for a Jobs API run or task state."""
    life_cycle_state, result_state = as_text(life_cycle_state), as_text(result_state)
    if life_cycle_state in _API_IN_PROGRESS:
        return "HEALTHY"
    if life_cycle_state == "INTERNAL_ERROR":
        return "FAILED"
    if life_cycle_state == "SKIPPED":
        return "WARNING"
    if result_state is None:
        return "UNKNOWN"
    return _API_RESULT_STATUS.get(result_state, "UNKNOWN")


def category_from_termination(termination_type):
    """failure_category for a failed run, from its termination type."""
    return _TERMINATION_CATEGORY.get(as_text(termination_type), "FUNCTIONAL")
