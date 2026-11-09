import { describe, expect, it } from "vitest";
import { jobsInTarget } from "./changelog";

describe("jobsInTarget", () => {
  it("reads a job target", () => {
    expect(jobsInTarget("job:orders_ingest")).toEqual(["orders_ingest"]);
  });
  it("reads both ends of a job or child_job link", () => {
    expect(jobsInTarget("dependency:orders_report->orders_ingest:job")).toEqual(["orders_report", "orders_ingest"]);
    expect(jobsInTarget("dependency:a->b:child_job")).toEqual(["a", "b"]);
  });
  it("reads only the left end of a service link", () => {
    expect(jobsInTarget("dependency:orders_ingest->kafka:service")).toEqual(["orders_ingest"]);
  });
  it("gives nothing for workspace, defaults and null", () => {
    expect(jobsInTarget("workspace:123")).toEqual([]);
    expect(jobsInTarget("defaults")).toEqual([]);
    expect(jobsInTarget(null)).toEqual([]);
  });
  it("counts a job once when it is both ends", () => {
    expect(jobsInTarget("dependency:a->a:job")).toEqual(["a"]);
  });
});
