import { describe, expect, it } from "vitest";
import { copilotLink, questionFromLink } from "./copilot-link";

function question(link: string): string {
  return questionFromLink(new URL(link, "http://localhost").searchParams);
}

describe("the copilot deep link", () => {
  it("carries the job, the workspace and the status, and turns them into a question", () => {
    const link = copilotLink({ job: "orders_ingest", workspace: "1234567890", status: "FAILED" });
    expect(link).toBe("/copilot?job=orders_ingest&workspace=1234567890&status=FAILED");
    expect(question(link)).toBe("Why is orders_ingest failing in workspace 1234567890, and what does it affect?");
  });

  it("leaves out what it was not given", () => {
    expect(copilotLink({ job: "daily_revenue_report" })).toBe("/copilot?job=daily_revenue_report");
    expect(question("/copilot?job=daily_revenue_report")).toBe("What is the status of daily_revenue_report?");
    expect(question("/copilot?job=orders_ingest&status=unknown")).toBe("Why can the Watchdog not tell the status of orders_ingest?");
  });

  it("fills in nothing without a job", () => {
    expect(question("/copilot?workspace=1234567890&status=FAILED")).toBe("");
    expect(question("/copilot")).toBe("");
  });
});
