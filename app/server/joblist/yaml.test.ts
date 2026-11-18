import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JobListDocument } from "../../shared/joblist/types";
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
    expect(() => parseJobListYaml("2024-11-05\n")).toThrow(new YamlError("the YAML file must contain a YAML mapping at the top level"));
    expect(() => parseJobListYaml("jobs: []\njobs: []\n")).toThrow(YamlError);
    expect(() => parseJobListYaml("jobs: [\n")).toThrow(YamlError);
  });
});

describe("reading the file the way PyYAML does", () => {
  it("y and n are text, not booleans", () => {
    const doc = parseJobListYaml("jobs:\n  - job_name: y\n    max_gap_minutes: 5\n    notes: n\n");
    expect(doc.jobs[0]).toEqual({ job_name: "y", max_gap_minutes: 5, notes: "n" });
  });
  it("an unknown tag stops the import, as PyYAML's safe loader has no constructor for it", () => {
    expect(() => readJobListYaml("jobs: !!python/tuple [1, 2]\n")).toThrow(YamlError);
    expect(() => readJobListYaml("jobs:\n  - job_name: !custom a\n")).toThrow(YamlError);
  });
  it("a plain = stops the import, as PyYAML reads it as a value tag it cannot build", () => {
    expect(() => readJobListYaml("jobs:\n  - job_name: a\n    notes: =\n")).toThrow(YamlError);
  });
  it("an impossible date stops the import, as Python's ValueError stops the loader", () => {
    expect(() => readJobListYaml("jobs:\n  - job_name: a\n    notes: 2023-02-29\n")).toThrow(YamlError);
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

// Export spells out an inherited schedule. Every other field, and every
// explicit schedule, must survive unchanged; exporting must not edit storage.
// explicit-schedule.test.ts checks each effective schedule against literal values.
function exportAndExpectPreservedConfig(doc: JobListDocument): string {
  const original = structuredClone(doc);
  const text = toJobListYaml(doc, META);
  expect(doc).toEqual(original);
  const exported = parseJobListYaml(text);
  for (const [index, job] of exported.jobs.entries()) {
    expect(job.schedule_type).toMatch(/^(scheduled|continuous|triggered)$/);
    if (original.jobs[index]?.schedule_type === undefined) delete job.schedule_type;
  }
  expect(exported).toEqual(original);
  return text;
}

describe("round trip", () => {
  for (const file of readdirSync(CORPUS).filter((f) => f.startsWith("valid_"))) {
    it(file, () => {
      const doc = parseJobListYaml(readFileSync(join(CORPUS, file), "utf8"));
      exportAndExpectPreservedConfig(doc);
    });
  }
  it("quotes text that PyYAML would read as something else, = among it", () => {
    const doc = { jobs: [{ job_name: "a", max_gap_minutes: 5, notes: "=" }, { job_name: "20241105", max_gap_minutes: 5, notes: "1e3" }] };
    const text = exportAndExpectPreservedConfig(doc);
    expect(text).not.toMatch(/notes: =\n/);
  });
  it("keeps YAML 1.1 words and awkward strings as strings", () => {
    const doc = {
      jobs: [
        { job_name: "a", max_gap_minutes: 5, notes: "on", job_name_regex: "^a: b$" },
        { job_name: "b", max_gap_minutes: 5, notes: "no" },
        { job_name: "c", max_gap_minutes: 5, notes: "yes", job_ids: ["123456789012345678"] },
      ],
    };
    const text = exportAndExpectPreservedConfig(doc);
    expect(text).toMatch(/notes: "?'?on/);
  });
});

describe("the export, read back by PyYAML", () => {
  // Every scalar of tests/fixtures/yaml-scalars.json, and text PyYAML reads as a merge key or a timestamp
  // although the yaml library's own 1.1 tags would leave it plain. tests/test_yaml_export.py reads the
  // pinned export with PyYAML and checks each note and label comes back as the same text.
  const scalars = (JSON.parse(readFileSync(join(__dirname, "../../../tests/fixtures/yaml-scalars.json"), "utf8")) as {
    scalars: { text: string }[];
  }).scalars.map((row) => row.text);
  const texts = [...scalars, "<<", "2024-11-05 10:30:00 +25:00", "2024-11-05 10:30:00 -99", "2024-11-05T10:30:00+30:00"];
  const labels = texts.filter((text) => /^[A-Za-z0-9_-]+$/.test(text));
  it("is pinned with the texts it holds", async () => {
    const doc = {
      jobs: texts.map((notes, i) => ({ job_name: `job_${i}`, max_gap_minutes: 5, notes })),
      dependencies: [],
    };
    const withLabels = { ...doc, jobs: [...doc.jobs, { job_name: "labels", max_gap_minutes: 5, environments: Object.fromEntries(labels.map((l) => [l, { enabled: false }])) }] };
    const pinned = { texts, labels, yaml: toJobListYaml(withLabels, META) };
    await expect(`${JSON.stringify(pinned, null, 1)}\n`).toMatchFileSnapshot(join(CORPUS, "../yaml-export.json"));
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
