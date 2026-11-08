import type { Authentication, AuthStatus } from "../src/auth/index.js";

export function fixtureAuthentication(initial: AuthStatus["kind"] = "api-key"): Authentication {
  let kind = initial;
  return {
    async getToken() {
      if (kind === "signed-out") throw new Error("Run /supermemory login.");
      return "fixture-token";
    },
    async status() { return { kind }; },
    async captureIdentity() {
      if (kind === "signed-out") throw new Error("Run /supermemory login.");
      return "fixture-authorization";
    },
    async login() { kind = "oauth"; },
    async logout() { kind = "signed-out"; return { revoked: true }; },
    async close() {},
  };
}
