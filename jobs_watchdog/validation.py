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
        ("tables exist", not absent, f"missing {', '.join(absent)}" if absent else "monitored_jobs, job_dependencies, findings"),
        ("config has enabled jobs", enabled_jobs > 0, f"{enabled_jobs} enabled"),
        ("both sources wrote findings", not no_rows,
         f"no rows from {', '.join(no_rows)}" + (f"; {seen}" if seen else "") if no_rows else seen),
        ("every enabled job has findings", not missing,
         ", ".join(f"{row['job_name']} ({row['source']})" for row in missing) if missing else "yes"),
        ("no duplicate keys", not duplicates, f"{len(duplicates)} duplicated keys" if duplicates else "none"),
    ]
