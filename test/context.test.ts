import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { presentMemoryKeys } from "../src/context.js";
import { formatMemories, memoryKey, RECALL_TYPE, SEARCH_TOOL, selectMemories } from "../src/memory.js";

const memory = { id: "fact", text: "Use minimal skeleton code", similarity: 0.9 };
const namespace = "test-project";
const content = formatMemories(namespace, [memory]);

function makeSession() {
  const session = SessionManager.inMemory();
  const root = session.appendMessage({ role: "user", content: "Earlier decision?", timestamp: Date.now() });
  return { session, root };
}

test("persisted recall deduplicates, navigating before injection makes it eligible", () => {
  const { session, root } = makeSession();
  session.appendCustomMessageEntry(RECALL_TYPE, content, false);
  assert.equal(selectMemories([memory], presentMemoryKeys(session.buildSessionProjection(), namespace), namespace).length, 0);
  session.branch(root);
  assert.equal(selectMemories([memory], presentMemoryKeys(session.buildSessionProjection(), namespace), namespace).length, 1);
});

test("compaction removes old recall but retains newer recall", () => {
  const { session } = makeSession();
  session.appendCustomMessageEntry(RECALL_TYPE, content, false);
  const retained = session.appendMessage({ role: "user", content: "New topic", timestamp: Date.now() });
  session.appendCompaction("Summary without the original memory envelope", retained, 1000);
  assert.equal(presentMemoryKeys(session.buildSessionProjection(), namespace).size, 0);
  session.appendCustomMessageEntry(RECALL_TYPE, content, false);
  const keep = session.getLeafId();
  session.appendCompaction("Another summary", keep, 1000);
  assert.equal(presentMemoryKeys(session.buildSessionProjection(), namespace).size, 1);
});

test("context edits inspect actual projected content, not stale metadata", () => {
  const { session } = makeSession();
  const entry = session.appendCustomMessageEntry(RECALL_TYPE, content, false, { hashes: [memoryKey(memory.text)] });
  session.appendContextEdit(entry, { content: "Content was replaced" });
  assert.equal(presentMemoryKeys(session.buildSessionProjection(), namespace).size, 0);
  session.appendContextEdit(entry, { content });
  assert.equal(presentMemoryKeys(session.buildSessionProjection(), namespace).size, 1);
  session.appendContextEdit(entry, null);
  assert.equal(presentMemoryKeys(session.buildSessionProjection(), namespace).size, 0);
});

test("successful proactive search results count, failed results and other namespaces do not", () => {
  const { session } = makeSession();
  const entry = session.appendMessage({
    role: "toolResult", toolCallId: "call-1", toolName: SEARCH_TOOL,
    content: [{ type: "text", text: content }], isError: false, timestamp: Date.now(),
  });
  assert.equal(presentMemoryKeys(session.buildSessionProjection(), namespace).size, 1);
  assert.equal(presentMemoryKeys(session.buildSessionProjection(), "different").size, 0);
  session.branch(entry);
  const failed = SessionManager.inMemory();
  failed.appendMessage({
    role: "toolResult", toolCallId: "call-2", toolName: SEARCH_TOOL,
    content: [{ type: "text", text: content }], isError: true, timestamp: Date.now(),
  });
  assert.equal(presentMemoryKeys(failed.buildSessionProjection(), namespace).size, 0);
});

test("dedup survives an actual session file reopen without a sidecar cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-session-"));
  try {
    const session = SessionManager.create(directory, directory);
    session.appendMessage({ role: "user", content: "A question", timestamp: Date.now() });
    session.appendCustomMessageEntry(RECALL_TYPE, content, false);
    // Pi flushes its initial buffer after the first assistant message.
    session.appendMessage({
      role: "assistant", content: [{ type: "text", text: "Answer" }],
      api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const path = session.getSessionFile();
    assert.ok(path);
    const reopened = SessionManager.open(path);
    assert.equal(presentMemoryKeys(reopened.buildSessionProjection(), namespace).size, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
