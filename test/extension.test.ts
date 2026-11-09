import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type Skill } from "@earendil-works/pi-coding-agent";
import { MEMORY_ROUTING_POLICY, registerExtension } from "../src/extension.js";
import { loadConfig } from "../src/config.js";
import { fixtureAuthentication } from "./helpers.js";
import { FileCaptureJournal } from "../src/capture/journal.js";
import { RECALL_TYPE, SAVE_TOOL, SEARCH_TOOL, type MemoryStore } from "../src/memory.js";

async function harness(autoRecall = true, allowWrites = false, configured = true, autoCapture = false) {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-extension-"));
  let searches = 0;
  let saves = 0;
  const store: MemoryStore = {
    async search() {
      searches++;
      return [{ id: "fact", text: "Prefer minimal skeleton code", similarity: 0.9 }];
    },
    async remember() {
      saves++;
      return { id: "doc", status: "queued" };
    },
    async capture(_namespace, batch) { return { id: batch.id, status: "queued" }; },
    async captureStatus(_namespace, id) { return { id, documentStatus: "done", memoryStatus: "dreaming", memoryCount: 0 }; },
  };
  const auth = fixtureAuthentication(configured ? "api-key" : "signed-out");
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => registerExtension(pi, {
      config: { apiKey: "fake", namespace: "test-project", autoRecall, autoCapture, captureMode: "dynamic", allowWrites },
      store: configured ? store : undefined,
      auth,
      captureJournal: new FileCaptureJournal(join(directory, "capture")),
      namespace: async () => "test-project",
    })],
  });
  await loader.reload();
  const extensions = loader.getExtensions();
  assert.deepEqual(extensions.errors, []);
  const session = SessionManager.inMemory(directory);
  const models = await ModelRuntime.create({
    authPath: join(directory, "auth.json"), modelsPath: null,
    modelsStorePath: join(directory, "models-store.json"), refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(extensions.extensions, extensions.runtime, directory, session, new ModelRegistry(models));
  const errors: string[] = [];
  runner.onError(error => errors.push(error.error));
  return {
    directory, session, runner, errors, store, auth,
    searches: () => searches, saves: () => saves,
    cleanup: () => rm(directory, { recursive: true, force: true }),
    async recall(prompt: string) {
      session.appendMessage({ role: "user", content: prompt, timestamp: Date.now() });
      return runner.emitBeforeAgentStart({ messageType: "user", prompt, images: undefined }, { cwd: directory });
    },
  };
}

test("default memory routing wins over the advertised local skill without editing skill files", async () => {
  const h = await harness(false);
  const localSkill: Skill = {
    name: "memory", description: "Always use ~/memory for remember requests",
    filePath: "/fixture/memory/SKILL.md", baseDir: "/fixture/memory", disableModelInvocation: false,
    sourceInfo: { path: "/fixture/memory/SKILL.md", source: "fixture", scope: "user", origin: "top-level" },
  };
  try {
    const run = () => h.runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "记住我喜欢最小骨架代码", images: undefined },
      { cwd: h.directory, skills: [localSkill] },
    );
    const first = await run();
    assert.equal(first.systemPromptOptions.sections.supermemory_memory_policy, MEMORY_ROUTING_POLICY);
    const advertised = first.systemPromptOptions.skills[0];
    assert.ok(advertised);
    assert.match(advertised.description, /only when.*explicitly/);
    assert.match(advertised.description, /memory_remember/);
    assert.equal(localSkill.description, "Always use ~/memory for remember requests");
    assert.equal(h.searches(), 0); // manual-only still routes remember requests
    assert.equal(h.saves(), 0); // routing is guidance, not an unapproved write
    const second = await run();
    assert.deepEqual(second.systemPromptOptions.sections, first.systemPromptOptions.sections);
  } finally { await h.cleanup(); }
  const unconfigured = await harness(false, false, false);
  try {
    const result = await unconfigured.runner.emitBeforeAgentStart(
      { messageType: "user", prompt: "记住这个", images: undefined },
      { cwd: unconfigured.directory, skills: [localSkill] },
    );
    assert.equal(result.systemPromptOptions.sections.supermemory_memory_policy, undefined);
    assert.equal(result.systemPromptOptions.skills[0]?.description, localSkill.description);
  } finally { await unconfigured.cleanup(); }
});

