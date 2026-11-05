import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { PyFloat } from "./pyrepr";
import { normalizeDocument, toJobListDocument, validateDocument } from "./rules";
import { pythonYamlOptions } from "./yamlOptions";

const CORPUS = join(__dirname, "../../../tests/fixtures/job-lists");
type Expectation = { ok: true } | { ok: false; error_contains: string };
const expected = JSON.parse(readFileSync(join(CORPUS, "expected.json"), "utf8")) as Record<string, Expectation>;

describe("rules match the Python corpus", () => {
  it("covers every fixture", () => {
    expect(readdirSync(CORPUS).filter((f) => f.endsWith(".yml")).sort()).toEqual(Object.keys(expected).sort());
  });
  for (const [file, want] of Object.entries(expected)) {
    it(file, () => {
      const raw = parse(readFileSync(join(CORPUS, file), "utf8"), pythonYamlOptions) as Record<string, unknown>;
      const issues = validateDocument(raw);
      if (want.ok) expect(validateDocument(normalizeDocument(raw))).toEqual([]);
      if (want.ok) expect(issues).toEqual([]);
      else expect(issues[0]?.message ?? "").toContain(want.error_contains);
    });
  }
});

/** A corpus file as PyYAML would read it: the raw parse the rules check. */
function readRaw(file: string): Record<string, unknown> {
  return parse(readFileSync(join(CORPUS, file), "utf8"), pythonYamlOptions) as Record<string, unknown>;
}

describe("the stored form keeps text fields as the Python loader reads them", () => {
  const doc = toJobListDocument(normalizeDocument(readRaw("valid_text_from_other_types.yml")));
  it("job names, owners, notes and patterns are Python's str() of the YAML value", () => {
    expect(doc.jobs.map((j) => [j.job_name, j.owner, j.notes])).toEqual([
      ["20241105", "42", "True"],
      ["True", "", "60.0"],
      ["2024-11-05", undefined, "2024-11-05 10:30:00"],
      ["750", undefined, "1e3"],
    ]);
    expect(doc.jobs[2].job_name_exclude_regex).toBe("2024");
    expect(doc.jobs[0].environments).toEqual({ 1: { owner: "9" } });
    expect(doc.defaults).toEqual({ max_gap_minutes: 60, owner: "7" });
  });
  it("workspace names, labels and notes, and the links' names and notes, are text too", () => {
    expect(doc.workspaces).toEqual([
      { workspace_name: "2024", environment: "1", notes: "2024" },
      { workspace_id: "1111111111111111", environment: "production", notes: "True" },
    ]);
    expect(doc.dependencies).toEqual([
      { job_name: "True", depends_on: "20241105", notes: "7" },
      { job_name: "2024-11-05", depends_on: "1.5", dependency_type: "service" },
    ]);
  });
  it("keeps null, empty text and values the loader refuses as they are", () => {
    expect(normalizeDocument({ jobs: [{ job_name: "a", owner: null, notes: "", job_name_regex: false }] }).jobs)
      .toEqual([{ job_name: "a", owner: null, notes: "", job_name_regex: "" }]);
    expect(normalizeDocument({ jobs: [{ job_name: 0, max_gap_minutes: true }] }).jobs).toEqual([{ job_name: 0, max_gap_minutes: true }]);
  });
  it("stores job IDs as the stripped text Python checks", () => {
    expect(normalizeDocument({ jobs: [{ job_name: "a", job_ids: [" 123\t", 456n] }] }).jobs).toEqual([{ job_name: "a", job_ids: ["123", "456"] }]);
  });
  it("is the same after a second pass, so stored documents can be read through it again", () => {
    const once = normalizeDocument(readRaw("valid_text_from_other_types.yml"));
    expect(normalizeDocument(once)).toEqual(once);
  });
});

describe("stored.json", () => {
  it("pins the stored form of every loadable corpus file; the Python suite checks each means the same as its YAML", async () => {
    const loadable = Object.entries(expected).filter(([, want]) => want.ok).map(([file]) => file);
    const stored = Object.fromEntries(loadable.map((file) => [file, normalizeDocument(readRaw(file))]));
    await expect(`${JSON.stringify(stored, null, 1)}\n`).toMatchFileSnapshot(join(CORPUS, "stored.json"));
  });
});

