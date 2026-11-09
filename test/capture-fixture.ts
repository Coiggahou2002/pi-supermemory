import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { registerCapture, type CaptureControls } from "../src/capture/runtime.js";
import { FileCaptureJournal } from "../src/capture/journal.js";
import type { CaptureBatch } from "../src/capture/batch.js";
import type { MemoryStore } from "../src/memory.js";
import { fixtureAuthentication } from "./helpers.js";

export function user(session: SessionManager, text: string): string {
  return session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}
export function assistant(session: SessionManager, text: string, stopReason: "stop" | "error" | "aborted" | "length" = "stop"): string {
  return session.appendMessage({
    role: "assistant", content: [{ type: "thinking", thinking: "internal thinking must not be uploaded" }, { type: "text", text }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
}
export function toolTurn(session: SessionManager, text: string): void {
  session.appendMessage({
    role: "assistant", content: [{ type: "text", text: "intermediate tool narration" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "secret-path" } }],
    api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  session.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
}

export async function captureHarness(options: { initiallyEnabled?: boolean; directory?: string; session?: SessionManager } = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "pi-capture-"));
  const session = options.session ?? SessionManager.inMemory(directory);
  const sent: CaptureBatch[] = [];
  const notices: string[] = [];
  const statuses: string[] = [];
  const errors: string[] = [];
  const controls: CaptureControls[] = [];
  let namespace = "capture-project";
  let identity = "fixture-authorization";
  let fail: "none" | "lost-response" | "mismatched-receipt" = "none";
  const auth = fixtureAuthentication();
  auth.captureIdentity = async () => identity;
  const store: MemoryStore = {
    async search() { return []; },
    async remember() { return { id: "manual", status: "queued" }; },
    async captureStatus(_namespace, id) { return { id, documentStatus: "done", memoryStatus: "dreaming", memoryCount: 0 }; },
    async capture(_namespace, batch, signal) {
      signal?.throwIfAborted();
      sent.push(batch);
      if (fail === "lost-response") throw new Error("private service error and secret body");
      return { id: fail === "mismatched-receipt" ? "wrong-id" : batch.id, status: "queued" };
    },
  };
  const journal = new FileCaptureJournal(join(directory, "capture"));
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [pi => { controls.push(registerCapture(pi, {
      store, auth, journal, namespace: async () => namespace,
    }, options.initiallyEnabled ?? true)); }],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const models = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
  const runner = new ExtensionRunner(result.extensions, result.runtime, directory, session, new ModelRegistry(models));
  runner.onError(error => errors.push(error.error));
  runner.setUIContext({
    ...runner.getUIContext(), notify: message => { notices.push(message); }, setStatus: (_key, text) => { if (text) statuses.push(text); },
  }, "tui");
  const control = controls[0];
  assert.ok(control);
  return {
    directory, session, sent, notices, statuses, errors, control, runner, auth, journal, store,
    setFailure(value: typeof fail) { fail = value; },
    setNamespace(value: string) { namespace = value; },
    setIdentity(value: string) { identity = value; },
    async begin(text: string) {
      await runner.emitBeforeAgentStart({ messageType: "user", prompt: text, images: undefined }, { cwd: directory });
      return user(session, text); // Real Pi persists the user AFTER this hook.
    },
    async finish(text = "Confirmed project decision", aborted = false) {
      assistant(session, text);
      await runner.emit({ type: "agent_settled", aborted });
    },
    async cleanup() {
      await control.disable();
      await auth.close();
      if (!options.directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
