import { createServer, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import * as oauth from "openid-client";
import { z } from "zod";
import { CredentialStorage, ISSUER, RESOURCE, type Credentials } from "./storage.js";

const CALLBACK_PORT = 19878;
const LOGIN_TIMEOUT_MS = 180_000;
const HTTP_TIMEOUT_SECONDS = 10;
const REFRESH_SKEW_MS = 60_000;
const SCOPES = "openid profile email offline_access";
const tokenSchema = z.object({
  access_token: z.string().min(1).max(32_768),
  token_type: z.string().refine(value => value.toLowerCase() === "bearer"),
  refresh_token: z.string().min(1).max(32_768).optional(),
  expires_in: z.number().finite().positive(),
});

export interface LoginOptions {
  openBrowser: (url: URL) => Promise<void>;
  signal?: AbortSignal;
}
export interface AuthStatus { kind: "oauth" | "api-key" | "signed-out"; expiresAt?: number }
export interface Authentication {
  getToken(expectedCaptureIdentity?: string): Promise<string>;
  captureIdentity(): Promise<string>;
  status(): Promise<AuthStatus>;
  login(options: LoginOptions): Promise<void>;
  logout(): Promise<{ revoked: boolean }>;
  close(): Promise<void>;
}

export class AuthenticationRequired extends Error {
  constructor() { super("Supermemory is not signed in. Run /supermemory login in an interactive Pi session."); }
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class OAuthAuthentication implements Authentication {
  private pendingRefresh: Promise<string> | undefined;
  private pendingLogin: Promise<void> | undefined;
  private loginAbort: AbortController | undefined;
  private closed = false;

  constructor(
    private readonly storage: CredentialStorage,
    private readonly transport: typeof fetch = fetch,
    private readonly callbackPort = CALLBACK_PORT,
    private readonly loginTimeoutMs = LOGIN_TIMEOUT_MS,
  ) {}

  private fetchFor(signal?: AbortSignal): oauth.CustomFetch {
    return async (url, options) => {
      const endpoint = new URL(url);
      if (endpoint.protocol !== "https:" || endpoint.origin !== new URL(ISSUER).origin
        || endpoint.username || endpoint.password || endpoint.hash) {
        throw new Error("Untrusted Supermemory OAuth endpoint.");
      }
      const signals = [AbortSignal.timeout(HTTP_TIMEOUT_SECONDS * 1000)];
      if (signal) signals.push(signal);
      if (options.signal) signals.push(options.signal);
      // Copy byte views to an owned ArrayBuffer instead of asserting across
      // the library/DOM typed-array boundary.
      const body = options.body instanceof Uint8Array ? new Uint8Array(options.body).buffer : options.body;
      const response = await this.transport(url, { ...options, body, redirect: "error", signal: AbortSignal.any(signals) });
      // Supermemory's public DCR endpoint currently returns 200, while RFC 7591
      // and openid-client require 201. Normalize only that successful endpoint;
      // retain the body for the library's full registration validation.
      if (endpoint.href === `${ISSUER}/oauth2/register` && response.status === 200) {
        return new Response(response.body, { status: 201, headers: response.headers });
      }
      return response;
    };
  }

  private checkConfiguration(configuration: oauth.Configuration): void {
    const metadata = configuration.serverMetadata();
    if (metadata.issuer !== ISSUER || !metadata.code_challenge_methods_supported?.includes("S256")) {
      throw new Error("Invalid Supermemory OAuth metadata.");
    }
    for (const value of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.registration_endpoint, metadata.revocation_endpoint]) {
      if (!value) throw new Error("Incomplete Supermemory OAuth metadata.");
      const endpoint = new URL(value);
      if (endpoint.protocol !== "https:" || endpoint.origin !== new URL(ISSUER).origin
        || endpoint.username || endpoint.password || endpoint.hash) throw new Error("Untrusted Supermemory OAuth metadata.");
    }
  }

  private async configuration(saved: Credentials): Promise<oauth.Configuration> {
    const configuration = await oauth.discovery(new URL(ISSUER), saved.clientId,
      { token_endpoint_auth_method: "none" }, oauth.None(), {
        algorithm: "oauth2", timeout: HTTP_TIMEOUT_SECONDS, [oauth.customFetch]: this.fetchFor(),
      });
    this.checkConfiguration(configuration);
    return configuration;
  }

  async captureIdentity(): Promise<string> {
    const saved = await this.storage.read();
    if (!saved) throw new AuthenticationRequired();
    // Bind pending uploads to this explicit authorization grant, not a mutable
    // active account or rotating access token. Re-login intentionally changes it.
    return createHash("sha256").update(JSON.stringify({ issuer: saved.issuer, resource: saved.resource, clientId: saved.clientId })).digest("hex");
  }

  async status(): Promise<AuthStatus> {
    const saved = await this.storage.read();
    return saved ? { kind: "oauth", expiresAt: saved.expiresAt } : { kind: "signed-out" };
  }

  getToken(expectedCaptureIdentity?: string): Promise<string> {
    if (expectedCaptureIdentity) return this.boundToken(expectedCaptureIdentity);
    if (this.closed) return Promise.reject(new Error("Supermemory authentication has shut down; retry in the active session."));
    if (!this.pendingRefresh) {
      // Register the entire read/refresh operation synchronously so immediate
      // shutdown cannot miss work that is still reading the credential file.
      const refresh = this.readOrRefresh();
      this.pendingRefresh = refresh;
      // Both outcomes clear the single-flight slot without creating an unhandled
      // rejection. The actual caller still receives any failure.
      void refresh.then(() => { this.pendingRefresh = undefined; }, () => { this.pendingRefresh = undefined; });
    }
    return this.pendingRefresh;
  }

  private async boundToken(expectedIdentity: string): Promise<string> {
    const token = await this.getToken();
    const saved = await this.storage.read();
    if (!saved || token !== saved.accessToken) throw new Error("Capture authorization changed; retry after checking the signed-in account.");
    const identity = createHash("sha256").update(JSON.stringify({ issuer: saved.issuer, resource: saved.resource, clientId: saved.clientId })).digest("hex");
    if (identity !== expectedIdentity) throw new Error("Capture authorization changed; no content was sent to the new account.");
    // A concurrent later login cannot turn this already-bound token into a
    // different account's token; callers retain this exact credential.
    return token;
  }

  private async readOrRefresh(): Promise<string> {
    const saved = await this.storage.read();
    if (!saved) throw new AuthenticationRequired();
    if (saved.expiresAt > Date.now() + REFRESH_SKEW_MS) return saved.accessToken;
    return this.refresh();
  }

  private async refresh(): Promise<string> {
    return this.storage.withLock(async assertOwned => {
      const saved = await this.storage.read();
      if (!saved) throw new AuthenticationRequired();
      if (saved.expiresAt > Date.now() + REFRESH_SKEW_MS) return saved.accessToken;
      let exchangeStarted = false;
      try {
        const configuration = await this.configuration(saved);
        // Deliberately independent of the calling tool's cancellation: a rotated
        // refresh token must be persisted even after that caller stops waiting.
        exchangeStarted = true;
        const raw = await oauth.refreshTokenGrant(configuration, saved.refreshToken, { resource: RESOURCE });
        const parsed = tokenSchema.safeParse(raw);
        if (!parsed.success) throw new Error("Invalid token response.");
        assertOwned();
        const credentials: Credentials = {
          ...saved,
          accessToken: parsed.data.access_token,
          refreshToken: parsed.data.refresh_token ?? saved.refreshToken,
          expiresAt: Date.now() + parsed.data.expires_in * 1000,
        };
        await this.storage.write(credentials);
        return credentials.accessToken;
      } catch (error) {
        assertOwned();
        if (!exchangeStarted) throw new Error("Supermemory OAuth discovery is unavailable. Credentials were retained; retry later.");
        // Never reuse an uncertain/rotated refresh token after a failed exchange.
        // This includes lost responses and malformed acceptances, not only
        // invalid_grant. Reauthentication is safer than repeated stale refresh.
        await this.storage.clear();
        if (error instanceof oauth.ResponseBodyError && ["invalid_grant", "invalid_client"].includes(error.error)) {
          throw new AuthenticationRequired();
        }
        throw new Error("Supermemory OAuth refresh was not confirmed. Local login was cleared to avoid reusing a rotated token. Run /supermemory login again.");
      }
    });
  }

  async login(options: LoginOptions): Promise<void> {
    if (this.closed) throw new Error("Supermemory authentication has shut down.");
    if (this.pendingLogin) throw new Error("Supermemory login is already running.");
    this.loginAbort = new AbortController();
    const signal = AbortSignal.any([
      this.loginAbort.signal, AbortSignal.timeout(this.loginTimeoutMs),
      ...(options.signal ? [options.signal] : []),
    ]);
    this.pendingLogin = this.storage.withLock(async assertOwned => {
      signal.throwIfAborted();
      let server: Server | undefined;
      let exchange: Promise<void> | undefined;
      try {
        server = createServer();
        await new Promise<void>((resolve, reject) => {
          server?.once("error", reject);
          server?.listen(this.callbackPort, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Callback listener unavailable.");
        const redirectUri = `http://127.0.0.1:${address.port}/callback`;
        const configuration = await oauth.dynamicClientRegistration(new URL(ISSUER), {
          client_name: "Supermemory for Pi",
          software_id: "pi-supermemory",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"], scope: SCOPES,
        }, oauth.None(), {
          algorithm: "oauth2", timeout: HTTP_TIMEOUT_SECONDS,
          [oauth.customFetch]: this.fetchFor(signal),
        });
        this.checkConfiguration(configuration);
        const registered = z.object({
          client_id: z.string().min(1).max(4096),
          token_endpoint_auth_method: z.literal("none"),
          redirect_uris: z.array(z.string().url()),
        }).safeParse(configuration.clientMetadata());
        if (!registered.success || !registered.data.redirect_uris.includes(redirectUri)) throw new Error("Invalid public-client registration.");
        const metadata = registered.data;
        const verifier = oauth.randomPKCECodeVerifier();
        const state = oauth.randomState();
        const authorizationUrl = oauth.buildAuthorizationUrl(configuration, {
          response_type: "code", redirect_uri: redirectUri, scope: SCOPES,
          resource: RESOURCE, prompt: "consent", state,
          code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
        });
        const listener = server;
        await new Promise<void>((resolve, reject) => {
          let consumed = false;
          const abort = () => {
            // The exchange settles under the same lock; don't release ownership
            // while a response or an atomic write is still in flight.
            if (!consumed) reject(new Error("Login cancelled or timed out."));
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) { abort(); return; }
          listener.on("request", (request, response) => {
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Referrer-Policy", "no-referrer");
            response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${address.port}`) {
              response.writeHead(400).end("Invalid callback."); return;
            }
            let url: URL;
            try { url = new URL(request.url ?? "/", redirectUri); }
            catch { response.writeHead(400).end("Invalid callback URL."); return; }
            if (url.origin !== new URL(redirectUri).origin || url.pathname !== "/callback") {
              response.writeHead(404).end(); return;
            }
            if (url.searchParams.getAll("state").length !== 1
              || !constantTimeEqual(url.searchParams.get("state") ?? "", state)
              || (url.searchParams.has("iss") && url.searchParams.get("iss") !== ISSUER)) {
              response.writeHead(400).end("Invalid authorization state or issuer."); return;
            }
            if (consumed) { response.writeHead(409).end("Callback already used."); return; }
            consumed = true;
            // Keep ownership until an in-flight exchange/atomic save settles,
            // even when cancellation has already rejected the outer wait.
            exchange = (async () => {
              try {
                const raw = await oauth.authorizationCodeGrant(configuration, url, {
                  pkceCodeVerifier: verifier, expectedState: state,
                }, { resource: RESOURCE });
                const parsed = tokenSchema.safeParse(raw);
                if (!parsed.success || !parsed.data.refresh_token) throw new Error("Missing refresh token or invalid acceptance.");
                signal.throwIfAborted();
                assertOwned();
                await this.storage.write({
                  version: 1, issuer: ISSUER, resource: RESOURCE,
                  clientId: metadata.client_id, redirectUri,
                  accessToken: parsed.data.access_token,
                  refreshToken: parsed.data.refresh_token,
                  expiresAt: Date.now() + parsed.data.expires_in * 1000,
                });
                response.writeHead(200).end("Supermemory connected. You can close this tab and return to Pi.");
                resolve();
              } catch {
                if (!response.headersSent && !response.destroyed) {
                  response.writeHead(400).end("Supermemory was not connected. Return to Pi and retry login.");
                }
                reject(new Error("Authorization denied or token exchange failed."));
              } finally { signal.removeEventListener("abort", abort); }
            })();
          });
          void options.openBrowser(authorizationUrl).catch(() => reject(new Error("Could not open the browser.")));
        });
      } finally {
        if (exchange) await exchange;
        server?.closeAllConnections();
        if (server?.listening) await new Promise<void>(resolve => server?.close(() => resolve()));
      }
    });
    try { await this.pendingLogin; }
    catch { throw new Error("Supermemory login did not finish. Check browser consent, callback port 19878, and network, then retry /supermemory login."); }
    finally { this.pendingLogin = undefined; this.loginAbort = undefined; }
  }

  async logout(): Promise<{ revoked: boolean }> {
    this.loginAbort?.abort();
    if (this.pendingLogin) await this.pendingLogin.catch(() => undefined);
    return this.storage.withLock(async assertOwned => {
      let revoked = false;
      try {
        const saved = await this.storage.read();
        if (saved) {
          const configuration = await this.configuration(saved);
          await oauth.tokenRevocation(configuration, saved.refreshToken, { token_type_hint: "refresh_token" });
          revoked = true;
        } else revoked = true;
      } catch {
        // Local logout still must succeed when offline or storage is malformed.
        // The caller is told that remote revocation was not confirmed.
        revoked = false;
      } finally {
        assertOwned();
        await this.storage.clear();
      }
      return { revoked };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.loginAbort?.abort();
    if (this.pendingLogin) await this.pendingLogin.catch(() => undefined);
    if (this.pendingRefresh) await this.pendingRefresh.catch(() => undefined);
  }
}
