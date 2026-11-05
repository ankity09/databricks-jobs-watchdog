import { describe, expect, it } from "vitest";
import { PyFloat, pyFloatRepr, pyRepr, pyStr, pyStrip, PyTimestamp } from "./pyrepr";

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

describe("pyFloatRepr", () => {
  it("prints floats the way Python's repr() does", () => {
    expect(pyFloatRepr(1.5)).toBe("1.5");
    expect(pyFloatRepr(0.0001)).toBe("0.0001");
    expect(pyFloatRepr(0.00001)).toBe("1e-05");
    expect(pyFloatRepr(1.5e-7)).toBe("1.5e-07");
    expect(pyFloatRepr(1e15)).toBe("1000000000000000.0");
    expect(pyFloatRepr(1e16)).toBe("1e+16");
    expect(pyFloatRepr(1.5e100)).toBe("1.5e+100");
    expect(pyFloatRepr(-0)).toBe("-0.0");
    expect([pyFloatRepr(Infinity), pyFloatRepr(-Infinity), pyFloatRepr(NaN)]).toEqual(["inf", "-inf", "nan"]);
  });
  it("is how a marked float and a fractional number print", () => {
    expect(String(new PyFloat(60))).toBe("60.0");
    expect(String(new PyFloat(1e20))).toBe("1e+20");
    expect(pyRepr(2.5)).toBe("2.5");
    expect(pyRepr(60)).toBe("60");
  });
});

describe("pyStr and timestamps", () => {
  it("str() of a date is its ISO text, and repr() names the type", () => {
    const date = new PyTimestamp("date", "2024-11-05", "datetime.date(2024, 11, 5)");
    expect(pyStr(date)).toBe("2024-11-05");
    expect(pyRepr(date)).toBe("datetime.date(2024, 11, 5)");
    expect(pyStr([date])).toBe("[datetime.date(2024, 11, 5)]");
    expect(JSON.stringify({ notes: date })).toBe('{"notes":"2024-11-05"}');
  });
});

describe("pyStrip", () => {
  it("removes what Python's strip() removes, which is not what trim() removes", () => {
    expect(pyStrip(" \t123\n")).toBe("123");
    expect(pyStrip("\x1c123\x85")).toBe("123");
    expect(pyStrip("\ufeff123")).toBe("\ufeff123");
  });
});
