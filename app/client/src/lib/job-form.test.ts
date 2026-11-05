import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { deepEqual } from "../../../shared/joblist/apply";
import { normalizeDocument, validateDocument } from "../../../shared/joblist/rules";
import type { JobEntry, JobListDocument } from "../../../shared/joblist/types";
import { pythonYamlOptions } from "../../../shared/joblist/yamlOptions";
import { effectivePatterns, environmentLabels, INHERIT, inheritedSettings, toEntry, toFormValues } from "./job-form";

const CORPUS = join(__dirname, "../../../../tests/fixtures/job-lists");

/** Each corpus file that loads without issues, as an import stores it: the rules checked on the raw parse, then normalized. */
function loadableFixtures(): [string, JobListDocument][] {
  return readdirSync(CORPUS)
    .filter((file) => file.endsWith(".yml"))
    .sort()
    .flatMap((file): [string, JobListDocument][] => {
      const raw = parse(readFileSync(join(CORPUS, file), "utf8"), pythonYamlOptions) as Record<string, unknown>;
      if (validateDocument(raw).length > 0) return [];
      // The two sections the form reads, as readJobListYaml stores them.
      const { jobs, workspaces } = normalizeDocument(raw);
      const doc: JobListDocument = {
        jobs: Array.isArray(jobs) ? (jobs as JobEntry[]) : [],
        ...(Array.isArray(workspaces) ? { workspaces: workspaces as JobListDocument["workspaces"] } : {}),
      };
      return [[file, doc]];
    });
}

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

  it("keeps anything but plain digits as the text typed, so the rules can say what is wrong", () => {
    const values = toFormValues({ job_name: "a" }, []);
    const gap = (typed: string): unknown => toEntry({ ...values, max_gap_minutes: typed }, { job_name: "a" }).max_gap_minutes;
    expect(gap(" 90 ")).toBe(90);
    for (const typed of ["1.5", "-3", "0x1E", "0b11", "+5", "5.", "1e3", "12345678901234567890"]) expect(gap(typed)).toBe(typed);
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

  it("keeps an empty environments mapping, a null one, and an environment set to {}, which the loader reads as unset", () => {
    const empty: JobEntry = { job_name: "a", environments: {} };
    const emptyLabel: JobEntry = { job_name: "a", environments: { lower: {} } };
    const nulled: JobEntry = { job_name: "a" };
    Object.assign(nulled, { environments: null });
    for (const entry of [empty, emptyLabel, nulled]) expect(roundTrip(entry)).toEqual(entry);
    // An override the person clears is still removed, with its label.
    const values = toFormValues(FULL, environmentLabels(DOC, FULL));
    const cleared = values.environments.map((row): typeof row => (row.label === "lower" ? { ...row, enabled: INHERIT } : row));
    expect(toEntry({ ...values, environments: cleared }, FULL).environments).toEqual({ production: { job_ids: ["123456789012345"], severity: "WARNING" } });
  });

  it("keeps a name and the owners exactly as saved while their fields are untouched, and trims what is typed", () => {
    // The loader keeps text as written: trimming " padded name " on save would add a job under another name.
    const padded: JobEntry = { job_name: " padded name ", owner: " ingestion-team ", environments: { lower: { owner: " lower-team " } } };
    expect(roundTrip(padded)).toEqual(padded);
    const values = toFormValues(padded, environmentLabels(DOC, padded));
    const typed = toEntry({ ...values, owner: " platform " }, padded);
    expect(typed.owner).toBe("platform");
    expect(typed.job_name).toBe(" padded name ");
    expect(toEntry({ ...values, job_name: " new_name " }, padded).job_name).toBe("new_name");
  });

  it("never writes an empty job_ids list, at job or environment level, since the loader rejects one", () => {
    // config.py _parse_job_ids: "job_ids must be a list of one or more job IDs". An emptied list is unset, so the job's own IDs apply.
    const values = toFormValues(FULL, environmentLabels(DOC, FULL));
    const environments = values.environments.map((row) => (row.label === "production" ? { ...row, job_ids: [] } : row));
    const entry = toEntry({ ...values, job_ids: [], environments }, FULL);
    expect(entry).not.toHaveProperty("job_ids");
    expect(entry.environments?.production).toEqual({ severity: "WARNING" });
  });
});

