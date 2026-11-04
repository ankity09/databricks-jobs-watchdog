"""What a failure of each monitored job affects, through the whole dependency chain.

The job list's dependencies section gives the edges. For a `job` dependency, a
failure of depends_on affects job_name. A `child_job` dependency (job_name is a
child that depends_on starts) counts both ways: a parent failure affects its
children, which will not start, and a child failure affects its parent, whose
run fails, and so everything downstream of the parent. `service` dependencies
are not job-to-job edges: a CUSTOM row about a service lists the jobs that need
that service directly (findings.direct_dependents).

Both scans use affected_jobs: the Jobs API scan through findings.finalize_rows,
and the system table scan (sql/scan/21) through the temp view
watchdog_affected_jobs that register_affected_jobs creates.
"""

from collections import defaultdict

from jobs_watchdog.config import Dependency
from jobs_watchdog.identifiers import validate_identifier

AFFECTED_VIEW = "watchdog_affected_jobs"
AFFECTED_SCHEMA = "job_name STRING, affected_jobs ARRAY<STRING>, parent_job STRING"
IMPACT_SCHEMA = "job_name STRING, parent_job STRING, affects_directly ARRAY<STRING>, affects_in_all ARRAY<STRING>"


def parent_jobs(dependencies):
    """child job name -> its parent's job name, from the child_job dependencies."""
    return {d.job_name: d.depends_on for d in dependencies if d.dependency_type == "child_job"}


def impact_edges(dependencies):
    """job name -> the jobs its failure affects directly."""
    edges = defaultdict(set)
    for d in dependencies:
        if d.dependency_type == "job":
            edges[d.depends_on].add(d.job_name)
        elif d.dependency_type == "child_job":
            edges[d.depends_on].add(d.job_name)  # a parent failure: the child does not start
            edges[d.job_name].add(d.depends_on)  # a child failure: the parent's run fails
    return edges


def affected_jobs(dependencies):
    """job name -> every job downstream of it, sorted, never the job itself.

    Loops are fine: each job is visited once.
    """
    edges = impact_edges(dependencies)
    affected = {}
    for start in edges:
        seen, stack = set(), list(edges[start])
        while stack:
            job = stack.pop()
            if job == start or job in seen:
                continue
            seen.add(job)
            stack.extend(edges.get(job, ()))
        affected[start] = sorted(seen)
    return affected


def dependency_loops(dependencies):
    """Groups of jobs that depend on each other in a loop, through job dependencies only.

    child_job links always point both ways, so they are left out here. Each loop
    is a sorted list of job names, and the loops are sorted too.
    """
    edges = defaultdict(set)
    for d in dependencies:
        if d.dependency_type == "job":
            edges[d.depends_on].add(d.job_name)
    nodes = set(edges) | {job for targets in edges.values() for job in targets}
    reach = {}
    for start in nodes:
        seen, stack = set(), list(edges.get(start, ()))
        while stack:
            job = stack.pop()
            if job in seen:
                continue
            seen.add(job)
            stack.extend(edges.get(job, ()))
        reach[start] = seen
    loops = {
        tuple(sorted({start} | {job for job in reach[start] if start in reach[job]}))
        for start in nodes
        if start in reach[start]
    }
    return sorted(list(loop) for loop in loops)


def impact_table(jobs, dependencies):
    """One row per configured job: (job_name, parent_job, affects_directly, affects_in_all)."""
    edges = impact_edges(dependencies)
    affected = affected_jobs(dependencies)
    parents = parent_jobs(dependencies)
    return [
        (job.job_name, parents.get(job.job_name), sorted(edges.get(job.job_name, ())), affected.get(job.job_name, []))
        for job in jobs
    ]


def affected_rows(dependencies):
    """Rows of the temp view watchdog_affected_jobs: (job_name, affected_jobs, parent_job)."""
    affected = affected_jobs(dependencies)
    parents = parent_jobs(dependencies)
    return [(name, affected.get(name, []), parents.get(name)) for name in sorted(set(affected) | set(parents))]


def register_affected_jobs(spark, catalog, schema):
    """Create the temp view watchdog_affected_jobs from <catalog>.<schema>.job_dependencies.

    The system table scan (sql/scan/21) joins it for affected_jobs and
    parent_job. Returns the rows it holds.
    """
    validate_identifier(catalog, "catalog")
    validate_identifier(schema, "schema")
    rows = (spark.table(f"{catalog}.{schema}.job_dependencies")
            .select("job_name", "depends_on", "dependency_type").collect())
    dependencies = [Dependency(row["job_name"], row["depends_on"], row["dependency_type"], "") for row in rows]
    view_rows = affected_rows(dependencies)
    spark.createDataFrame(view_rows, schema=AFFECTED_SCHEMA).createOrReplaceTempView(AFFECTED_VIEW)
    return view_rows
