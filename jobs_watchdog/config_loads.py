"""Record each load of the monitored-jobs list in the config_loads table.

Notebook 02 adds one row every time it loads the list, whether the load worked
or not. The Watchdog app reads the newest row to show which version the scans
use, and whether the last load failed.
"""

from dataclasses import dataclass
from datetime import datetime

from jobs_watchdog.config import CONFIG_SOURCES
from jobs_watchdog.identifiers import validate_identifier
from jobs_watchdog.sqlfiles import run_sql

COLUMNS = (
    ("loaded_at", "TIMESTAMP"),
    ("scan_id", "STRING"),
    ("source", "STRING"),
    ("source_ref", "STRING"),
    ("version", "BIGINT"),
    ("job_count", "INT"),
    ("status", "STRING"),
    ("error", "STRING"),
)
LOAD_VIEW = "watchdog_config_load"
STATUSES = ("OK", "FAILED")


@dataclass(frozen=True)
class ConfigLoad:
    loaded_at: datetime
    scan_id: str | None
    source: str
    source_ref: str | None
    version: int | None
    job_count: int | None
    status: str
    error: str | None

    def __post_init__(self):
        if self.source not in CONFIG_SOURCES:
            raise ValueError(f"source must be one of {sorted(CONFIG_SOURCES)}, got {self.source!r}")
        if self.status not in STATUSES:
            raise ValueError(f"status must be OK or FAILED, got {self.status!r}")


def record_config_load(spark, catalog, schema, load):
    """Add one row to config_loads."""
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    ddl = ", ".join(f"{name} {data_type}" for name, data_type in COLUMNS)
    row = tuple(getattr(load, name) for name, _ in COLUMNS)
    spark.createDataFrame([row], schema=ddl).createOrReplaceTempView(LOAD_VIEW)
    run_sql(spark, "sql/config/05_record_config_load.sql", catalog=catalog, schema=schema)


def record_config_load_safely(spark, catalog, schema, load):
    """Record a load, and return a short message instead of raising when that fails.

    For the failure path of notebook 02, where the original error matters more
    than the failure to write its row.
    """
    try:
        record_config_load(spark, catalog, schema, load)
    except Exception as err:
        lines = str(err).strip().splitlines()
        return f"{type(err).__name__}: {lines[0][:300] if lines else ''}"
    return None
