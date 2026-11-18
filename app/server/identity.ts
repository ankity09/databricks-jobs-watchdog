import type express from "express";

/**
 * Who is calling. Behind the Databricks Apps proxy, x-forwarded-user and
 * x-forwarded-email carry the signed-in person. In local development AppKit
 * adds them for loopback requests when a CLI profile is set.
 */

export interface Principal {
  user: string;
  email: string;
}

/** What principal() reads from a request (an Express request fits). */
export interface HeaderSource {
  header(name: string): string | undefined;
}

function headerValue(req: HeaderSource, name: string): string | null {
  return req.header(name)?.trim() || null;
}

/** The person behind a request, for attribution such as saved_by. Falls back to "local-dev" without the headers. */
export function principal(req: HeaderSource): Principal {
  const user = headerValue(req, "x-forwarded-user") ?? "local-dev";
  return { user, email: headerValue(req, "x-forwarded-email") ?? user };
}

/** GET /api/whoami returns { user, email }, each null when the proxy did not send it. */
export function registerIdentityRoutes(app: express.Application): void {
  app.get("/api/whoami", (req, res) => {
    res.json({ user: headerValue(req, "x-forwarded-user"), email: headerValue(req, "x-forwarded-email") });
  });
}
