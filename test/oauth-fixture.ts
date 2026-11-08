import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ISSUER, RESOURCE } from "../src/auth/storage.js";

const registrationSchema = z.object({
  token_endpoint_auth_method: z.literal("none"),
  redirect_uris: z.array(z.string()),
  grant_types: z.array(z.string()),
});

export class OAuthFixture {
  registrations = 0;
  exchanges = 0;
  refreshes = 0;
  revocations = 0;
  redirectUri = "";
  expectedChallenge = "";
  refreshToken = "refresh-1";
  refreshFailure = false;
  discoveryFailure = false;
  revocationFailure = false;
  maliciousTokenEndpoint = false;
  wrongIssuer = false;
  omitRefreshToken = false;
  malformedTokens = false;
  tokenDelayMs = 0;
  tokenStarted: (() => void) | undefined;
  readonly transport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.origin, "https://api.supermemory.ai");
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (url.pathname === "/.well-known/oauth-authorization-server/api/auth") {
      if (this.discoveryFailure) return json({ error: "unavailable" }, 503);
      return json({
        issuer: this.wrongIssuer ? "https://attacker.invalid" : ISSUER,
        authorization_endpoint: `${ISSUER}/oauth2/authorize`,
        token_endpoint: this.maliciousTokenEndpoint ? "https://attacker.invalid/token" : `${ISSUER}/oauth2/token`,
        registration_endpoint: `${ISSUER}/oauth2/register`,
        revocation_endpoint: `${ISSUER}/oauth2/revoke`,
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
    }
    if (url.pathname.endsWith("/register")) {
      const raw: unknown = JSON.parse(String(init?.body));
      const metadata = registrationSchema.parse(raw);
      assert.ok(metadata.grant_types.includes("refresh_token"));
      const redirect = metadata.redirect_uris[0];
      assert.ok(redirect);
      this.redirectUri = redirect;
      this.registrations++;
      // Match Supermemory's live (non-RFC-7591) success status.
      return json({ ...metadata, client_id: "fixture-client" }, 200);
    }
    const body = new URLSearchParams(String(init?.body));
    if (url.pathname.endsWith("/token")) {
      this.tokenStarted?.();
      if (this.tokenDelayMs) await new Promise(resolve => setTimeout(resolve, this.tokenDelayMs));
      assert.equal(body.get("client_id"), "fixture-client");
      assert.equal(body.get("resource"), RESOURCE);
      if (body.get("grant_type") === "authorization_code") {
        this.exchanges++;
        assert.equal(body.get("code"), "fixture-code");
        assert.equal(body.get("redirect_uri"), this.redirectUri);
        assert.equal(createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url"), this.expectedChallenge);
      } else {
        this.refreshes++;
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), this.refreshToken);
        if (this.refreshFailure) return json({ error: "invalid_grant", error_description: "private-token-must-not-leak" }, 400);
        this.refreshToken = `refresh-${this.refreshes + 1}`;
      }
      if (this.malformedTokens) return json({ access_token: "sensitive-token", token_type: "Bearer", expires_in: "invalid" });
      return json({ access_token: `access-${this.refreshes + 1}`, token_type: "Bearer", expires_in: 3600,
        ...(this.omitRefreshToken ? {} : { refresh_token: this.refreshToken }) });
    }
    if (url.pathname.endsWith("/revoke")) {
      this.revocations++;
      if (this.revocationFailure) return json({ error: "private-revocation-body" }, 503);
      assert.equal(body.get("client_id"), "fixture-client");
      assert.equal(body.get("token"), this.refreshToken);
      return json({});
    }
    throw new Error("Unexpected fixture URL");
  };

  callback(url: URL): URL {
    assert.equal(url.origin, "https://api.supermemory.ai");
    assert.equal(url.searchParams.get("resource"), RESOURCE);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.match(url.searchParams.get("scope") ?? "", /offline_access/);
    this.expectedChallenge = url.searchParams.get("code_challenge") ?? "";
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    redirect.searchParams.set("code", "fixture-code");
    redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
    redirect.searchParams.set("iss", ISSUER);
    return redirect;
  }
}
