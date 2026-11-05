import { describe, expect, it, vi } from "vitest";
import { createPgVersionRepo } from "./pg-repo";

/** A pool whose one client runs `query`, and records how it was released. */
function fakePool(query: (text: string) => Promise<unknown>) {
  const release = vi.fn();
  const client = { query: vi.fn(query), release };
  const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue(client), end: vi.fn(), totalCount: 0, idleCount: 0, waitingCount: 0 };
  return { release, client, repo: createPgVersionRepo(pool) };
}

describe("the Lakebase transaction", () => {
  it("returns a healthy client to the pool", async () => {
    const { release, repo } = fakePool(() => Promise.resolve({ rows: [] }));
    await expect(repo.transaction(() => Promise.resolve("done"))).resolves.toBe("done");
    expect(release).toHaveBeenCalledWith();
  });

  it("returns the client normally when the work fails but ROLLBACK works", async () => {
    const { release, repo } = fakePool(() => Promise.resolve({ rows: [] }));
    await expect(repo.transaction(() => Promise.reject(new Error("conflict")))).rejects.toThrow("conflict");
    expect(release).toHaveBeenCalledWith();
  });

  it("drops the client when ROLLBACK fails", async () => {
    const { release, repo } = fakePool((text) => (text === "ROLLBACK" ? Promise.reject(new Error("connection lost")) : Promise.resolve({ rows: [] })));
    await expect(repo.transaction(() => Promise.reject(new Error("conflict")))).rejects.toThrow("conflict");
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("drops the client when COMMIT fails", async () => {
    const { release, repo } = fakePool((text) => (text === "COMMIT" ? Promise.reject(new Error("connection lost")) : Promise.resolve({ rows: [] })));
    await expect(repo.transaction(() => Promise.resolve(1))).rejects.toThrow("connection lost");
    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });
});
