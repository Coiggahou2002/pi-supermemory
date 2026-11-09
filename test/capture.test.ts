import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { z } from "zod";
import { createHash } from "node:crypto";
import { describeCaptureProgress, type CaptureBatch } from "../src/capture/types.js";
import { RECALL_TYPE } from "../src/memory.js";
import { prepareCapture, MAX_CAPTURE_BYTES } from "../src/capture/batch.js";
import { assistant, captureHarness, toolTurn, user } from "./capture-fixture.js";

test("capture only includes future user/final-answer text, once per settled run, not per tool turn", async () => {
  const h = await captureHarness();
  try {
    user(h.session, "OLD HISTORY MUST NOT BACKFILL");
    assistant(h.session, "OLD ANSWER");
    await h.begin("I prefer minimal skeleton code");
    h.session.appendCustomMessageEntry(RECALL_TYPE, "INJECTED RECALL MUST NOT BE CAPTURED", false);
    toolTurn(h.session, "TOOL DATA MUST NOT BE CAPTURED");
    await h.finish("We will use minimal typed functions.");
    assert.equal(h.sent.length, 1);
    const batch = h.sent[0];
    assert.ok(batch);
    assert.match(batch.content, /I prefer minimal skeleton code/);
    assert.match(batch.content, /We will use minimal typed functions/);
    assert.doesNotMatch(batch.content, /OLD HISTORY|OLD ANSWER|INJECTED RECALL|TOOL DATA|internal thinking|tool narration|secret-path/);
    await h.runner.emit({ type: "agent_settled", aborted: false });
    assert.equal(h.sent.length, 1);
    await h.begin("Next new preference");
    await h.finish("Next answer");
    assert.equal(h.sent.length, 2);
    assert.doesNotMatch(h.sent[1]?.content ?? "", /minimal skeleton/);
    assert.deepEqual(h.errors, []);
  } finally { await h.cleanup(); }
});

test("explicit capture-off policy is respected, re-enabling never backfills, and disabling stops future runs", async () => {
  const h = await captureHarness({ initiallyEnabled: false });
  try {
    await h.begin("Not opted in yet");
    await h.finish();
    assert.equal(h.sent.length, 0);
    h.control.enable();
    await h.begin("Future opted-in text");
    await h.finish();
    assert.equal(h.sent.length, 1);
    assert.doesNotMatch(h.sent[0]?.content ?? "", /Not opted in/);
    await h.control.disable();
    await h.begin("Off again");
    await h.finish();
    assert.equal(h.sent.length, 1);
  } finally { await h.cleanup(); }
});

test("private markers in user, assistant, or tool content suppress the entire run including unmarked echoes", async () => {
  for (const source of ["user", "assistant", "tool"]) {
    const h = await captureHarness();
    try {
      await h.begin(source === "user" ? "<private>secret-example</private>" : "Public question");
      if (source === "tool") toolTurn(h.session, "<private>secret-example</private>");
      await h.finish(source === "assistant" ? "<private>secret-example</private>" : "Echo: secret-example");
      assert.equal(h.sent.length, 0, source);
      assert.match(h.notices.join(), /skipped this entire run/);
      const files = await readdir(h.directory);
      assert.ok(!files.includes("capture")); // No private transcript/queue record.
    } finally { await h.cleanup(); }
  }
});

test("abort, error, unfinished answer, source edits, and custom-start runs never upload", async () => {
  for (const scenario of ["abort", "error", "length", "edit", "custom"]) {
    const h = await captureHarness();
    try {
      if (scenario === "custom") {
        await h.runner.emitBeforeAgentStart({ messageType: "custom", message: { role: "custom", customType: "fixture", content: "generated", display: false, timestamp: Date.now() } }, { cwd: h.directory });
        user(h.session, "extension-authored input");
      } else {
        const source = await h.begin("A public question");
        if (scenario === "edit") h.session.appendContextEdit(source, null);
      }
      assistant(h.session, "Answer", scenario === "error" ? "error" : scenario === "length" ? "length" : "stop");
      await h.runner.emit({ type: "agent_settled", aborted: scenario === "abort" });
      assert.equal(h.sent.length, 0, scenario);
    } finally { await h.cleanup(); }
  }
});