/** A job with one setting as stored, which no YAML file that loads can hold: built with Reflect, since its type is not the entry's. */
function storedWith(key: string, value: unknown, more: Partial<JobEntry> = {}): JobEntry {
  const job: JobEntry = { job_name: "orders_ingest", max_gap_minutes: 60, ...more };
  Reflect.set(job, key, value);
  return job;
}

/** The rules' issue for a job's setting, as the editor shows it next to the field. */
function issueFor(job: JobEntry, key: string): string | undefined {
  return validateDocument({ jobs: [job] }).find((issue) => issue.path === `jobs[${job.job_name}].${key}`)?.message;
}

describe("a stored number the rules refuse", () => {
  it.each([
    ["-1", -1, "got -1"],
    ["1.5", 1.5, "got 1.5"],
    ["a big integer", 12345678901234567890n, "is too large (at most 9007199254740991), got 12345678901234567890"],
    ["a string of digits", "60", "got '60'"],
  ])("keeps %s through an unrelated edit, so the rules report it as the loader does", (_case, stored, said) => {
    const job = storedWith("max_retries", stored);
    const rebuilt = toEntry({ ...toFormValues(job, []), owner: "data-team" }, job);
    expect(Reflect.get(rebuilt, "max_retries")).toBe(stored);
    expect(issueFor(rebuilt, "max_retries")).toContain(said);
  });

  it("keeps a stored -1 in an environment through an unrelated edit", () => {
    const job = storedWith("environments", { lower: { max_retries: -1 } });
    const values = toFormValues(job, ["lower"]);
    const rebuilt = toEntry({ ...values, owner: "data-team" }, job);
    expect(rebuilt.environments).toEqual({ lower: { max_retries: -1 } });
  });

  it("reads a typed -1 as text, which the rules quote", () => {
    const job: JobEntry = { job_name: "orders_ingest", max_gap_minutes: 60 };
    const rebuilt = toEntry({ ...toFormValues(job, []), max_retries: "-1" }, job);
    expect(rebuilt.max_retries).toBe("-1");
    expect(issueFor(rebuilt, "max_retries")).toContain("got '-1'");
  });
});

describe("the form's round trip over the job-list corpus", () => {
  const fixtures = loadableFixtures();

  it("finds the corpus's valid files, the explicit-values one among them", () => {
    expect(fixtures.map(([file]) => file)).toContain("valid_explicit_values.yml");
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  it.each(fixtures)("%s: every job comes back from the form unchanged, as the editor's change check compares it", (_file, doc) => {
    for (const job of doc.jobs) {
      const rebuilt = toEntry(toFormValues(job, environmentLabels(doc, job)), job);
      expect(rebuilt, job.job_name).toEqual(job);
      expect(deepEqual(rebuilt, job), job.job_name).toBe(true);
    }
  });

  // Numbers the rules refuse cannot come from a file that loads; a version saved under other rules can hold them.
  // The corpus has the negative one; the others are built here, at job level and in an environment.
  const refused: [string, JobListDocument][] = [
    ["invalid_negative_number.yml", { jobs: [storedWith("max_runtime_minutes", -5)] }],
    ["a float", { jobs: [storedWith("max_retries", 1.5)] }],
    ["a big integer", { jobs: [storedWith("min_attempt_minutes", 12345678901234567890n)] }],
    ["a number too large to be exact", { jobs: [storedWith("max_runtime_minutes", 1e21)] }],
    [
      "an environment's -1",
      { workspaces: [{ workspace_name: "example-staging", environment: "lower" }], jobs: [storedWith("environments", { lower: { max_retries: -1, max_gap_minutes: 1.5 } })] },
    ],
  ];

  it.each(refused)("%s: comes back from the form unchanged", (_case, doc) => {
    for (const job of doc.jobs) {
      const rebuilt = toEntry(toFormValues(job, environmentLabels(doc, job)), job);
      expect(rebuilt, job.job_name).toEqual(job);
    }
  });

  it("finds the corpus file with the negative number, so the case above matches it", () => {
    const raw = parse(readFileSync(join(CORPUS, "invalid_negative_number.yml"), "utf8"), pythonYamlOptions) as Record<string, unknown>;
    expect(normalizeDocument(raw)).toEqual({ jobs: [{ job_name: "orders_ingest", max_gap_minutes: 60, max_runtime_minutes: -5 }] });
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
