import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { formatMemories, MAX_CONTEXT_BYTES, memoryKey, parseMemories, selectMemories, shouldRecall, type Memory } from "../src/memory.js";

function hit(id: string, text: string, similarity = 0.9): Memory {
  return { id, text, similarity };
}

test("capture defaults on, with recall/manual writes still opt-in and a persistent capture-off override", () => {
  assert.deepEqual(loadConfig({}), { apiKey: undefined, namespace: undefined, autoRecall: false, autoCapture: true, captureMode: "dynamic", allowWrites: false });
  assert.equal(loadConfig({ PI_SUPERMEMORY_AUTO_RECALL: "true" }).autoRecall, true);
  assert.equal(loadConfig({ PI_SUPERMEMORY_AUTO_CAPTURE: "true" }).autoCapture, true);
  assert.equal(loadConfig({ PI_SUPERMEMORY_AUTO_CAPTURE: "false" }).autoCapture, false);
  assert.equal(loadConfig({ PI_SUPERMEMORY_CAPTURE_MODE: "instant" }).captureMode, "instant");
  assert.throws(() => loadConfig({ PI_SUPERMEMORY_CAPTURE_MODE: "fast" }), /PI_SUPERMEMORY_CAPTURE_MODE/);
  assert.throws(() => loadConfig({ PI_SUPERMEMORY_AUTO_CAPTURE: "no" }), /PI_SUPERMEMORY_AUTO_CAPTURE/);
  assert.throws(() => loadConfig({ PI_SUPERMEMORY_AUTO_RECALL: "yes" }), /Invalid Supermemory settings/);
  assert.throws(() => loadConfig({ PI_SUPERMEMORY_NAMESPACE: "../secret" }), /PI_SUPERMEMORY_NAMESPACE/);
});

test("short Chinese substantive questions work; acknowledgements and private prompts skip", () => {
  for (const prompt of ["上次怎么定的？", "登录？", "Why use cookies?"]) assert.equal(shouldRecall(prompt), true);
  for (const prompt of ["", "next", "继续吧", "可以啊", "谢谢！", "/command", "<private>secret</private> explain"]) {
    assert.equal(shouldRecall(prompt), false, prompt);
  }
});

test("selection filters, sorts, deduplicates contents rather than IDs, and stays pure", () => {
  const present = new Set([memoryKey("already visible")]);
  const input = [hit("low", "low", 0.3), hit("a", "first", 0.8), hit("b", "first", 0.9), hit("seen", "already visible", 1)];
  const selected = selectMemories(input, present, "project");
  assert.deepEqual(selected.map(item => item.id), ["b"]);
  assert.equal(present.size, 1);
  assert.deepEqual(input.map(item => item.id), ["low", "a", "b", "seen"]);
  assert.notEqual(memoryKey("User.ts"), memoryKey("user.ts"));
  assert.equal(memoryKey("a  b"), memoryKey("a\nb"));
});

test("complete JSON output is bounded including Chinese, escaping, and framing", () => {
  for (const text of ["汉".repeat(4000), '"\\\n'.repeat(4000), "😀".repeat(4000)]) {
    const candidates = Array.from({ length: 20 }, (_, index) => hit(String(index), `${index}:${text}`));
    const selected = selectMemories(candidates, new Set(), "project");
    assert.ok(selected.length > 0 && selected.length <= 5);
    assert.ok(Buffer.byteLength(formatMemories("project", selected)) <= MAX_CONTEXT_BYTES);
    assert.deepEqual(parseMemories(formatMemories("project", selected), "project"), selected);
    assert.deepEqual(parseMemories(formatMemories("project", selected), "other"), []);
  }
});

test("changing a memory's content makes it eligible again", () => {
  const present = new Set([memoryKey("use port 3000")]);
  assert.equal(selectMemories([hit("same-id", "use port 8470")], present, "project").length, 1);
});