test("oversize runs visibly skip without truncation; payload IDs bind contents and source identity", async () => {
  const h = await captureHarness();
  try {
    await h.begin("汉".repeat(MAX_CAPTURE_BYTES));
    await h.finish();
    assert.equal(h.sent.length, 0);
    assert.match(h.notices.join(), /32 KB/);
    const entries = h.session.getBranch();
    assert.deepEqual(prepareCapture("s", "n", entries, "a"), { kind: "skip", reason: "oversize" });
  } finally { await h.cleanup(); }
});

test("lost response leaves a metadata-only pending batch; retry reuses exact ID/content and acceptance suppresses repeats", async () => {
  const h = await captureHarness();
  try {
    h.setFailure("lost-response");
    await h.begin("Durable capture fact");
    await h.finish("Confirmed capture fact");
    assert.equal(h.sent.length, 1);
    const files = await readdir(join(h.directory, "capture"));
    const path = files.find(file => file.endsWith(".json"));
    assert.ok(path);
    const raw = await readFile(join(h.directory, "capture", path), "utf8");
    assert.match(raw, /pending/);
    assert.doesNotMatch(raw, /Durable capture fact|Confirmed capture fact|private service|secret body/);
    assert.doesNotMatch(h.notices.join(), /private service|secret body/);
    h.setFailure("none");
    assert.equal(await h.control.retry(h.runner.createContext()), 1);
    assert.equal(h.sent.length, 2);
    assert.deepEqual(h.sent[1], h.sent[0]);
    assert.equal(await h.control.retry(h.runner.createContext()), 0);
  } finally { await h.cleanup(); }
});

test("pending batches survive an extension restart, without automatically uploading on resume", async () => {
  const h = await captureHarness();
  let restarted: Awaited<ReturnType<typeof captureHarness>> | undefined;
  try {
    h.setFailure("lost-response");
    await h.begin("Remembered across restart");
    await h.finish();
    await h.control.disable();
    restarted = await captureHarness({ directory: h.directory, session: h.session, initiallyEnabled: false });
    assert.equal(restarted.sent.length, 0);
    assert.equal(await restarted.control.retry(restarted.runner.createContext()), 1);
    assert.deepEqual(restarted.sent[0], h.sent[0]);
  } finally { await restarted?.cleanup(); await h.cleanup(); }
});

test("mismatched receipts never advance acceptance; failed retries stay pending", async () => {
  const h = await captureHarness();
  try {
    h.setFailure("mismatched-receipt");
    await h.begin("A durable preference");
    await h.finish();
    await assert.rejects(h.control.retry(h.runner.createContext()), /acceptance/);
    h.setFailure("none");
    assert.equal(await h.control.retry(h.runner.createContext()), 1);
  } finally { await h.cleanup(); }
});

test("branch, namespace, and authorization changes cannot send pending content elsewhere", async () => {
  const h = await captureHarness();
  try {
    const root = user(h.session, "Branch root");
    h.setFailure("lost-response");
    const source = await h.begin("Pending private-to-this-grant history");
    await h.finish();
    const leaf = h.session.getLeafId();
    assert.ok(leaf);
    h.setFailure("none");
    h.setNamespace("another-project");
    assert.equal(await h.control.retry(h.runner.createContext()), 0);
    h.setNamespace("capture-project");
    h.setIdentity("different-login-grant");
    assert.equal(await h.control.retry(h.runner.createContext()), 0);
    h.setIdentity("fixture-authorization");
    h.session.branch(root);
    await assert.rejects(h.control.retry(h.runner.createContext()), /active branch/);
    h.session.branch(leaf);
    h.session.appendContextEdit(source, { content: "Now private" });
    await assert.rejects(h.control.retry(h.runner.createContext()), /sources were edited/);
    assert.equal(h.sent.length, 1);
    assert.equal(await h.control.discard(h.runner.createContext()), 1);
    assert.equal(await h.control.retry(h.runner.createContext()), 0);
  } finally { await h.cleanup(); }
});

