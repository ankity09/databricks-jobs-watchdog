from datetime import datetime, timezone

import pytest

from jobs_watchdog.config_loads import COLUMNS, LOAD_VIEW, ConfigLoad, record_config_load
from jobs_watchdog.sqlfiles import load_sql
from jobs_watchdog.upgrade import ddl_columns

NOW = datetime(2026, 11, 5, 12, 0, tzinfo=timezone.utc)


class FakeFrame:
    def __init__(self, spark, data, schema):
        self.spark, self.data, self.schema = spark, data, schema

    def createOrReplaceTempView(self, name):
        self.spark.views[name] = self


class FakeSpark:
    def __init__(self):
        self.views, self.calls = {}, []

    def createDataFrame(self, data, schema=None):
        return FakeFrame(self, data, schema)

    def sql(self, text, args=None):
        self.calls.append((text, args))


def test_columns_match_the_table_ddl():
    assert list(COLUMNS) == [(c.name, c.data_type) for c in ddl_columns("sql/setup/07_create_config_loads.sql")]


def test_the_insert_selects_the_columns_in_table_order():
    sqlglot = pytest.importorskip("sqlglot")
    from tests.helpers import for_parsing

    selected = sqlglot.parse_one(for_parsing(load_sql("sql/config/05_record_config_load.sql")),
                                 read="databricks").expression.named_selects
    assert selected == [name for name, _ in COLUMNS]


def test_record_config_load_fills_the_view_then_inserts():
    spark = FakeSpark()
    record_config_load(spark, "main", "watchdog",
                       ConfigLoad(NOW, "run-1", "lakebase", "projects/p/branches/b/databases/d", 4, 2, "OK", None))
    assert spark.views[LOAD_VIEW].data == [(NOW, "run-1", "lakebase", "projects/p/branches/b/databases/d", 4, 2,
                                            "OK", None)]
    assert spark.views[LOAD_VIEW].schema.startswith("loaded_at TIMESTAMP, scan_id STRING")
    [(text, args)] = spark.calls
    assert "config_loads" in text and "watchdog_config_load" in text
    assert args == {"catalog": "main", "schema": "watchdog"}


def test_a_failed_load_keeps_its_error():
    spark = FakeSpark()
    record_config_load(spark, "main", "watchdog",
                       ConfigLoad(NOW, "run-1", "yaml", "config/x.yml", None, None, "FAILED", "ConfigError: bad"))
    assert spark.views[LOAD_VIEW].data[0][4:] == (None, None, "FAILED", "ConfigError: bad")


def test_status_and_source_are_checked():
    with pytest.raises(ValueError, match="OK or FAILED"):
        ConfigLoad(NOW, "run-1", "yaml", "x", None, 1, "DONE", None)
    with pytest.raises(ValueError, match="lakebase.*yaml|yaml.*lakebase"):
        ConfigLoad(NOW, "run-1", "file", "x", None, 1, "OK", None)