test("real Pi runner: inject once, preserve prefix, avoid repeats, allow recall after compaction", async () => {
  const h = await harness();
  try {
    const first = await h.recall("之前怎么设计的？");
    assert.equal(first.messages.length, 1);
    const injection = first.messages[0];
    assert.ok(injection);
    assert.equal(injection.customType, RECALL_TYPE);
    // No early seen marker: merely returning a proposal does not suppress retry.
    const again = await h.runner.emitBeforeAgentStart({ messageType: "user", prompt: "之前怎么设计的？", images: undefined }, { cwd: h.directory });
    assert.equal(again.messages.length, 1);
    h.session.appendCustomMessageEntry(injection.customType, injection.content, injection.display, injection.details);
    const prefix = h.session.buildSessionProjection().messages;
    const second = await h.recall("再解释一下之前的决定");
    assert.equal(second.messages.length, 0);
    assert.deepEqual(h.session.buildSessionProjection().messages.slice(0, prefix.length), prefix);
    const retained = h.session.getLeafId();
    h.session.appendCompaction("History summarized", retained, 1000);
    const third = await h.recall("上次怎么定的？");
    assert.equal(third.messages.length, 1);
    assert.deepEqual(h.errors, []);
  } finally { await h.cleanup(); }
});

test("automatic prompt sharing is opt-in and acknowledgements skip searches", async () => {
  const h = await harness(false);
  try {
    assert.equal((await h.recall("why did we choose this design?")).messages.length, 0);
    assert.equal(h.searches(), 0);
    const command = h.runner.getCommand("supermemory");
    assert.ok(command);
    await command.handler("on", h.runner.createCommandContext());
    assert.equal((await h.recall("继续吧")).messages.length, 0);
    assert.equal(h.searches(), 0);
    assert.equal((await h.recall("why did we choose this design?")).messages.length, 1);
  } finally { await h.cleanup(); }
});

test("real registered tools search; headless writes fail closed until explicitly enabled", async () => {
  const h = await harness();
  try {
    const search = h.runner.getToolDefinition(SEARCH_TOOL);
    const save = h.runner.getToolDefinition(SAVE_TOOL);
    assert.ok(search && save);
    const result = await search.execute("search-1", { query: "prior decisions" }, undefined, undefined, h.runner.createToolContext("search-1", undefined));
    assert.match(JSON.stringify(result.content), /Prefer minimal skeleton code/);
    await assert.rejects(save.execute("save-1", { text: "fact" }, undefined, undefined, h.runner.createToolContext("save-1", undefined)), /confirmation/);
    assert.equal(h.saves(), 0);
    await assert.rejects(search.execute("search-2", { query: "<private>secret</private>" }, undefined, undefined, h.runner.createToolContext("search-2", undefined)), /private/);
    assert.equal(h.searches(), 1);
  } finally { await h.cleanup(); }
  const enabled = await harness(false, true);
  try {
    const save = enabled.runner.getToolDefinition(SAVE_TOOL);
    assert.ok(save);
    const result = await save.execute("save-1", { text: "Use skeleton code" }, undefined, undefined, enabled.runner.createToolContext("save-1", undefined));
    assert.equal(enabled.saves(), 1);
    assert.match(JSON.stringify(result.content), /Submitted/);
  } finally { await enabled.cleanup(); }
});

