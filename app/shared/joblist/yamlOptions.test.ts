import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import { PyFloat, PyTimestamp, pyRepr, pyStr } from "./pyrepr";
import { pythonYamlOptions } from "./yamlOptions";

/** How PyYAML reads each scalar; tests/test_yaml_scalars.py keeps this file true to PyYAML. */
const FIXTURE = join(__dirname, "../../../tests/fixtures/yaml-scalars.json");
type Row = { text: string; type: string; str: string; repr: string } | { text: string; error: string };
const rows = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { scalars: Row[] }).scalars;

/** The Python type name PyYAML would give this value. */
function pyType(value: unknown): string {
  if (value === null) return "NoneType";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "bigint") return "int";
  if (typeof value === "string") return "str";
  if (typeof value === "number" || value instanceof PyFloat) return "float";
  if (value instanceof PyTimestamp) return value.type;
  return typeof value;
}

describe("plain scalars read the way PyYAML reads them", () => {
  it("covers the fixture", () => {
    expect(rows.length).toBeGreaterThan(90);
  });
  it.each(rows)("$text", (row) => {
    const read = (): unknown => (parse(`v: ${row.text}`, pythonYamlOptions) as { v: unknown }).v;
    if ("error" in row) {
      expect(read).toThrow();
      return;
    }
    const value = read();
    expect({ type: pyType(value), str: pyStr(value), repr: pyRepr(value) }).toEqual({ type: row.type, str: row.str, repr: row.repr });
  });
});

describe("explicit tags", () => {
  it("!!str keeps the text, and a quoted scalar is always text", () => {
    expect(parse("a: !!str 12\nb: '12'\nc: \"yes\"\n", pythonYamlOptions)).toEqual({ a: "12", b: "12", c: "yes" });
  });
  it("an impossible date is an error, as Python's ValueError stops the loader", () => {
    expect(parseDocument("v: 2023-02-29\n", pythonYamlOptions).errors).not.toEqual([]);
    expect(parseDocument("v: 2024-02-29\n", pythonYamlOptions).errors).toEqual([]);
  });
});
