import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSchema } from "./schema";

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