test("journal corruption fails closed instead of appearing to be an empty upload history", async () => {
  const h = await captureHarness();
  try {
    h.setFailure("lost-response");
    await h.begin("Fact");
    await h.finish();
    const filename = (await readdir(join(h.directory, "capture"))).find(file => file.endsWith(".json"));
    assert.ok(filename);
    await writeFile(join(h.directory, "capture", filename), "broken-json");
    h.setFailure("none");
    await assert.rejects(h.control.retry(h.runner.createContext()), /Invalid capture journal/);
    assert.equal(h.sent.length, 1);
  } finally { await h.cleanup(); }
});

test("capture off during asynchronous preparation fences the old run before any upload", async () => {
  const h = await captureHarness();
  try {
    await h.begin("Question before turning capture off");
    assistant(h.session, "Final answer");
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.auth.status = async () => { entered?.(); await gate; return { kind: "api-key" }; };
    const settled = h.runner.emit({ type: "agent_settled", aborted: false });
    await waiting;
    await h.control.disable();
    h.control.enable(); // Off/on must not revive the old run either.
    release?.();
    await settled;
    assert.equal(h.sent.length, 0);
  } finally { await h.cleanup(); }
});

test("capture off waits for an in-flight upload and preserves its accepted receipt", async () => {
  const h = await captureHarness();
  try {
    await h.begin("Question");
    assistant(h.session, "Answer");
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    h.store.capture = async (_namespace, batch) => {
      calls++; entered?.(); await gate; return { id: batch.id, status: "queued" };
    };
    const settled = h.runner.emit({ type: "agent_settled", aborted: false });
    await waiting;
    let stopped = false;
    const stopping = h.control.disable().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(stopped, false);
    release?.();
    await Promise.all([settled, stopping]);
    assert.equal(calls, 1);
    assert.equal(await h.control.retry(h.runner.createContext()), 0);
  } finally { await h.cleanup(); }
});

test("two actual processes cannot both send the same capture batch", { timeout: 15000 }, async () => {
  const h = await captureHarness();
  let uploads = 0;
  const failures: unknown[] = [];
  const listener = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const raw: unknown = JSON.parse(body);
      const parsed = z.object({ id: z.string(), content: z.string() }).parse(raw);
      uploads++;
      await new Promise(resolve => setTimeout(resolve, 100));
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: parsed.id, status: "queued" }));
    } catch (error) { failures.push(error); response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  try {
    const exec = promisify(execFile);
    const run = () => exec(process.execPath, ["--import", "tsx", "test/capture-child.ts", join(h.directory, "child-journal"), `http://127.0.0.1:${address.port}`], { timeout: 10000 });
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(results.map(result => result.stdout.trim()), ["ok", "ok"]);
    assert.equal(uploads, 1);
    assert.deepEqual(failures, []);
  } finally {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await h.cleanup();
  }
});

