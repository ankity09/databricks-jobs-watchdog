import { describe, expect, it } from "vitest";
import { shortCodeVersion } from "./format";

describe("shortCodeVersion", () => {
  it.each([
    ["feat/watchdog-app@bf44b3b58bc3445812bf9aa3dba88d096eee9186", "feat/watchdog-app@bf44b3b"],
    ["bf44b3b58bc3445812bf9aa3dba88d096eee9186", "bf44b3b"],
    ["main@f6509ec", "main@f6509ec"],
    ["v1.4.2", "v1.4.2"],
    ["release@2026-11-05", "release@2026-11-05"],
  ])("shortens %s to %s", (version, short) => {
    expect(shortCodeVersion(version)).toBe(short);
  });
});
