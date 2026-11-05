import { describe, expect, it } from "vitest";
import { principal } from "./identity";

function request(headers: Record<string, string>) {
  return { header: (name: string): string | undefined => headers[name.toLowerCase()] };
}

describe("principal", () => {
  it("reads the user and the email the Apps proxy forwards", () => {
    const req = request({ "x-forwarded-user": "4321@1234", "x-forwarded-email": "dana@example.com" });
    expect(principal(req)).toEqual({ user: "4321@1234", email: "dana@example.com" });
  });
  it("falls back to local-dev when the headers are missing", () => {
    expect(principal(request({}))).toEqual({ user: "local-dev", email: "local-dev" });
  });
  it("uses the user when the proxy sends no email", () => {
    expect(principal(request({ "x-forwarded-user": "4321@1234" }))).toEqual({ user: "4321@1234", email: "4321@1234" });
  });
});