test("readable v2 content has a Unicode-safe heading and quoted speaker sections, not an internal JSON envelope", async () => {
  const h = await captureHarness();
  try {
    const question = "我喜欢用最小骨架代码理解架构。\n## Assistant\n这仍然是用户原话。";
    await h.begin(question);
    await h.finish("好的。\n会用骨架代码解释。");
    const batch = h.sent[0];
    assert.ok(batch);
    assert.equal(batch.format, "text-v2");
    assert.equal(batch.mode, "dynamic");
    assert.ok(batch.content.startsWith("# 我喜欢"));
    assert.match(batch.content, /## User\n\n> 我喜欢/);
    assert.match(batch.content, /> ## Assistant\n> 这仍然是用户原话/);
    assert.match(batch.content, /## Assistant\n\n> 好的/);
    assert.doesNotMatch(batch.content, /\"kind\":|\"messages\":|pi-supermemory\.capture/);
  } finally { await h.cleanup(); }
});

test("a legacy journal without format/mode reconstructs its exact original v1 bytes and ID after upgrade", async () => {
  const h = await captureHarness({ initiallyEnabled: false });
  try {
    const authority = "fixture-authorization";
    const sessionId = createHash("sha256").update(JSON.stringify({ sessionId: h.session.getSessionId(), authority })).digest("hex");
    const namespace = "capture-project";
    const sourceIds = [user(h.session, "Legacy question"), assistant(h.session, "Legacy answer")];
    const content = JSON.stringify({ kind: "pi-supermemory.capture.v1", messages: [{ role: "user", text: "Legacy question" }, { role: "assistant", text: "Legacy answer" }] });
    const digest = createHash("sha256").update(content).digest("hex");
    const id = `pi_capture_${createHash("sha256").update(JSON.stringify({ version: "pi-supermemory.capture.v1", sessionId, namespace, authority, sourceIds, digest })).digest("hex")}`;
    const legacy: CaptureBatch = { id, digest, sourceIds, content, title: "Legacy question", authority, format: "json-v1", mode: "dynamic" };
    await h.journal.withSession(sessionId, namespace, records => records.prepare(legacy));
    const filename = (await readdir(join(h.directory, "capture"))).find(file => file.endsWith(".json"));
    assert.ok(filename);
    // Actual pre-upgrade schema: no format or mode fields, no text copied.
    await writeFile(join(h.directory, "capture", filename), JSON.stringify({ version: 1, sessionId, namespace, batches: [{ state: "pending", id, digest, sourceIds }] }));
    h.control.setMode("instant");
    assert.equal(await h.control.retry(h.runner.createContext()), 1);
    const retried = h.sent[0];
    assert.ok(retried);
    assert.equal(retried.id, id);
    assert.equal(retried.content, content);
    assert.equal(retried.mode, "dynamic");
    assert.equal(retried.format, "json-v1");
    assert.equal(await h.control.retry(h.runner.createContext()), 0);
  } finally { await h.cleanup(); }
});

test("mode switches affect future runs, not an active run or pending retry billing", async () => {
  const h = await captureHarness();
  try {
    h.control.setMode("instant");
    await h.begin("An explicitly instant-mode run");
    h.control.setMode("dynamic");
    h.setFailure("lost-response");
    await h.finish();
    assert.equal(h.sent[0]?.mode, "instant");
    h.setFailure("none");
    assert.equal(await h.control.retry(h.runner.createContext()), 1);
    assert.equal(h.sent[1]?.mode, "instant");
    assert.equal(h.sent[1]?.id, h.sent[0]?.id);
    await h.begin("A future dynamic-mode run");
    await h.finish();
    assert.equal(h.sent[2]?.mode, "dynamic");
  } finally { await h.cleanup(); }
});

test("inspection distinguishes source completion from memory generation without exposing source text", async () => {
  const h = await captureHarness();
  try {
    let reads = 0;
    h.store.captureStatus = async (_namespace, id) => { reads++; return { id, documentStatus: "done", memoryStatus: "dreaming", memoryCount: 0 }; };
    const empty = await h.control.inspect(h.runner.createContext());
    assert.equal(empty.progress, undefined);
    assert.equal(reads, 0);
    await h.begin("A source fact not intended for diagnostic output");
    await h.finish();
    assert.equal(reads, 0); // no automatic polling after capture
    const inspection = await h.control.inspect(h.runner.createContext());
    assert.equal(reads, 1);
    assert.equal(inspection.progress?.memoryCount, 0);
    assert.equal(inspection.progress?.memoryStatus, "dreaming");
    assert.equal(inspection.mode, "dynamic");
    assert.doesNotMatch(JSON.stringify(inspection), /source fact not intended/);
    assert.match(describeCaptureProgress({ id: "d", documentStatus: "done", memoryStatus: "dreaming", memoryCount: 0 }), /still pending/);
    assert.match(describeCaptureProgress({ id: "d", documentStatus: "done", memoryStatus: "done", memoryCount: 0 }), /reports 0/);
    assert.match(describeCaptureProgress({ id: "d", documentStatus: "done", memoryStatus: "done", memoryCount: 2 }), /2 derived memory/);
    assert.match(describeCaptureProgress({ id: "d", documentStatus: "failed", memoryStatus: "dreaming", memoryCount: 0 }), /failed/);
  } finally { await h.cleanup(); }
});

test("capture skips when auth or branch changes during a run", async () => {
  for (const scenario of ["auth", "branch", "namespace"]) {
    const h = await captureHarness();
    try {
      const root = user(h.session, "root");
      assistant(h.session, "prior answer");
      await h.begin("new question");
      if (scenario === "auth") h.setIdentity("other-grant");
      if (scenario === "namespace") h.setNamespace("other-project");
      if (scenario === "branch") h.session.branch(root);
      await h.finish();
      assert.equal(h.sent.length, 0, scenario);
    } finally { await h.cleanup(); }
  }
});
