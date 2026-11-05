import { describe, expect, it } from "vitest";
import { pyRepr } from "./pyrepr";

describe("pyRepr", () => {
  it("quotes strings the way Python does", () => {
    expect(pyRepr("ab")).toBe("'ab'");
    expect(pyRepr("a'b")).toBe("\"a'b\"");
    expect(pyRepr("a'b\"c")).toBe("'a\\'b\"c'");
    expect(pyRepr("a\nb\\")).toBe("'a\\nb\\\\'");
  });
  it("prints scalars", () => {
    expect(pyRepr(true)).toBe("True");
    expect(pyRepr(false)).toBe("False");
    expect(pyRepr(null)).toBe("None");
    expect(pyRepr(undefined)).toBe("None");
    expect(pyRepr(-5)).toBe("-5");
    expect(pyRepr(1.5)).toBe("1.5");
    expect(pyRepr(10n)).toBe("10");
  });
  it("prints lists and mappings", () => {
    expect(pyRepr(["max_gap"])).toBe("['max_gap']");
    expect(pyRepr([])).toBe("[]");
    expect(pyRepr({})).toBe("{}");
    expect(pyRepr({ a: 1 })).toBe("{'a': 1}");
    expect(pyRepr({ a: [true, null], b: "x" })).toBe("{'a': [True, None], 'b': 'x'}");
  });
});
