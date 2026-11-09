import { describe, expect, it } from "vitest";
import { hasFilters, jobHistoryPath, NO_FILTERS, parseFilters, presetFrom, presetOf, writeFilters } from "./changeFilters";

const NOW = new Date("2026-11-08T15:30:45.123Z");
const parse = (query: string) => parseFilters(new URLSearchParams(query));

describe("change log filters in the URL", () => {
  it("reads nothing from an empty query", () => {
    expect(parse("")).toEqual(NO_FILTERS);
    expect(hasFilters(parse(""))).toBe(false);
  });

  it("reads every filter", () => {
    expect(parse("person=a%40example.com&kind=update,create&job=orders_ingest&from=2026-11-01&to=2026-11-07T10:00:00Z&q=gap")).toEqual({
      person: "a@example.com", kinds: ["create", "update"], job: "orders_ingest", from: "2026-11-01", to: "2026-11-07T10:00:00Z", q: "gap",
    });
  });

  it("keeps kinds in the order of the chips, once, and drops unknown ones", () => {
    expect(parse("kind=restore,nope,create,create,import").kinds).toEqual(["import", "create", "restore"]);
  });

  it("drops dates it cannot read, and reads empty values as not set", () => {
    expect(parse("from=yesterday&to=").from).toBeNull();
    expect(parse("from=yesterday&to=").to).toBeNull();
    expect(parse("person=&job=&q=")).toEqual(NO_FILTERS);
  });

  it("writes only what is set, in a fixed order", () => {
    expect(writeFilters(NO_FILTERS).toString()).toBe("");
    expect(writeFilters({ person: "a@example.com", kinds: ["create", "update"], job: "orders_ingest", from: "2026-11-01", to: null, q: "100%" }).toString())
      .toBe("person=a%40example.com&kind=create%2Cupdate&job=orders_ingest&from=2026-11-01&q=100%25");
  });

  it("round-trips", () => {
    const filters = { person: "a@example.com", kinds: ["delete" as const], job: "a b&c", from: "2026-11-01", to: "2026-11-02", q: "x y" };
    expect(parseFilters(writeFilters(filters))).toEqual(filters);
  });

  it("builds the link to a job's history", () => {
    expect(jobHistoryPath("orders_ingest")).toBe("/jobs/changes?job=orders_ingest");
    expect(jobHistoryPath("a b&c")).toBe("/jobs/changes?job=a+b%26c");
  });
});

describe("the When presets", () => {
  it("store real dates", () => {
    expect(presetFrom("24h", NOW)).toBe("2026-11-07T15:30:45Z");
    expect(presetFrom("7d", NOW)).toBe("2026-11-01");
    expect(presetFrom("30d", NOW)).toBe("2026-10-09");
  });

  it("are shown when the dates match", () => {
    expect(presetOf(NO_FILTERS, NOW)).toBe("any");
    expect(presetOf({ ...NO_FILTERS, from: "2026-11-01" }, NOW)).toBe("7d");
    expect(presetOf({ ...NO_FILTERS, from: "2026-10-09" }, NOW)).toBe("30d");
    expect(presetOf({ ...NO_FILTERS, from: "2026-11-07T15:30:45Z" }, NOW)).toBe("24h");
    // A minute later, the same window is still the 24 hours it was.
    expect(presetOf({ ...NO_FILTERS, from: "2026-11-07T15:30:45Z" }, new Date("2026-11-08T15:31:45Z"))).toBe("24h");
  });

  it("show Custom for any other window", () => {
    expect(presetOf({ ...NO_FILTERS, from: "2026-11-02" }, NOW)).toBe("custom");
    expect(presetOf({ ...NO_FILTERS, from: "2026-11-01", to: "2026-11-08" }, NOW)).toBe("custom");
    expect(presetOf({ ...NO_FILTERS, to: "2026-11-08" }, NOW)).toBe("custom");
    // A copied 24-hour link opened days later is no longer the last 24 hours.
    expect(presetOf({ ...NO_FILTERS, from: "2026-11-01T15:30:45Z" }, NOW)).toBe("custom");
  });
});