describe("issue paths and collection", () => {
  const doc = (jobs: unknown[], more: Record<string, unknown> = {}) => ({ jobs, ...more });
  it("names the job and field in the path", () => {
    const issues = validateDocument(doc([{ job_name: "a", max_gap_minutes: -1 }]));
    expect(issues[0].path).toBe("jobs[a].max_gap_minutes");
  });
  it("uses the index when a job has no name", () => {
    const issues = validateDocument(doc([{ job_name: "a", max_gap_minutes: 5 }, { max_gap_minutes: 5 }]));
    expect(issues[0].path).toBe("jobs[1]");
    expect(issues[0].message).toBe("every job needs a job_name, got {'max_gap_minutes': 5}");
  });
  it("collects every problem", () => {
    const issues = validateDocument(doc([{ job_name: "a", max_gap_minutes: -1, severity: "x" }]));
    expect(issues.map((i) => i.path)).toEqual(["jobs[a].severity", "jobs[a].max_gap_minutes"]);
  });
  it("paths for defaults, workspaces and links", () => {
    expect(validateDocument(doc([{ job_name: "a", max_gap_minutes: 5 }], { defaults: { job_name_regex: "x" } }))[0].path).toBe("defaults.job_name_regex");
    expect(validateDocument(doc([{ job_name: "a", max_gap_minutes: 5 }], { workspaces: [{ workspace_id: "1", environment: "p" }, { workspace_id: "2" }] }))[0].path).toBe("workspaces[1].environment");
    expect(validateDocument(doc([{ job_name: "a", max_gap_minutes: 5 }], { dependencies: [{ job_name: "a", depends_on: "zz" }] }))[0].path).toBe("dependencies[a->zz:job]");
  });
  it("honours the source name", () => {
    expect(validateDocument({ jobs: [] }, "x.yml")[0].message).toBe("x.yml lists no jobs");
    expect(validateDocument({ jobs: [] })[0].message).toBe("the job list lists no jobs");
  });
  it("checks a pattern the way Python's re does, with Python's message", () => {
    const issues = (pattern: string) => validateDocument(doc([{ job_name: "a", max_gap_minutes: 5, job_name_regex: pattern }]));
    expect(issues("(?P<x>a)(?P=x)")).toEqual([]);
    expect(issues("(?i)^orders")).toEqual([]);
    expect(issues("(?<x>a)")[0].message).toBe("job a: job_name_regex does not compile: unknown extension ?<x at position 1");
    const exclude = validateDocument(doc([{ job_name: "a", max_gap_minutes: 5, job_name_exclude_regex: "\\k<x>" }]));
    expect(exclude[0].message).toBe("job a: job_name_exclude_regex does not compile: bad escape \\k at position 0");
  });
});

describe("a continuous job", () => {
  const issuesFor = (text: string) => validateDocument(parse(text, pythonYamlOptions) as Record<string, unknown>);
  it("with an invalid own max_gap_minutes gets that issue once", () => {
    const issues = issuesFor("jobs:\n  - job_name: stream_a\n    schedule_type: continuous\n    max_gap_minutes: -5\n");
    expect(issues.map((i) => i.message)).toEqual(["job stream_a: max_gap_minutes must be a whole number of zero or more, got -5"]);
  });
  it("with an invalid own max_gap_minutes over a valid default gets that issue once", () => {
    const issues = issuesFor("defaults:\n  max_gap_minutes: 30\njobs:\n  - job_name: stream_a\n    schedule_type: continuous\n    max_gap_minutes: 1.5\n");
    expect(issues).toHaveLength(1);
  });
  it("with an invalid default gap and none of its own gets that issue once", () => {
    const issues = issuesFor("defaults:\n  max_gap_minutes: -1\njobs:\n  - job_name: stream_a\n    schedule_type: continuous\n");
    expect(issues).toHaveLength(1);
  });
});

