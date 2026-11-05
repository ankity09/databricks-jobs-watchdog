import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonRegexError } from "./pyregex";

/** What Python's re.compile says about each pattern; tests/test_regex_patterns.py keeps this file true to Python. */
const FIXTURE = join(__dirname, "../../../tests/fixtures/regex-patterns.json");
/** error is the app's verdict: null when Python 3.10 to 3.14 all compile the pattern, else the newest refusing version's message. */
type Row = { pattern: string; error: string | null; raises?: string; python?: Record<string, string | null> };
const rows = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { patterns: Row[] }).patterns;

/** Python looks \N{...} names up in its Unicode database, which the app does not have, so it refuses them all. */
const NAMED_CHARACTER = /\\N\{/;

describe("pythonRegexError agrees with Python's re", () => {
  it("covers the fixture", () => {
    expect(rows.length).toBeGreaterThan(150);
  });
  it.each(rows.filter((row) => !NAMED_CHARACTER.test(row.pattern)))("$pattern", ({ pattern, error }) => {
    expect(pythonRegexError(pattern)).toBe(error);
  });
  it("refuses a \\N{...} name it cannot look up, at the position Python gives a bad name", () => {
    expect(pythonRegexError("\\N{EM DASH}")).toBe(
      "the app cannot check the character name 'EM DASH'; write the character itself at position 0",
    );
    expect(pythonRegexError("\\N")).toBe("missing { at position 2");
  });
});

describe("what JavaScript's RegExp gets wrong, in both directions", () => {
  it("accepts inline flags, Python's named groups and verbose patterns", () => {
    for (const pattern of ["(?i)^orders", "(?P<x>a)(?P=x)", "(?x) ^orders _ingest$", "(?s:a.b)"]) {
      expect(() => new RegExp(pattern)).toThrow();
      expect(pythonRegexError(pattern)).toBeNull();
    }
  });
  it("refuses \\p, \\k, unknown escapes, (?<name>) and a look-behind of varying width", () => {
    for (const pattern of ["^orders_\\p{L}+$", "\\k<x>", "^orders\\i", "(?<x>a)", "(?<=prod_.*)orders", "[]", "\\1"]) {
      expect(() => new RegExp(pattern)).not.toThrow();
      expect(pythonRegexError(pattern)).not.toBeNull();
    }
  });
});

describe("the Python versions the scan may run", () => {
  it("refuses what Python 3.10 refuses, although newer versions accept it, with 3.10's message", () => {
    expect(pythonRegexError("(?>enrich|backfill)")).toBe("unknown extension ?> at position 1");
    expect(pythonRegexError("_test_*+$")).toBe("multiple repeat at position 7");
  });
  it("refuses \\z, which only 3.14 has, and global flags after the start, which 3.11 and later refuse", () => {
    expect(pythonRegexError("orders\\z")).toBe("bad escape \\z at position 6");
    expect(pythonRegexError("a(?i)b")).toBe("global flags not at the start of the expression at position 1");
  });
  it("matches the fixture's per-version rows", () => {
    const differing = rows.filter((row) => row.python && !NAMED_CHARACTER.test(row.pattern));
    expect(differing.length).toBeGreaterThan(10);
    for (const row of differing) expect(pythonRegexError(row.pattern)).toBe(row.error);
  });
});
