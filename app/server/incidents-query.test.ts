import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../config/queries/job_incidents.obo.sql", import.meta.url), "utf8");
const code = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("job_incidents.obo.sql", () => {
  it("takes the same parameters as the other Monitoring queries", () => {
    for (const name of ["catalog", "schema", "refresh"]) expect(sql).toMatch(new RegExp(`-- @param ${name} `));
    expect(code).toContain("IDENTIFIER(:catalog || '.' || :schema || '.incidents')");
    expect(code).toContain(":refresh >= 0");
  });

  it("returns the open incidents and those resolved in the last 24 hours, and no others", () => {
    expect(code).toMatch(/state = 'OPEN'/);
    expect(code).toMatch(/state = 'RESOLVED'\s+AND resolved_at >= timestampadd\(HOUR, -24, current_timestamp\(\)\)/);
    expect(code).not.toMatch(/NOT_CHECKED/);
  });

  it("selects the columns the page reads", () => {
    for (const column of ["incident_id", "state", "check_id", "workspace_id", "job_id", "job_name", "opened_at", "scans_seen", "current_status", "resolved_at", "error_summary", "run_page_url", "is_new"]) {
      expect(code).toContain(column);
    }
  });
});
