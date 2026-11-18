import { describe, expect, it } from "vitest";
import { statusRank, statusTone, worstStatus, type Status } from "./status";

describe("status", () => {
  it("ranks FAILED over WARNING over UNKNOWN over HEALTHY", () => {
    const statuses: Status[] = ["HEALTHY", "UNKNOWN", "WARNING", "FAILED"];
    expect(statuses.map(statusRank)).toEqual([0, 1, 2, 3]);
  });
  it("picks the worst status of a list", () => {
    expect(worstStatus(["HEALTHY", "WARNING", "UNKNOWN"])).toBe("WARNING");
    expect(worstStatus(["HEALTHY", "FAILED", "WARNING"])).toBe("FAILED");
    expect(worstStatus(["HEALTHY", "HEALTHY"])).toBe("HEALTHY");
  });
  it("calls an empty list UNKNOWN, since nothing is known", () => {
    expect(worstStatus([])).toBe("UNKNOWN");
  });
  it("gives each status a tone", () => {
    expect(statusTone("FAILED")).toBe("destructive");
    expect(statusTone("WARNING")).toBe("warning");
    expect(statusTone("UNKNOWN")).toBe("muted");
    expect(statusTone("HEALTHY")).toBe("success");
  });
});
