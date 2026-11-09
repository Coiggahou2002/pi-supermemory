import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, symlink, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CredentialStorage } from "../src/auth/storage.js";
import { OAuthAuthentication } from "../src/auth/oauth.js";
import { createAuthentication } from "../src/auth/index.js";
import { createSupermemoryStore } from "../src/store.js";
import type { CaptureBatch } from "../src/capture/types.js";
import { OAuthFixture } from "./oauth-fixture.js";

async function fixture(timeout = 5000) {
  const directory = await mkdtemp(join(tmpdir(), "pi-supermemory-oauth-"));
  const storage = new CredentialStorage(join(directory, "supermemory"));
  const server = new OAuthFixture();
  const auth = new OAuthAuthentication(storage, server.transport, 0, timeout);
  return {
    directory, storage, server, auth,
    login: () => auth.login({ openBrowser: async url => {
      const response = await fetch(server.callback(url));
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), /access-1|refresh-1|fixture-code/);
    } }),
    cleanup: async () => { await auth.close(); await rm(directory, { recursive: true, force: true }); },
    expire: async () => {
      const credentials = await storage.read();
      assert.ok(credentials);
      await storage.withLock(() => storage.write({ ...credentials, expiresAt: Date.now() - 1000 }));
    },
  };
}

test("OAuth: real library DCR + PKCE + real loopback callback, secure persistence, reopen, and SDK auth", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.auth.status(), { kind: "signed-out" });
    await assert.rejects(f.auth.getToken(), /supermemory login/);
    await f.login();
    assert.equal(f.server.registrations, 1);
    assert.equal(f.server.exchanges, 1);
    assert.equal((await f.auth.status()).kind, "oauth");
    if (process.platform !== "win32") {
      assert.equal((await stat(f.storage.directory)).mode & 0o777, 0o700);
      assert.equal((await stat(f.storage.path)).mode & 0o777, 0o600);
    }
    const reopened = new OAuthAuthentication(new CredentialStorage(f.storage.directory), f.server.transport, 0);
    assert.equal(await reopened.getToken(), "access-1");
    let requests = 0;
    const store = createSupermemoryStore(() => reopened.getToken(), async (_input, init) => {
      requests++;
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access-1");
      return Response.json({ results: [] });
    });
    await store.search("fixture-project", "previous decision");
    assert.equal(requests, 1);
    await reopened.close();
  } finally { await f.cleanup(); }
});

test("OAuth: wrong state, issuer, and callback paths are rejected without consuming login", async () => {
  const f = await fixture();
  try {
    await f.auth.login({ openBrowser: async url => {
      const good = f.server.callback(url);
      const wrongState = new URL(good);
      wrongState.searchParams.set("state", "attacker");
      assert.equal((await fetch(wrongState)).status, 400);
      const wrongIssuer = new URL(good);
      wrongIssuer.searchParams.set("iss", "https://attacker.invalid");
      assert.equal((await fetch(wrongIssuer)).status, 400);
      const wrongPath = new URL(good);
      wrongPath.pathname = "/other";
      assert.equal((await fetch(wrongPath)).status, 404);
      assert.equal((await fetch(good)).status, 200);
    } });
    assert.equal(f.server.exchanges, 1);
  } finally { await f.cleanup(); }
});

test("OAuth: callback is single-use while a token exchange is in flight", async () => {
  const f = await fixture();
  try {
    f.server.tokenDelayMs = 100;
    await f.auth.login({ openBrowser: async url => {
      const callback = f.server.callback(url);
      let started: (() => void) | undefined;
      const tokenStarted = new Promise<void>(resolve => { started = resolve; });
      f.server.tokenStarted = () => started?.();
      const first = fetch(callback);
      await tokenStarted;
      assert.equal((await fetch(callback)).status, 409);
      assert.equal((await first).status, 200);
    } });
    assert.equal(f.server.exchanges, 1);
  } finally { await f.cleanup(); }
});

test("OAuth: refresh rotates tokens once across callers and separate auth instances", async () => {
  const f = await fixture();
  try {
    await f.login();
    await f.expire();
    f.server.tokenDelayMs = 100;
    const other = new OAuthAuthentication(new CredentialStorage(f.storage.directory), f.server.transport, 0);
    const tokens = await Promise.all([f.auth.getToken(), f.auth.getToken(), other.getToken()]);
    assert.deepEqual(tokens, ["access-2", "access-2", "access-2"]);
    assert.equal(f.server.refreshes, 1);
    assert.equal((await f.storage.read())?.refreshToken, "refresh-2");
    await other.close();
  } finally { await f.cleanup(); }
});

