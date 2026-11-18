import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSchema, schemaErrorLog, schemaGate } from "./schema";

function fakeClient() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
}

function fakePool(client: ReturnType<typeof fakeClient>) {
  return { query: vi.fn(), connect: vi.fn().mockResolvedValue(client), end: vi.fn(), totalCount: 0, idleCount: 0, waitingCount: 0 };
}

function statements(client: ReturnType<typeof fakeClient>): string[] {
  return client.query.mock.calls.map((call: unknown[]) => String(call[0]));
}

describe("ensureSchema", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates the schema and the job list table in one transaction", async () => {
    const client = fakeClient();
    await ensureSchema(fakePool(client));
    const sent = statements(client);
    expect(sent[0]).toBe("BEGIN");
    expect(sent[sent.length - 1]).toBe("COMMIT");
    expect(sent.join("\n")).toContain("CREATE SCHEMA IF NOT EXISTS watchdog_app");
    expect(sent.join("\n")).toContain("CREATE TABLE IF NOT EXISTS watchdog_app.job_list_versions");
    expect(sent.join("\n")).not.toContain("chat_");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("creates the map layout table without an identity column, a sequence or an index", async () => {
    const client = fakeClient();
    await ensureSchema(fakePool(client));
    const ddl = statements(client).find((s) => s.includes("watchdog_app.map_layout")) ?? "";
    expect(ddl).toContain("CREATE TABLE IF NOT EXISTS watchdog_app.map_layout");
    const table = ddl.slice(ddl.indexOf("watchdog_app.map_layout"));
    expect(table).not.toMatch(/IDENTITY|SERIAL|CREATE INDEX/i);
  });

  it("rolls back, drops the connection and rethrows when a statement fails", async () => {
    const client = fakeClient();
    const denied = Object.assign(new Error("permission denied for database"), { code: "42501" });
    client.query.mockImplementation((text: string) => (text.includes("CREATE") ? Promise.reject(denied) : Promise.resolve({ rows: [] })));
    await expect(ensureSchema(fakePool(client))).rejects.toThrow("permission denied");
    expect(statements(client)).toContain("ROLLBACK");
    expect(statements(client)).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledWith(denied);
  });

  it("tries again when the compute is waking up", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    const pool = fakePool(client);
    pool.connect.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const done = ensureSchema(pool);
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(statements(client)).toContain("COMMIT");
  });
});

describe("schemaGate", () => {
  const pool = fakePool(fakeClient());

  it("runs the schema check once it has worked, and not again", async () => {
    const ensure = vi.fn().mockResolvedValue(undefined);
    const gate = schemaGate(pool, { ensure });
    await gate.ready();
    await gate.ready();
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("tries again on a later request after a failure, but not more than once per wait", async () => {
    let now = 1_000;
    const ensure = vi.fn().mockRejectedValueOnce(new Error("timeout exceeded when trying to connect")).mockResolvedValue(undefined);
    const gate = schemaGate(pool, { ensure, retryAfterMs: 10_000, now: () => now });
    await expect(gate.ready()).rejects.toThrow("timeout");
    await expect(gate.ready()).rejects.toThrow("timeout");
    expect(ensure).toHaveBeenCalledTimes(1);
    now += 10_000;
    await gate.ready();
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("asks the database once for requests that arrive together", async () => {
    const ensure = vi.fn().mockResolvedValue(undefined);
    const gate = schemaGate(pool, { ensure });
    await Promise.all([gate.ready(), gate.ready(), gate.ready()]);
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});

describe("schemaErrorLog", () => {
  it("names the access job when the app's service principal was refused", () => {
    const denied = Object.assign(new Error("permission denied for schema watchdog_app"), { code: "42501" });
    expect(schemaErrorLog(denied)).toContain("watchdog_app_access");
    expect(schemaErrorLog(denied)).toContain("42501");
  });
  it("says the job list tries again for any other failure", () => {
    expect(schemaErrorLog(new Error("connect ECONNREFUSED"))).toBe(
      "[lakebase] Could not create the watchdog_app schema: connect ECONNREFUSED. The job list tries again on its next request.",
    );
  });
});
