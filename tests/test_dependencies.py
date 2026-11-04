import pytest

from jobs_watchdog.config import Dependency, MonitoredJob
from jobs_watchdog.dependencies import (
    AFFECTED_SCHEMA,
    AFFECTED_VIEW,
    affected_jobs,
    affected_rows,
    dependency_loops,
    impact_edges,
    impact_table,
    parent_jobs,
    register_affected_jobs,
)


def dep(job_name, depends_on, dependency_type="job"):
    return Dependency(job_name, depends_on, dependency_type, "")


def job(name):
    return MonitoredJob(name, f"^{name}$", "scheduled", 90, None, None, "WARNING", "team", True, "")


def test_a_failure_affects_the_whole_chain_not_only_direct_dependents():
    deps = [dep("enrich", "ingest"), dep("report", "enrich"), dep("export", "report")]
    assert affected_jobs(deps)["ingest"] == ["enrich", "export", "report"]
    assert affected_jobs(deps)["report"] == ["export"]
    assert "export" not in affected_jobs(deps)


def test_branches_are_merged_and_sorted():
    deps = [dep("b", "a"), dep("c", "a"), dep("d", "b"), dep("d", "c")]
    assert affected_jobs(deps)["a"] == ["b", "c", "d"]


def test_loops_end_and_never_list_the_failed_job_itself():
    deps = [dep("b", "a"), dep("a", "b"), dep("c", "b")]
    affected = affected_jobs(deps)
    assert affected["a"] == ["b", "c"]
    assert affected["b"] == ["a", "c"]


def test_a_parent_failure_affects_its_children():
    deps = [dep("child", "parent", "child_job")]
    assert affected_jobs(deps)["parent"] == ["child"]


def test_a_child_failure_affects_its_parent_and_everything_downstream_of_it():
    deps = [
        dep("child_a", "parent", "child_job"),
        dep("child_b", "parent", "child_job"),
        dep("downstream", "parent"),
        dep("further", "downstream"),
    ]
    # the parent's run fails, so its dependents and its other children are affected too
    assert affected_jobs(deps)["child_a"] == ["child_b", "downstream", "further", "parent"]


def test_services_are_not_job_impact_edges():
    deps = [dep("ingest", "kafka", "service"), dep("enrich", "ingest")]
    affected = affected_jobs(deps)
    assert "kafka" not in affected
    assert affected["ingest"] == ["enrich"]
    assert "kafka" not in impact_edges(deps)


def test_parent_jobs_come_from_child_job_dependencies_only():
    deps = [dep("child", "parent", "child_job"), dep("other", "parent"), dep("parent", "kafka", "service")]
    assert parent_jobs(deps) == {"child": "parent"}


def test_dependency_loops_find_jobs_that_depend_on_each_other():
    deps = [dep("score", "classify"), dep("classify", "score"), dep("x", "y")]
    assert dependency_loops(deps) == [["classify", "score"]]


def test_dependency_loops_ignore_child_jobs_which_always_point_both_ways():
    assert dependency_loops([dep("child", "parent", "child_job")]) == []


def test_dependency_loops_find_longer_loops_once():
    deps = [dep("b", "a"), dep("c", "b"), dep("a", "c")]
    assert dependency_loops(deps) == [["a", "b", "c"]]


def test_impact_table_lists_every_configured_job():
    jobs = [job("ingest"), job("enrich"), job("export"), job("lonely")]
    deps = [dep("enrich", "ingest"), dep("export", "enrich", "child_job")]
    rows = {row[0]: row[1:] for row in impact_table(jobs, deps)}
    assert rows["ingest"] == (None, ["enrich"], ["enrich", "export"])
    assert rows["export"] == ("enrich", ["enrich"], ["enrich"])
    assert rows["lonely"] == (None, [], [])
    assert list(rows) == ["ingest", "enrich", "export", "lonely"]


def test_affected_rows_hold_jobs_with_dependents_or_a_parent():
    deps = [dep("enrich", "ingest"), dep("export", "enrich", "child_job")]
    assert affected_rows(deps) == [
        ("enrich", ["export"], None),
        ("export", ["enrich"], "enrich"),
        ("ingest", ["enrich", "export"], None),
    ]


class Row(dict):
    pass


class FakeFrame:
    def __init__(self, spark, rows):
        self.spark, self.rows = spark, rows

    def select(self, *columns):
        self.spark.selected = columns
        return self

    def collect(self):
        return self.rows

    def createOrReplaceTempView(self, name):
        self.spark.views[name] = self


class FakeSpark:
    def __init__(self, rows):
        self.rows, self.views, self.tables, self.schema = rows, {}, [], None

    def table(self, name):
        self.tables.append(name)
        return FakeFrame(self, self.rows)

    def createDataFrame(self, data, schema=None):
        self.schema = schema
        return FakeFrame(self, list(data))


def test_register_affected_jobs_builds_the_view_from_the_dependencies_table():
    spark = FakeSpark([
        Row(job_name="enrich", depends_on="ingest", dependency_type="job"),
        Row(job_name="ingest", depends_on="kafka", dependency_type="service"),
        Row(job_name="export", depends_on="enrich", dependency_type="child_job"),
    ])
    rows = register_affected_jobs(spark, "main", "watchdog")
    assert spark.tables == ["main.watchdog.job_dependencies"]
    assert spark.selected == ("job_name", "depends_on", "dependency_type")
    assert spark.schema == AFFECTED_SCHEMA
    assert spark.views[AFFECTED_VIEW].rows == rows
    assert ("export", ["enrich"], "enrich") in rows


def test_register_affected_jobs_with_no_dependencies_gives_an_empty_view():
    spark = FakeSpark([])
    assert register_affected_jobs(spark, "main", "watchdog") == []
    assert spark.views[AFFECTED_VIEW].rows == []


def test_register_affected_jobs_checks_the_names():
    with pytest.raises(ValueError):
        register_affected_jobs(FakeSpark([]), "main; drop", "watchdog")
