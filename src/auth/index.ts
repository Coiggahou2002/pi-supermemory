import { join } from "node:path";
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
    async getToken() { return apiKey; },
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