test("OAuth: two actual Pi-like processes serialize a rotating refresh through the shared lock", { timeout: 15000 }, async () => {
  const f = await fixture();
  const failures: unknown[] = [];
  const listener = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const result = await f.server.transport(new URL(request.url ?? "/", "https://api.supermemory.ai"), { method: request.method, body: body || undefined });
      result.headers.forEach((value, key) => response.setHeader(key, value));
      response.writeHead(result.status).end(await result.text());
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    await f.login();
    await f.expire();
    f.server.tokenDelayMs = 150;
    const exec = promisify(execFile);
    const run = () => exec(process.execPath, ["--import", "tsx", "test/refresh-child.ts", f.storage.directory, `http://127.0.0.1:${address.port}`], { timeout: 10000 });
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(results.map(result => result.stdout.trim()), ["ok", "ok"]);
    assert.deepEqual(failures, []);
    assert.equal(f.server.refreshes, 1);
    assert.equal((await f.storage.read())?.refreshToken, "refresh-2");
  } finally {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await f.cleanup();
  }
});

test("OAuth: missing rotated refresh token retains the previous refresh token", async () => {
  const f = await fixture();
  try {
    await f.login();
    await f.expire();
    f.server.omitRefreshToken = true;
    await f.auth.getToken();
    assert.equal((await f.storage.read())?.refreshToken, "refresh-1");
  } finally { await f.cleanup(); }
});

test("OAuth: invalid grant clears local login, never leaks token errors, and never retries", async () => {
  const f = await fixture();
  try {
    await f.login();
    await f.expire();
    f.server.refreshFailure = true;
    await assert.rejects(f.auth.getToken(), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /supermemory login/);
      assert.doesNotMatch(error.message, /private-token/);
      return true;
    });
    assert.equal(f.server.refreshes, 1);
    assert.equal(await f.storage.read(), undefined);
    await assert.rejects(f.auth.getToken(), /supermemory login/);
    assert.equal(f.server.refreshes, 1);
  } finally { await f.cleanup(); }
});

test("OAuth: discovery outage before refresh preserves credentials, malformed token acceptance invalidates them", async () => {
  const f = await fixture();
  try {
    await f.login();
    await f.expire();
    f.server.discoveryFailure = true;
    await assert.rejects(f.auth.getToken(), /retained/);
    assert.ok(await f.storage.read());
    assert.equal(f.server.refreshes, 0);
    f.server.discoveryFailure = false;
    f.server.malformedTokens = true;
    await assert.rejects(f.auth.getToken(), /Local login was cleared/);
    assert.equal(await f.storage.read(), undefined);
  } finally { await f.cleanup(); }
});

test("OAuth: logout revokes and clears credentials; offline revocation still clears locally", async () => {
  for (const offline of [false, true]) {
    const f = await fixture();
    try {
      await f.login();
      f.server.revocationFailure = offline;
      assert.deepEqual(await f.auth.logout(), { revoked: !offline });
      assert.equal(f.server.revocations, 1);
      assert.equal(await f.storage.read(), undefined);
      await assert.rejects(f.auth.getToken(), /supermemory login/);
    } finally { await f.cleanup(); }
  }
});

test("OAuth: logout and refresh serialize, so refresh cannot resurrect logged-out credentials", async () => {
  const f = await fixture();
  try {
    await f.login();
    await f.expire();
    f.server.tokenDelayMs = 100;
    let started: (() => void) | undefined;
    const tokenStarted = new Promise<void>(resolve => { started = resolve; });
    f.server.tokenStarted = () => started?.();
    const refresh = f.auth.getToken();
    await tokenStarted;
    const loggedOut = f.auth.logout();
    await refresh;
    assert.deepEqual(await loggedOut, { revoked: true });
    assert.equal(await f.storage.read(), undefined);
  } finally { await f.cleanup(); }
});

test("OAuth: denial, missing refresh token, and browser failure never create credentials", async () => {
  for (const scenario of ["denial", "missing-refresh", "browser-failure"]) {
    const f = await fixture();
    try {
      await assert.rejects(f.auth.login({ openBrowser: async url => {
        if (scenario === "browser-failure") throw new Error("private browser error");
        const callback = f.server.callback(url);
        if (scenario === "denial") {
          callback.searchParams.delete("code");
          callback.searchParams.set("error", "access_denied");
        } else f.server.omitRefreshToken = true;
        assert.equal((await fetch(callback)).status, 400);
      } }), /login did not finish/);
      assert.equal(await f.storage.read(), undefined);
    } finally { await f.cleanup(); }
  }
});

test("OAuth: timeout and cancellation close the listener, leave no credentials, and release the lock", async () => {
  for (const scenario of ["timeout", "cancel"]) {
    const f = await fixture(scenario === "timeout" ? 150 : 5000);
    const controller = new AbortController();
    let port: number | undefined;
    try {
      await assert.rejects(f.auth.login({ signal: controller.signal, openBrowser: async url => {
        const callback = f.server.callback(url);
        port = Number(callback.port);
        if (scenario === "cancel") controller.abort();
      } }), /login did not finish/);
      assert.equal(await f.storage.read(), undefined);
      assert.ok(port);
      const listener = createServer();
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>(resolve => listener.close(() => resolve()));
      await f.storage.withLock(async () => undefined);
    } finally { await f.cleanup(); }
  }
});

