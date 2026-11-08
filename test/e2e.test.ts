import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerExtension } from "../src/extension.js";
import { createSupermemoryStore } from "../src/store.js";
import { RECALL_TYPE, SAVE_TOOL, SEARCH_TOOL } from "../src/memory.js";
import { OAuthFixture } from "./oauth-fixture.js";
import { CredentialStorage } from "../src/auth/storage.js";
import { OAuthAuthentication } from "../src/auth/oauth.js";
import { FileCaptureJournal } from "../src/capture/journal.js";

const requestSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() }).passthrough()) });

test("offline E2E: OAuth browser callback → real Pi session → model HTTP → memory tools → authenticated SDK → final reply", { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-e2e-"));
  const requests: z.infer<typeof requestSchema>[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const raw: unknown = JSON.parse(body);
      requests.push(requestSchema.parse(raw));
      const number = requests.length;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = number === 1
        ? { role: "assistant", tool_calls: [{ index: 0, id: "search-call", type: "function", function: { name: SEARCH_TOOL, arguments: JSON.stringify({ query: "past design decision" }) } }] }
        : number === 2
          ? { role: "assistant", tool_calls: [{ index: 0, id: "save-call", type: "function", function: { name: SAVE_TOOL, arguments: JSON.stringify({ text: "Prefer small typed functions" }) } }] }
          : { role: "assistant", content: "Done: recalled the design and submitted the requested fact." };
      const chunk = { id: `completion-${number}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] };
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: number <= 2 ? "tool_calls" : "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let searchCalls = 0;
  let saves = 0;
  let captures = 0;
  const oauthServer = new OAuthFixture();
  const transport: typeof fetch = async (input, init) => {
    if (!String(input).includes("/ns/")) return oauthServer.transport(input, init);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access-1");
    if (String(input).endsWith("/search")) {
      searchCalls++;
      return Response.json({ results: [{ id: "fact", memory: "Prefer minimal skeleton code", similarity: 0.9, isLatest: true }] });
    }
    assert.ok(String(input).endsWith("/document"));
    const raw: unknown = JSON.parse(String(init?.body));
    const capture = z.object({ id: z.string(), content: z.string(), supportingContext: z.string() }).safeParse(raw);
    if (capture.success) {
      captures++;
      assert.doesNotMatch(capture.data.content, /fixture-token|tool_call_id|supermemory_memory_policy|\"role\":\"system\"/);
      assert.match(capture.data.supportingContext, /durable user-stated/);
      return Response.json({ id: capture.data.id, status: "queued" });
    }
    assert.match(String(init?.body), /Prefer small typed functions/);
    saves++;
    return Response.json({ id: "doc", status: "queued" });
  };
  const auth = new OAuthAuthentication(new CredentialStorage(join(directory, "supermemory")), transport, 0);
  await auth.login({ openBrowser: async url => { assert.equal((await fetch(oauthServer.callback(url))).status, 200); } });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    systemPrompt: "You are a fixture assistant.",
    extensionFactories: [pi => registerExtension(pi, {
      config: { apiKey: undefined, namespace: "fixture-project", autoRecall: true, autoCapture: true, allowWrites: true },
      namespace: async () => "fixture-project", store: createSupermemoryStore(expectedIdentity => auth.getToken(expectedIdentity), transport),
      auth,
      captureJournal: new FileCaptureJournal(join(directory, "capture")),
    })],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models.json"), refreshOnCreate: false });
  runtime.registerProvider("fixture", {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-key", api: "openai-completions",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
  });
  const model = runtime.getModel("fixture", "fixture");
  assert.ok(model);
  const manager = SessionManager.inMemory(directory);
  const { session } = await createAgentSession({
    cwd: directory, agentDir: directory, modelRuntime: runtime, model, thinkingLevel: "off",
    resourceLoader: loader, settingsManager: settings, sessionManager: manager,
    tools: [SEARCH_TOOL, SAVE_TOOL],
  });
  try {
    await session.bindExtensions({});
    await session.prompt("Recall the earlier design and remember that I prefer small typed functions.");
    assert.deepEqual(failures, []);
    assert.equal(requests.length, 3);
    assert.equal(searchCalls, 2); // automatic recall plus proactive tool
    assert.equal(saves, 1);
    assert.equal(captures, 1);
    assert.match(session.getLastAssistantText() ?? "", /Done:/);
    const first = requests[0];
    const second = requests[1];
    assert.ok(first && second);
    assert.match(JSON.stringify(first.messages), /Prefer minimal skeleton code/);
    assert.match(JSON.stringify(first.messages), /Supermemory is the default persistent memory backend/);
    assert.match(JSON.stringify(first.messages), /Do not silently fall back to local files/);
    assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
    assert.equal(manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === RECALL_TYPE).length, 1);
    await session.prompt("What was the design decision from our earlier discussion?");
    assert.equal(requests.length, 4);
    assert.equal(manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === RECALL_TYPE).length, 1);
    await session.prompt("/supermemory status");
    await session.prompt("/supermemory logout");
    assert.equal(requests.length, 4); // slash commands do not call the model
    assert.equal(captures, 2); // each complete run, not every model/tool turn
    assert.equal(oauthServer.revocations, 1);
    assert.equal((await auth.status()).kind, "signed-out");
  } finally {
    session.dispose();
    await auth.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
