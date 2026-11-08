import assert from "node:assert/strict";
import { test } from "node:test";
import { createSupermemoryStore } from "../src/store.js";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

test("real SDK sends scoped authenticated search; adapter validates and removes old versions", async () => {
  let calls = 0;
  const transport: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://api.supermemory.ai/ns/my-project/search");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-key");
    assert.equal(init?.method, "POST");
    assert.equal(typeof init?.body, "string");
    assert.match(String(init?.body), /"searchMode":"memories"/);
    return response({ results: [
      { id: "current", memory: "current fact", similarity: 0.9, isLatest: true },
      { id: "old", memory: "forgotten fact", similarity: 0.99, isLatest: false },
    ] });
  };
  const store = createSupermemoryStore("test-key", transport);
  assert.deepEqual(await store.search("my-project", "prior decision"), [{ id: "current", text: "current fact", similarity: 0.9 }]);
  assert.equal(calls, 1);
});

test("malformed responses fail rather than pretending there are no memories", async () => {
  const store = createSupermemoryStore("test-key", async () => response({ results: [{ id: "x", memory: "fact", similarity: "0.9" }] }));
  await assert.rejects(store.search("test", "query"), /search failed/);
});

test("SDK server errors do not leak response data, keys, or retry writes", async () => {
  let calls = 0;
  const store = createSupermemoryStore("secret-test-key", async () => {
    calls++;
    return response({ detail: "private transcript secret-test-key" }, 500);
  });
  await assert.rejects(store.remember("test", "private transcript"), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /may have been accepted/);
    assert.doesNotMatch(error.message, /private transcript|secret-test-key/);
    return true;
  });
  assert.equal(calls, 1);
});

test("only valid write acceptance counts; queued is not completed extraction", async () => {
  const accepted = createSupermemoryStore("key", async (input, init) => {
    assert.equal(String(input), "https://api.supermemory.ai/ns/test/document");
    assert.match(String(init?.body), /"content":"remember this"/);
    return response({ id: "doc-1", status: "queued" });
  });
  assert.deepEqual(await accepted.remember("test", "remember this"), { id: "doc-1", status: "queued" });
  for (const invalid of [{ id: "", status: "queued" }, { id: "doc-1", status: "failed" }]) {
    const store = createSupermemoryStore("key", async () => response(invalid));
    await assert.rejects(store.remember("test", "fact"), /not confirmed/);
  }
});

test("cancellation reaches the real SDK transport", async () => {
  const controller = new AbortController();
  const store = createSupermemoryStore("key", async (_input, init) => {
    assert.ok(init?.signal);
    controller.abort();
    init.signal.throwIfAborted();
    throw new Error("unreachable");
  });
  await assert.rejects(store.search("test", "query", controller.signal), /cancelled/);
});