test("interactive writes require consent and display the exact destination and fact", async () => {
  const h = await harness();
  try {
    let approved = false;
    const confirmations: string[] = [];
    h.runner.setUIContext({
      ...h.runner.getUIContext(),
      confirm: async (_title, message) => {
        confirmations.push(message);
        return approved;
      },
    }, "tui");
    const save = h.runner.getToolDefinition(SAVE_TOOL);
    assert.ok(save);
    const execute = () => save.execute("save", { text: "  Prefer skeleton code  " }, undefined, undefined, h.runner.createToolContext("save", undefined));
    await assert.rejects(execute(), /declined/);
    assert.equal(h.saves(), 0);
    approved = true;
    await execute();
    assert.equal(h.saves(), 1);
    assert.equal(confirmations[0], "Namespace: test-project\n\nPrefer skeleton code");
  } finally { await h.cleanup(); }
});

test("auto-recall errors are visible, sanitized, and do not emit a fake memory", async () => {
  const h = await harness();
  try {
    const notices: string[] = [];
    h.runner.setUIContext({ ...h.runner.getUIContext(), notify: message => { notices.push(message); } }, "tui");
    h.store.search = async () => { throw new Error("private query secret-key"); };
    const result = await h.recall("Recall the earlier decision");
    assert.equal(result.messages.length, 0);
    assert.equal(notices.length, 1);
    assert.match(notices.join(), /unavailable/);
    assert.doesNotMatch(notices.join(), /private query|secret-key/);
    assert.deepEqual(h.errors, []);
  } finally { await h.cleanup(); }
});

test("OAuth commands connect in place and logout makes tools require login instead of local fallback", async () => {
  const h = await harness(false);
  try {
    await h.auth.logout();
    const notices: string[] = [];
    h.runner.setUIContext({ ...h.runner.getUIContext(), notify: message => { notices.push(message); } }, "tui");
    const command = h.runner.getCommand("supermemory");
    assert.ok(command);
    const context = h.runner.createCommandContext();
    context.waitForIdle = async () => {};
    await command.handler("login", context);
    assert.equal((await h.auth.status()).kind, "oauth");
    assert.match(notices.join(), /OAuth connected/);
    await command.handler("logout", context);
    assert.equal((await h.auth.status()).kind, "signed-out");
    const save = h.runner.getToolDefinition(SAVE_TOOL);
    assert.ok(save);
    await assert.rejects(save.execute("save", { text: "Remember a fact" }, undefined, undefined, h.runner.createToolContext("save", undefined)), /supermemory login/);
    assert.equal(h.saves(), 0);
    const run = await h.recall("记住我喜欢骨架代码");
    assert.match(run.systemPromptOptions.sections.supermemory_memory_policy ?? "", /do not silently switch to local files/);
    assert.equal(h.searches(), 0);
  } finally { await h.cleanup(); }
});

test("an explicit capture-off policy requires confirmation to re-enable; recall/manual writes do not override it", async () => {
  const h = await harness(false, true);
  try {
    const command = h.runner.getCommand("supermemory");
    assert.ok(command);
    const context = h.runner.createCommandContext();
    context.waitForIdle = async () => {};
    await assert.rejects(command.handler("capture on", context), /confirmation/);
    let approved = false;
    const confirmations: string[] = [];
    const notices: string[] = [];
    h.runner.setUIContext({
      ...h.runner.getUIContext(), notify: message => { notices.push(message); },
      confirm: async (_title, message) => { confirmations.push(message); return approved; },
    }, "tui");
    await command.handler("on", h.runner.createCommandContext());
    assert.match(notices.join(), /automatic capture=off/);
    const interactive = h.runner.createCommandContext();
    interactive.waitForIdle = async () => {};
    await command.handler("capture on", interactive);
    await command.handler("status", interactive);
    assert.match(notices.at(-1) ?? "", /automatic capture=off/);
    approved = true;
    await command.handler("capture on", interactive);
    assert.match(notices.at(-1) ?? "", /automatic capture=on/);
    assert.match(confirmations.join(), /Future user text and completed assistant answer text/);
    assert.match(confirmations.join(), /charges/);
    await command.handler("capture off", interactive);
    assert.match(notices.at(-1) ?? "", /automatic capture=off/);
  } finally { await h.cleanup(); }
});