describe("normalizeDocument", () => {
  it("turns IDs into strings and big numbers into strings", () => {
    const out = normalizeDocument({
      jobs: [{ job_name: "a", job_ids: [1n, 9007199254740993n, "3"], max_gap_minutes: 5n, environments: { p: { job_ids: [7n] } } }],
      workspaces: [{ workspace_id: 9007199254740995n, environment: "p" }],
    });
    expect(out).toEqual({
      jobs: [{ job_name: "a", job_ids: ["1", "9007199254740993", "3"], max_gap_minutes: 5, environments: { p: { job_ids: ["7"] } } }],
      workspaces: [{ workspace_id: "9007199254740995", environment: "p" }],
    });
  });
  it("an unsafe big number outside IDs is rejected as too large, before and after normalizing", () => {
    const raw = { jobs: [{ job_name: "a", max_gap_minutes: 99999999999999999999n }] };
    const message = "job a: max_gap_minutes is too large (at most 9007199254740991), got 99999999999999999999";
    expect(validateDocument(raw)[0].message).toBe(message);
    expect(validateDocument(normalizeDocument(raw))[0].message).toBe(message);
  });
  it("safe bigints in count settings become numbers, at every level", () => {
    const out = normalizeDocument({
      defaults: { max_runtime_minutes: 9007199254740991n },
      jobs: [{ job_name: "a", max_gap_minutes: 5n, environments: { p: { max_retries: 2n } } }],
    });
    expect(out).toEqual({
      defaults: { max_runtime_minutes: 9007199254740991 },
      jobs: [{ job_name: "a", max_gap_minutes: 5, environments: { p: { max_retries: 2 } } }],
    });
  });
});

describe("raw parse messages", () => {
  const gap = (v: unknown) => validateDocument({ jobs: [{ job_name: "a", max_gap_minutes: v }] });
  it("prints a marked float like Python", () => {
    expect(gap(new PyFloat(60))[0].message).toBe("job a: max_gap_minutes must be a whole number of zero or more, got 60.0");
  });
  it("accepts bigint integers up to the safe limit and rejects larger ones", () => {
    expect(gap(9007199254740991n)).toEqual([]);
    expect(gap(9007199254740992n)[0].message).toContain("is too large");
    const env = validateDocument({ workspaces: [{ workspace_id: "1", environment: "p" }], jobs: [{ job_name: "a", max_gap_minutes: 1, environments: { p: { max_retries: 10n ** 20n } } }] });
    expect(env[0].message).toContain("environments.p.max_retries is too large");
    expect(validateDocument({ defaults: { max_retries: 10n ** 20n }, jobs: [{ job_name: "a", max_gap_minutes: 1 }] })[0].message).toContain("max_retries is too large");
    expect(gap(-5n)[0].message).toContain("got -5");
  });
  it("job IDs print as numbers and float IDs are rejected", () => {
    const ids = (v: unknown[]) => validateDocument({ jobs: [{ job_name: "a", max_gap_minutes: 1, job_ids: v }] });
    expect(ids([123n, "456"])).toEqual([]);
    expect(ids([new PyFloat(123)])[0].message).toBe("job a: job_ids must be whole numbers, got 123.0");
    expect(ids([true])[0].message).toContain("got True");
    expect(ids([1n, 1n])[0].message).toBe("job a: job ID 1 is listed twice");
  });
  it("job IDs are stripped the way Python's strip() does, not trim()", () => {
    const ids = (v: unknown[]) => validateDocument({ jobs: [{ job_name: "a", max_gap_minutes: 1, job_ids: v }] });
    expect(ids(["\x1c123\x85"])).toEqual([]);
    expect(ids(["\ufeff123"])[0].message).toBe("job a: job_ids must be whole numbers, got '\ufeff123'");
  });
  it("a float workspace_id is not digits", () => {
    const issues = validateDocument({ workspaces: [{ workspace_id: new PyFloat(12), environment: "p" }], jobs: [{ job_name: "a", max_gap_minutes: 1 }] });
    expect(issues[0].message).toBe("workspace 12.0: workspace_id must be digits, got '12.0'");
  });
});
