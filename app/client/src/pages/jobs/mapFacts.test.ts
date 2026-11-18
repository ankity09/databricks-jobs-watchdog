import { describe, expect, it } from "vitest";
import type { JobEntry, JobListDocument } from "../../../../shared/joblist/types";
import { inheritedSettings } from "../../lib/job-form";
import { EXAMPLE_DOCUMENT } from "../../test/example-document";
import { cardFacts, jobDetails } from "./mapFacts";

function entry(name: string, doc: JobListDocument = EXAMPLE_DOCUMENT): JobEntry {
  const found = doc.jobs.find((job) => job.job_name === name);
  if (!found) throw new Error(`no job ${name}`);
  return found;
}

describe("cardFacts", () => {
  it("gives each job its owner, schedule type and severity, from the job or the defaults", () => {
    const facts = cardFacts(EXAMPLE_DOCUMENT);
    expect(facts.get("orders_ingest")).toEqual({ owner: "ingestion-team", schedule: "continuous", critical: true });
    expect(facts.get("watchdog_demo_fails")).toEqual({ owner: "platform-team", schedule: "scheduled", critical: true });
    expect(facts.get("daily_revenue_export")).toEqual({ owner: "analytics-team", schedule: "triggered", critical: false });
    expect(facts.get("watchdog_demo_slow")).toEqual({ owner: "platform-team", schedule: "scheduled", critical: false });
  });

  it("leaves the owner empty when the job's own empty owner switches the default off", () => {
    const doc: JobListDocument = { defaults: { owner: "platform-team" }, jobs: [{ job_name: "a", owner: "" }] };
    expect(cardFacts(doc).get("a")?.owner).toBe("");
  });
});

describe("jobDetails", () => {
  const inherited = inheritedSettings(EXAMPLE_DOCUMENT);

  it("lists a job's own settings", () => {
    expect(jobDetails(entry("orders_ingest"), inherited)).toEqual({
      owner: { text: "ingestion-team", inherited: false },
      schedule: { text: "Continuous", inherited: false },
      severity: { text: "CRITICAL", inherited: false },
      maxGap: { text: "30 min", inherited: false },
      maxRuntime: { text: "None", inherited: false },
      maxRetries: { text: "3", inherited: false },
      enabled: { text: "No", inherited: false },
    });
  });

  it("marks the settings a job takes from the defaults", () => {
    expect(jobDetails(entry("watchdog_demo_fails"), inherited)).toEqual({
      owner: { text: "platform-team", inherited: true },
      schedule: { text: "Scheduled", inherited: true },
      severity: { text: "CRITICAL", inherited: false },
      maxGap: { text: "1440 min", inherited: false },
      maxRuntime: { text: "30 min", inherited: false },
      maxRetries: { text: "1", inherited: false },
      enabled: { text: "Yes", inherited: true },
    });
  });

  it("gives a triggered job no gap, and says where a job is switched on or off against its own setting", () => {
    const doc: JobListDocument = {
      defaults: { max_gap_minutes: 60, max_retries: 2 },
      jobs: [
        { job_name: "t", schedule_type: "triggered", enabled: false, environments: { lower: { enabled: true } } },
        { job_name: "s", environments: { production: { enabled: false }, lower: { owner: "dev-team" } } },
      ],
    };
    const defaults = inheritedSettings(doc);
    const triggered = jobDetails(entry("t", doc), defaults);
    expect(triggered.maxGap).toEqual({ text: "None", inherited: false });
    expect(triggered.maxRetries).toEqual({ text: "2", inherited: true });
    expect(triggered.enabled).toEqual({ text: "No, on in lower", inherited: false });
    const scheduled = jobDetails(entry("s", doc), defaults);
    expect(scheduled.maxGap).toEqual({ text: "60 min", inherited: true });
    expect(scheduled.owner).toEqual({ text: "Not set", inherited: false });
    expect(scheduled.enabled).toEqual({ text: "Yes, off in production", inherited: true });
  });
});