test("instant mode requires a separate extra-cost confirmation and dynamic remains the default", async () => {
  const h = await harness(false, false, true, true);
  try {
    const command = h.runner.getCommand("supermemory");
    assert.ok(command);
    const headless = h.runner.createCommandContext();
    headless.waitForIdle = async () => {};
    await assert.rejects(command.handler("capture mode instant", headless), /one extra operation/);
    let approved = false;
    const confirmations: string[] = [];
    const notices: string[] = [];
    h.runner.setUIContext({
      ...h.runner.getUIContext(), notify: message => { notices.push(message); },
      confirm: async (_title, message) => { confirmations.push(message); return approved; },
    }, "tui");
    const ctx = h.runner.createCommandContext(); ctx.waitForIdle = async () => {};
    await command.handler("capture mode instant", ctx);
    await command.handler("status", ctx);
    assert.match(notices.at(-1) ?? "", /capture mode=dynamic/);
    approved = true;
    await command.handler("capture mode instant", ctx);
    assert.match(notices.at(-1) ?? "", /capture mode=instant/);
    assert.match(confirmations.join(), /ONE EXTRA OPERATION/);
    assert.match(confirmations.join(), /pending retries retain their original mode/);
    await command.handler("capture mode dynamic", ctx);
    assert.match(notices.at(-1) ?? "", /capture mode=dynamic/);
    assert.equal(confirmations.length, 2);
  } finally { await h.cleanup(); }
});

test("capture diagnostics remain the final visible notification instead of being replaced by generic status", async () => {
  const h = await harness();
  try {
    const notices: string[] = [];
    h.runner.setUIContext({ ...h.runner.getUIContext(), notify: message => { notices.push(message); } }, "tui");
    const command = h.runner.getCommand("supermemory"); assert.ok(command);
    const ctx = h.runner.createCommandContext(); ctx.waitForIdle = async () => {};
    await command.handler("capture status", ctx);
    assert.equal(notices.length, 1);
    assert.match(notices.at(-1) ?? "", /No accepted captures/);
  } finally { await h.cleanup(); }
});

test("default-on capture gives a prominent startup disclosure before any user message", async () => {
  const h = await harness(false, false, true, loadConfig({}).autoCapture);
  const notices: string[] = [];
  try {
    h.runner.setUIContext({ ...h.runner.getUIContext(), notify: message => { notices.push(message); } }, "tui");
    await h.runner.emit({ type: "session_start", reason: "startup" });
    assert.match(notices.join(), /Automatic memory capture is ON/);
    assert.match(notices.join(), /new user text and final answers will be sent/);
    assert.match(notices.join(), /charges may apply/);
    assert.match(notices.join(), /capture off/);
    assert.match(notices.join(), /PI_SUPERMEMORY_AUTO_CAPTURE=false/);
    assert.equal(h.session.getBranch().length, 0);
  } finally { await h.cleanup(); }
  const disabled = await harness(false, false, true, loadConfig({ PI_SUPERMEMORY_AUTO_CAPTURE: "false" }).autoCapture);
  try {
    const disabledNotices: string[] = [];
    disabled.runner.setUIContext({ ...disabled.runner.getUIContext(), notify: message => { disabledNotices.push(message); } }, "tui");
    await disabled.runner.emit({ type: "session_start", reason: "startup" });
    assert.equal(disabledNotices.length, 0);
  } finally { await disabled.cleanup(); }
});

test("actual package entry loads through Pi's TypeScript loader with isolated configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-load-"));
  try {
    // No session is started, so this does not access memory or call a model.
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("src/index.ts")],
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.ok(extension);
    assert.deepEqual([...extension.tools.keys()].sort(), [SAVE_TOOL, SEARCH_TOOL].sort());
    assert.equal(loadConfig({}).autoRecall, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
