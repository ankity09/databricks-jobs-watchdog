import { describe, expect, it, vi } from "vitest";
import { isConnectionError, withRetry } from "./retry";

describe("withRetry", () => {
  it("retries once when the compute is waking up", async () => {
    const fn = vi.fn().mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
      .mockResolvedValueOnce("ok");
    await expect(withRetry(fn, { delayMs: 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("does not retry a query error", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("duplicate key"), { code: "23505" }));
    await expect(withRetry(fn, { delayMs: 1 })).rejects.toThrow("duplicate key");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("gives up after the last retry", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    await expect(withRetry(fn, { retries: 2, delayMs: 1 })).rejects.toThrow("ECONNREFUSED");
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it.each(["ECONNRESET", "ETIMEDOUT", "57P03", "08006", "08001"])("treats %s as a connection error", (code) => {
    expect(isConnectionError(Object.assign(new Error("failed"), { code }))).toBe(true);
  });
  it("treats the pool's connect timeout as a connection error", () => {
    expect(isConnectionError(new Error("timeout exceeded when trying to connect"))).toBe(true);
  });
  it("does not treat a permission error as a connection error", () => {
    expect(isConnectionError(Object.assign(new Error("permission denied for schema"), { code: "42501" }))).toBe(false);
  });
});
