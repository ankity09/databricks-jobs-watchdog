import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJobListYaml, readJobListYaml, toJobListYaml, YamlError } from "./yaml";

const CORPUS = join(__dirname, "../../../tests/fixtures/job-lists");
const META = { version: 3, savedAt: "2026-11-05T10:00:00Z", savedBy: "someone@example.com" };

describe("an alias bomb", () => {
  const bomb =
    "a: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]\ne: &e [*d, *d, *d, *d, *d, *d, *d, *d, *d]\nf: &f [*e, *e, *e, *e, *e, *e, *e, *e, *e]\njobs: []\n";
  it("is a YamlError with a plain message", () => {
    expect(() => readJobListYaml(bomb)).toThrow(new YamlError("The YAML file uses too many aliases."));
  });
});

describe("parseJobListYaml", () => {
  it("keeps every digit of big IDs", () => {
    const doc = parseJobListYaml(
      "workspaces:\n  - workspace_id: 9007199254740995\n    environment: production\njobs:\n  - job_name: a\n    max_gap_minutes: 5\n    job_ids: [9007199254740993]\n",
    );
    expect(doc.jobs[0].job_ids).toEqual(["9007199254740993"]);
    expect(doc.workspaces?.[0].workspace_id).toBe("9007199254740995");
  });
  it("resolves merge keys and anchors, YAML 1.1 booleans, and quoted words", () => {
    const doc = parseJobListYaml(
      "common: &c {max_gap_minutes: 5, severity: CRITICAL}\njobs:\n  - job_name: a\n    <<: *c\n    enabled: yes\n    notes: \"no\"\n",
    );
    expect(doc.jobs[0]).toEqual({ job_name: "a", max_gap_minutes: 5, severity: "CRITICAL", enabled: true, notes: "no" });
  });
  it("drops comments", () => {
    expect(parseJobListYaml("# hi\njobs:\n  - job_name: a  # trailing\n")).toEqual({ jobs: [{ job_name: "a" }] });
  });
  it("throws YamlError for a non-mapping top level and for duplicate keys", () => {
    expect(() => parseJobListYaml("- a\n- b\n")).toThrow(YamlError);
    expect(() => parseJobListYaml("jobs: []\njobs: []\n")).toThrow(YamlError);
    expect(() => parseJobListYaml("jobs: [\n")).toThrow(YamlError);
  });
});

describe("readJobListYaml", () => {
  it("validates the raw parse, so messages print values like Python", () => {
    const r = readJobListYaml("jobs:\n  - job_name: a\n    max_gap_minutes: 60.0\n");
    expect(r.issues[0].message).toBe("job a: max_gap_minutes must be a whole number of zero or more, got 60.0");
  });
  it("accepts a valid file with no issues", () => {
    expect(readJobListYaml("jobs:\n  - job_name: a\n    max_gap_minutes: 5\n    job_ids: [123]\n").issues).toEqual([]);
  });
});

describe("round trip", () => {
  for (const file of readdirSync(CORPUS).filter((f) => f.startsWith("valid_"))) {
    it(file, () => {
      const doc = parseJobListYaml(readFileSync(join(CORPUS, file), "utf8"));
      expect(parseJobListYaml(toJobListYaml(doc, META))).toEqual(doc);
    });
  }
  it("keeps YAML 1.1 words and awkward strings as strings", () => {
    const doc = {
      jobs: [
        { job_name: "a", max_gap_minutes: 5, notes: "on", job_name_regex: "^a: b$" },
        { job_name: "b", max_gap_minutes: 5, notes: "no" },
        { job_name: "c", max_gap_minutes: 5, notes: "yes", job_ids: ["123456789012345678"] },
      ],
    };
    const text = toJobListYaml(doc, META);
    expect(parseJobListYaml(text)).toEqual(doc);
    expect(text).toMatch(/notes: "?'?on/);
  });
});

describe("export layout", () => {
  it("starts with the header and orders sections and keys", () => {
    const text = toJobListYaml(
      {
        dependencies: [{ depends_on: "a", job_name: "b" }],
        jobs: [{ notes: "text", owner: "o", max_gap_minutes: 5, job_name_regex: "^a$", job_name: "a" }],
        workspaces: [{ environment: "lower", workspace_id: "1" }],
        defaults: { owner: "x", severity: "WARNING" },
      },
      META,
    );
    expect(text.split("\n")[0]).toBe("# Exported from the Watchdog app: version 3, saved 2026-11-05T10:00:00Z by someone@example.com");
    const at = (s: string) => text.indexOf(s);
    expect(at("defaults:")).toBeLessThan(at("workspaces:"));
    expect(at("workspaces:")).toBeLessThan(at("jobs:"));
    expect(at("jobs:")).toBeLessThan(at("dependencies:"));
    expect(at("job_name: a")).toBeLessThan(at("job_name_regex"));
    expect(at("job_name_regex")).toBeLessThan(at("max_gap_minutes"));
    expect(at("max_gap_minutes")).toBeLessThan(at("owner: o"));
    expect(at("owner: o")).toBeLessThan(at("notes: text"));
  });
});
