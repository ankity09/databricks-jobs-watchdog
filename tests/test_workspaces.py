from jobs_watchdog.jobs_api import Target
from jobs_watchdog.workspaces import NAMES_VIEW, build_targets, register_workspace_names


class Row(dict):
    def asDict(self):
        return dict(self)


class FakeFrame:
    def __init__(self, spark, rows, fail=None):
        self.spark, self.rows, self.fail = spark, rows, fail

    def collect(self):
        if self.fail:
            raise self.fail
        return self.rows

    def createOrReplaceTempView(self, name):
        self.spark.views[name] = self


class FakeSpark:
    def __init__(self, rows=(), fail=None):
        self.rows, self.fail, self.views, self.empty_schema = list(rows), fail, {}, None

    def sql(self, text, args=None):
        return FakeFrame(self, self.rows, self.fail)

    def createDataFrame(self, data, schema=None):
        self.empty_schema = schema
        return FakeFrame(self, list(data))


def test_names_view_is_registered_from_the_workspaces_table():
    spark = FakeSpark([Row(workspace_id="1001", workspace_name="analytics", workspace_url="https://a.example.invalid",
                           status="RUNNING")])
    names, error = register_workspace_names(spark)
    assert error is None
    assert names == [{"workspace_id": "1001", "workspace_name": "analytics",
                      "workspace_url": "https://a.example.invalid", "status": "RUNNING"}]
    assert spark.views[NAMES_VIEW].rows == spark.rows


def test_unreadable_workspaces_table_gives_an_empty_view_and_the_reason():
    spark = FakeSpark(fail=PermissionError("PERMISSION_DENIED on system.access.workspaces_latest"))
    names, error = register_workspace_names(spark)
    assert names == []
    assert "PERMISSION_DENIED" in error
    assert spark.views[NAMES_VIEW].rows == []
    assert spark.empty_schema.startswith("workspace_id STRING")


NAMES = [{"workspace_id": "1001", "workspace_name": "analytics", "workspace_url": "https://a.example.invalid"},
         {"workspace_id": "2002", "workspace_name": "ingest", "workspace_url": None}]
REGION = [{"workspace_id": "1001", "account_id": "acct"}, {"workspace_id": "2002", "account_id": "acct"},
          {"workspace_id": "3003", "account_id": "acct"}]


def test_current_workspace_mode_checks_only_this_workspace():
    targets, missing = build_targets("current_workspace", 1001, REGION, NAMES)
    assert targets == [Target("1001", "analytics", None)]
    assert missing == []


def test_service_principal_mode_checks_every_workspace_with_a_url():
    targets, missing = build_targets("service_principal", "1001", REGION, NAMES)
    assert targets == [Target("1001", "analytics", "https://a.example.invalid")]
    assert missing == [Target("2002", "ingest", None), Target("3003", None, None)]
