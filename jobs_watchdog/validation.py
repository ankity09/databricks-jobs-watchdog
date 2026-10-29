"""The Phase 1 checks that notebook 07 prints as PASS or FAIL lines."""

SOURCES = ("SYSTEM_TABLES", "JOBS_API")


def phase_1_checks(tables, enabled_jobs, by_source, missing, duplicates):
    """Return (check, passed, detail) tuples.

    tables: {table name: exists}. enabled_jobs: enabled rows in monitored_jobs.
    by_source, missing and duplicates: rows of sql/validate/40, 42 and 41.
    """
    absent = sorted(name for name, exists in tables.items() if not exists)
    totals = {}
    for row in by_source:
        source = row["source"]
        count, scan_id = totals.get(source, (0, row["scan_id"]))
        totals[source] = (count + row["findings"], scan_id)
    no_rows = [source for source in SOURCES if source not in totals]
    seen = ", ".join(f"{source}: {count} rows in scan {scan_id}" for source, (count, scan_id) in sorted(totals.items()))
    return [
        ("tables exist", not absent, f"missing {', '.join(absent)}" if absent else ", ".join(tables)),
        ("config has enabled jobs", enabled_jobs > 0, f"{enabled_jobs} enabled"),
        ("both sources wrote findings", not no_rows,
         f"no rows from {', '.join(no_rows)}" + (f"; {seen}" if seen else "") if no_rows else seen),
        ("every enabled job has findings", not missing,
         ", ".join(f"{row['job_name']} ({row['source']})" for row in missing) if missing else "yes"),
        ("no duplicate keys", not duplicates, f"{len(duplicates)} duplicated keys" if duplicates else "none"),
    ]


def service_principal_verdict(results):
    """Split per-workspace service principal checks into (required_failures, warnings).

    results: (label, ok, detail) for each workspace notebook 00 tried. One
    reachable workspace is enough to go on; the scan writes api_unreachable
    rows for the others. Every workspace that failed becomes a warning.
    """
    warnings = [f"service principal on {label}: {detail}" for label, ok, detail in results if not ok]
    if not results:
        return ["service principal reaches no workspaces: no workspaces to try in this region"], warnings
    if not any(ok for _, ok, _ in results):
        return [f"service principal reaches none of the {len(results)} workspaces tried"], warnings
    return [], warnings
