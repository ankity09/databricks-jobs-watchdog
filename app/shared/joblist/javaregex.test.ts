import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JAVA_CONSTRUCTS, javaRegexClause, javaRegexProblem } from "./javaregex";

/**
 * What the system-table scan's Java regex (Spark's regexp_like) makes of each pattern some Python
 * compiles, checked on a SQL warehouse; tests/test_regex_patterns.py checks the loader's copy of this check.
 */
const FIXTURE = join(__dirname, "../../../tests/fixtures/regex-patterns.json");
type Row = { pattern: string; error: string | null; java?: string | null };
const rows = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { patterns: Row[] }).patterns.filter((row) => "java" in row);

describe("javaRegexProblem agrees with Spark's regexp_like", () => {
  it("covers every construct", () => {
    expect(rows.length).toBeGreaterThan(130);
    const named = new Set(rows.map((row) => row.java));
    for (const construct of Object.values(JAVA_CONSTRUCTS)) {
      if (construct !== JAVA_CONSTRUCTS.other) expect(named).toContain(construct);
    }
  });
  it.each(rows)("$pattern", ({ pattern, java }) => {
    expect(javaRegexProblem(pattern)).toBe(java);
  });
});

describe("what Java refuses and Python accepts", () => {
  it("names the flag Java lacks", () => {
    expect(javaRegexProblem("(?a)^orders_\\w+$")).toBe("the a flag");
    expect(javaRegexProblem("(?ai:orders)")).toBe("the a flag");
  });
  it("refuses a repeated choice inside a look-behind, not one outside it or one without a repeat", () => {
    expect(javaRegexProblem("(?<=(?:dev|prd){1}_)orders")).toBe(JAVA_CONSTRUCTS.lookbehindRepeat);
    expect(javaRegexProblem("(?:dev|prd){1}_orders")).toBeNull();
    expect(javaRegexProblem("(?<=(?:dev|prd)_)orders")).toBeNull();
    expect(javaRegexProblem("(?<=(?=dev|prd)..._)orders")).toBeNull(); // Java does not measure a look-ahead
  });
  it("reads a verbose pattern's spaces and # the way Java does, also inside a set and a repeat", () => {
    expect(javaRegexProblem("(?x)[ ]")).toBe(JAVA_CONSTRUCTS.verboseSet);
    expect(javaRegexProblem("(?x)a{2 }")).toBeNull();
    expect(javaRegexProblem("a{2 }")).toBe(JAVA_CONSTRUCTS.brace);
    expect(javaRegexProblem("(?x)orders # copies end in _test\r)")).toBe(JAVA_CONSTRUCTS.verboseComment);
  });
});

describe("javaRegexClause", () => {
  it("is what the loader says after the field and the pattern", () => {
    expect(javaRegexClause(JAVA_CONSTRUCTS.namedGroup)).toBe("uses a (?P<name>...) group, which the system-table scan can't run");
    expect(javaRegexClause(JAVA_CONSTRUCTS.namedCharacter)).toBe(
      "uses a \\N{...} character name, which the system-table scan may not know; write the character itself",
    );
  });
});
