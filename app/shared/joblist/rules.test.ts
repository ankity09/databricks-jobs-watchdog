import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { PyFloat } from "./pyrepr";
import { normalizeDocument, validateDocument } from "./rules";
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
  it("a JavaScript-only regex gap is reported as not compiling", () => {
    const issues = validateDocument(doc([{ job_name: "a", max_gap_minutes: 5, job_name_regex: "(?P<x>a)" }]));
    expect(issues[0].message).toContain("job_name_regex does not compile");
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
  it("a float workspace_id is not digits", () => {
    const issues = validateDocument({ workspaces: [{ workspace_id: new PyFloat(12), environment: "p" }], jobs: [{ job_name: "a", max_gap_minutes: 1 }] });
    expect(issues[0].message).toBe("workspace 12.0: workspace_id must be digits, got '12.0'");
  });
});
