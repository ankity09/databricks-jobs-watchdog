import { describe, expect, it } from "vitest";
import { formatAgo, formatUtc } from "./time";

const now = new Date("2026-11-05T10:30:00Z");

describe("formatAgo", () => {
  it("counts minutes, then hours, then days", () => {
    expect(formatAgo("2026-11-05T10:18:00Z", now)).toBe("12 min ago");
    expect(formatAgo("2026-11-05T07:30:00Z", now)).toBe("3 h ago");
    expect(formatAgo("2026-11-03T10:30:00Z", now)).toBe("2 days ago");
  });
  it("rounds down at each boundary", () => {
    expect(formatAgo("2026-11-05T09:31:00Z", now)).toBe("59 min ago");
    expect(formatAgo("2026-11-05T09:30:00Z", now)).toBe("1 h ago");
    expect(formatAgo("2026-11-04T10:31:00Z", now)).toBe("23 h ago");
    expect(formatAgo("2026-11-04T10:30:00Z", now)).toBe("1 day ago");
  });
  it("says just now for the last minute, and for a clock that runs a little ahead", () => {
    expect(formatAgo("2026-11-05T10:29:40Z", now)).toBe("just now");
    expect(formatAgo("2026-11-05T10:31:00Z", now)).toBe("just now");
  });
  it("reads a time with no zone as UTC", () => {
    expect(formatAgo("2026-11-05 10:18:00", now)).toBe("12 min ago");
  });
  it("says unknown for a value that is not a time", () => {
    expect(formatAgo("not a time", now)).toBe("unknown");
  });
});

describe("formatUtc", () => {
  it("shows the date and the minute in UTC", () => {
    expect(formatUtc("2026-11-05T10:05:12.345Z")).toBe("2026-11-05 10:05 UTC");
    expect(formatUtc("2026-11-05T12:05:00+02:00")).toBe("2026-11-05 10:05 UTC");
  });
  it("reads a time with no zone as UTC", () => {
    expect(formatUtc("2026-11-05 10:05:12")).toBe("2026-11-05 10:05 UTC");
  });
  it("says unknown for a value that is not a time", () => {
    expect(formatUtc("")).toBe("unknown");
  });
});
