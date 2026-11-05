import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonRegexError } from "./pyregex";

/** What Python's re.compile says about each pattern; tests/test_regex_patterns.py keeps this file true to Python. */
const FIXTURE = join(__dirname, "../../../tests/fixtures/regex-patterns.json");
type Row = { pattern: string; error: string | null; raises?: string };
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
  it("accepts inline flags, atomic groups and possessive repeats", () => {
    for (const pattern of ["(?i)^orders", "(?>a)", "a*+", "(?P<x>a)(?P=x)"]) {
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
