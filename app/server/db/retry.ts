/**
 * A Lakebase compute that scaled to zero takes a few seconds to wake up. The
 * first connection can fail while it does, so connection errors get one more
 * try. Query errors (a bad statement, a duplicate key) never do.
 */

export interface RetryOptions {
  retries?: number;
  delayMs?: number;
}

/** Network errors from Node, and the Postgres codes for a server that is starting or unreachable. */
const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P03", "08006", "08001"]);

/** node-postgres raises this when the pool cannot open a connection in time. */
const CONNECT_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";

export function isConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && typeof error.code === "string" && CONNECTION_CODES.has(error.code)) return true;
  return "message" in error && typeof error.message === "string"
    && error.message.toLowerCase().includes(CONNECT_TIMEOUT_MESSAGE);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs fn, and runs it again after delayMs when it fails with a connection error (1 retry after 1500 ms by default). */
export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const retries = opts?.retries ?? 1;
  const delayMs = opts?.delayMs ?? 1500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !isConnectionError(error)) throw error;
      await sleep(delayMs);
    }
  }
}
