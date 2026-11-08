import { join } from "node:path";
import { createHash } from "node:crypto";
import { CredentialStorage } from "./storage.js";
import { OAuthAuthentication, type Authentication } from "./oauth.js";

export type { Authentication, AuthStatus, LoginOptions } from "./oauth.js";
export { AuthenticationRequired } from "./oauth.js";

/** Explicit environment keys remain an override, not something login can
 * secretly replace. OAuth is the default whenever no key was supplied. */
export function createAuthentication(agentDirectory: string, apiKey?: string): Authentication {
  const oauth = new OAuthAuthentication(new CredentialStorage(join(agentDirectory, "supermemory")));
  if (!apiKey) return oauth;
  return {
    async getToken(expectedCaptureIdentity) {
      if (expectedCaptureIdentity && expectedCaptureIdentity !== createHash("sha256").update(apiKey).digest("hex")) throw new Error("Capture API-key identity changed; no content was sent.");
      return apiKey;
    },
    async captureIdentity() { return createHash("sha256").update(apiKey).digest("hex"); },
    async status() { return { kind: "api-key" }; },
    async login() {
      throw new Error("SUPERMEMORY_API_KEY is overriding OAuth. Unset it and restart Pi, then run /supermemory login. No browser was opened.");
    },
    async logout() {
      throw new Error("An environment API key is active. Unset SUPERMEMORY_API_KEY and restart Pi; logout cannot revoke or unset that key.");
    },
    async close() { await oauth.close(); },
  };
}