test("OAuth: cancellation during code exchange releases ownership only after exchange settles", async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    f.server.tokenDelayMs = 100;
    f.server.tokenStarted = () => controller.abort();
    await assert.rejects(f.auth.login({ signal: controller.signal, openBrowser: async url => {
      assert.equal((await fetch(f.server.callback(url))).status, 400);
    } }), /login did not finish/);
    await f.storage.withLock(async () => { assert.equal(await f.storage.read(), undefined); });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await f.storage.read(), undefined);
  } finally { await f.cleanup(); }
});

test("OAuth: an occupied callback port fails without disturbing the existing listener", async () => {
  const f = await fixture();
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const auth = new OAuthAuthentication(f.storage, f.server.transport, address.port);
  try {
    await assert.rejects(auth.login({ openBrowser: async () => assert.fail("Must not open browser") }), /callback port/);
    assert.equal(listener.listening, true);
    assert.equal(f.server.registrations, 0);
  } finally {
    await auth.close();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await f.cleanup();
  }
});

test("OAuth: shutdown waits for refresh persistence instead of dropping a rotated token", async () => {
  const f = await fixture();
  try {
    await f.login();
    await f.expire();
    f.server.tokenDelayMs = 100;
    const token = f.auth.getToken();
    // Immediate shutdown must also cover work still reading the file.
    await f.auth.close();
    assert.equal(await token, "access-2");
    assert.equal((await f.storage.read())?.refreshToken, "refresh-2");
    await assert.rejects(f.auth.getToken(), /shut down/);
  } finally { await f.cleanup(); }
});

test("OAuth: rejects unexpected issuer and cross-origin token endpoint before any credentials can be sent", async () => {
  for (const scenario of ["issuer", "endpoint"]) {
    const f = await fixture();
    try {
      f.server.wrongIssuer = scenario === "issuer";
      f.server.maliciousTokenEndpoint = scenario === "endpoint";
      await assert.rejects(f.auth.login({ openBrowser: async () => { assert.fail("Browser must not open"); } }), /login did not finish/);
      assert.equal(f.server.exchanges, 0);
      assert.equal(await f.storage.read(), undefined);
    } finally { await f.cleanup(); }
  }
});

test("storage validates JSON, ignores no failures except missing files, and refuses symlinks", async () => {
  const f = await fixture();
  try {
    await mkdir(f.storage.directory, { mode: 0o700 });
    await writeFile(f.storage.path, "{bad sensitive-json", { mode: 0o600 });
    await assert.rejects(f.storage.read(), /Invalid Supermemory credential JSON/);
    assert.deepEqual(await f.auth.logout(), { revoked: false });
    await symlink(join(f.directory, "other.json"), f.storage.path);
    await assert.rejects(f.storage.read(), /Cannot read/);
    await f.storage.clear();
    await f.login();
    const raw = await readFile(f.storage.path, "utf8");
    assert.match(raw, /refreshToken/);
  } finally { await f.cleanup(); }
});

test("capture credentials remain bound across refresh, but cannot follow a different OAuth grant/account", async () => {
  const f = await fixture();
  try {
    await f.login();
    const identity = await f.auth.captureIdentity();
    await f.expire();
    assert.equal(await f.auth.getToken(identity), "access-2");
    assert.equal(await f.auth.captureIdentity(), identity);
    let requests = 0;
    const store = createSupermemoryStore(expectedIdentity => f.auth.getToken(expectedIdentity), async () => {
      requests++;
      return Response.json({ id: `pi_capture_${"a".repeat(64)}`, status: "queued" });
    });
    const batch: CaptureBatch = { id: `pi_capture_${"a".repeat(64)}`, digest: "b".repeat(64), sourceIds: ["entry"], content: "fixture content", authority: identity, title: "Fixture", format: "text-v2", mode: "dynamic" };
    await store.capture("fixture", batch);
    const saved = await f.storage.read();
    assert.ok(saved);
    await f.storage.withLock(() => f.storage.write({ ...saved, clientId: "different-grant", accessToken: "different-access-token" }));
    await assert.rejects(store.capture("fixture", batch), /authorization changed/);
    assert.equal(requests, 1); // no content sent using the new account's token
  } finally { await f.cleanup(); }
});

test("explicit API-key override prevents misleading browser login/logout", async () => {
  const f = await fixture();
  try {
    const auth = createAuthentication(f.directory, "explicit-env-key");
    assert.deepEqual(await auth.status(), { kind: "api-key" });
    assert.equal(await auth.getToken(), "explicit-env-key");
    const identity = await auth.captureIdentity();
    assert.equal(await auth.getToken(identity), "explicit-env-key");
    await assert.rejects(auth.getToken("different-key-identity"), /identity changed/);
    await assert.rejects(auth.login({ openBrowser: async () => assert.fail("Must not open browser") }), /Unset it and restart/);
    await assert.rejects(auth.logout(), /cannot revoke or unset/);
    await auth.close();
  } finally { await f.cleanup(); }
});
