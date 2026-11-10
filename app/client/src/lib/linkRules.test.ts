import { describe, expect, it } from "vitest";
import { EXAMPLE_DOCUMENT } from "../test/example-document";
import { type MapNodeRef, proposeLink } from "./linkRules";

function job(name: string): MapNodeRef {
  return { kind: "job", name };
}

function service(name: string): MapNodeRef {
  return { kind: "service", name };
}

describe("proposeLink", () => {
  it("a box can't link to itself", () => {
    expect(proposeLink(EXAMPLE_DOCUMENT, job("watchdog_demo_slow"), job("watchdog_demo_slow"))).toEqual({ ok: false, reason: "A box can't link to itself." });
    expect(proposeLink(EXAMPLE_DOCUMENT, service("kafka"), service("kafka"))).toEqual({ ok: false, reason: "A box can't link to itself." });
  });

  it("two services can't be linked", () => {
    expect(proposeLink(EXAMPLE_DOCUMENT, service("kafka"), service("config_api"))).toEqual({ ok: false, reason: "Two services can't be linked." });
  });

  it("a duplicate link is refused", () => {
    const linked = { ok: false, reason: "These two are already linked." };
    // orders_enrich depends on orders_ingest: a drag either way between them.
    expect(proposeLink(EXAMPLE_DOCUMENT, job("orders_ingest"), job("orders_enrich"))).toEqual(linked);
    expect(proposeLink(EXAMPLE_DOCUMENT, job("orders_enrich"), job("orders_ingest"))).toEqual(linked);
    // A child job link counts too.
    expect(proposeLink(EXAMPLE_DOCUMENT, job("daily_revenue_report"), job("daily_revenue_export"))).toEqual(linked);
    // orders_ingest needs the service kafka.
    expect(proposeLink(EXAMPLE_DOCUMENT, service("kafka"), job("orders_ingest"))).toEqual(linked);
    expect(proposeLink(EXAMPLE_DOCUMENT, job("orders_ingest"), service("kafka"))).toEqual(linked);
    // A job named kafka would be another box than the service kafka.
    expect(proposeLink(EXAMPLE_DOCUMENT, job("kafka"), job("orders_ingest"))).toMatchObject({ ok: true });
  });

  it("job to job means the target depends on the source", () => {
    expect(proposeLink(EXAMPLE_DOCUMENT, job("watchdog_demo_slow"), job("watchdog_demo_retries"))).toEqual({
      ok: true,
      jobName: "watchdog_demo_retries",
      dependsOn: "watchdog_demo_slow",
      service: false,
    });
    expect(proposeLink(EXAMPLE_DOCUMENT, job("watchdog_demo_retries"), job("watchdog_demo_slow"))).toEqual({
      ok: true,
      jobName: "watchdog_demo_slow",
      dependsOn: "watchdog_demo_retries",
      service: false,
    });
  });

  it("a service is always the one depended on", () => {
    const needsKafka = { ok: true, jobName: "watchdog_demo_slow", dependsOn: "kafka", service: true };
    // Dragged from the service to the job, and from the job to the service.
    expect(proposeLink(EXAMPLE_DOCUMENT, service("kafka"), job("watchdog_demo_slow"))).toEqual(needsKafka);
    expect(proposeLink(EXAMPLE_DOCUMENT, job("watchdog_demo_slow"), service("kafka"))).toEqual(needsKafka);
  });
});
