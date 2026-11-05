import { describe, expect, it } from "vitest";
import type { JobEntry, JobListDocument } from "../../../shared/joblist/types";
import { effectivePatterns, environmentLabels, INHERIT, inheritedSettings, toEntry, toFormValues } from "./job-form";

const DOC: JobListDocument = {
  workspaces: [
    { workspace_name: "example-prod", environment: "production" },
    { workspace_name: "example-prod-eu", environment: "production" },
    { workspace_id: "1111111111111111", environment: "lower" },
  ],
  jobs: [],
};

const FULL: JobEntry = {
  job_name: "orders_enrich",
  job_name_regex: "^orders_enrich_(web|mobile)_(prod|dev)$",
  job_name_exclude_regex: "_test(_|$)",
  job_ids: ["9007199254740993"],
  schedule_type: "scheduled",
  max_gap_minutes: 90,
  max_runtime_minutes: 45,
  max_retries: 2,
  min_attempt_minutes: 10,
  severity: "CRITICAL",
  owner: "ingestion-team",
  enabled: false,
  notes: "Runs hourly.",
  environments: { lower: { enabled: false }, production: { job_ids: ["123456789012345"], severity: "WARNING" } },
};

const roundTrip = (entry: JobEntry) => toEntry(toFormValues(entry, environmentLabels(DOC, entry)), entry);

describe("job form values", () => {
  it("lists each workspace label once, in the order of the workspaces section", () => {
    expect(environmentLabels(DOC, { job_name: "x" })).toEqual(["production", "lower"]);
    expect(environmentLabels(DOC, { job_name: "x", environments: { staging: { owner: "a" } } })).toEqual([
      "production",
      "lower",
      "staging",
    ]);
  });

  it("gives back the same entry when nothing was edited", () => {
    expect(roundTrip(FULL)).toEqual(FULL);
    expect(roundTrip({ job_name: "orders_ingest" })).toEqual({ job_name: "orders_ingest" });
  });

  it("removes a key whose field was emptied", () => {
    const values = toFormValues(FULL, environmentLabels(DOC, FULL));
    const entry = toEntry({ ...values, max_retries: "", owner: "", job_ids: [], notes: "" }, FULL);
    expect(entry).not.toHaveProperty("max_retries");
    expect(entry).not.toHaveProperty("owner");
    expect(entry).not.toHaveProperty("job_ids");
    expect(entry).not.toHaveProperty("notes");
    expect(entry.max_gap_minutes).toBe(90);
  });

  it("keeps a null that blocks a default, unless the field is filled in", () => {
    const blocked: JobEntry = { job_name: "orders_export", max_runtime_minutes: undefined, owner: "" };
    Object.assign(blocked, { max_runtime_minutes: null });
    expect(roundTrip(blocked)).toEqual(blocked);
    const values = toFormValues(blocked, []);
    expect(toEntry({ ...values, max_runtime_minutes: "30" }, blocked).max_runtime_minutes).toBe(30);
  });

  it("stores 'no exclusion' as null, and reads an empty exclusion the same way", () => {
    const empty: JobEntry = { job_name: "a", job_name_exclude_regex: "" };
    const off = toFormValues(empty, []);
    expect(off.exclude_off).toBe(true);
    expect(toEntry(off, empty).job_name_exclude_regex).toBe("");
    const values = toFormValues({ job_name: "a" }, []);
    expect(toEntry({ ...values, exclude_off: true }, { job_name: "a" }).job_name_exclude_regex).toBeNull();
    expect(toEntry({ ...off, exclude_off: false }, empty)).not.toHaveProperty("job_name_exclude_regex");
  });

  it("keeps an invalid number as typed, so the rules can say what is wrong", () => {
    const values = toFormValues({ job_name: "a" }, []);
    expect(toEntry({ ...values, max_gap_minutes: "1.5" }, { job_name: "a" }).max_gap_minutes).toBe(1.5);
    expect(toEntry({ ...values, max_gap_minutes: "-3" }, { job_name: "a" }).max_gap_minutes).toBe(-3);
  });

  it("sets an environment override only where a field is set, and drops empty labels", () => {
    const values = toFormValues({ job_name: "a" }, ["production", "lower"]);
    expect(values.environments.map((row) => row.label)).toEqual(["production", "lower"]);
    expect(values.environments[0]?.severity).toBe(INHERIT);
    const environments = values.environments.map((row) =>
      row.label === "lower" ? { ...row, enabled: "off" as const, max_gap_minutes: "4500" } : row,
    );
    expect(toEntry({ ...values, environments }, { job_name: "a" }).environments).toEqual({
      lower: { enabled: false, max_gap_minutes: 4500 },
    });
    expect(toEntry(values, { job_name: "a" })).not.toHaveProperty("environments");
  });
});

describe("effectivePatterns", () => {
  const inherited = inheritedSettings({ defaults: { job_name_exclude_regex: "_test(_|$)" }, jobs: [] });

  it("builds ^<name>$ for a job with no pattern, as the loader does", () => {
    expect(effectivePatterns({ job_name: "orders.ingest" }, inherited)).toEqual({ pattern: "^orders\\.ingest$", exclude: "_test(_|$)" });
  });

  it("passes no pattern while a new job has no name yet", () => {
    expect(effectivePatterns({ job_name: "" }, inherited)).toEqual({ pattern: "", exclude: "_test(_|$)" });
    expect(effectivePatterns({ job_name: "  " }, inherited)).toEqual({ pattern: "", exclude: "_test(_|$)" });
  });
});
