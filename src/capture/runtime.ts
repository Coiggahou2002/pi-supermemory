import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { Authentication } from "../auth/index.js";
import { containsPrivateMarker, type MemoryStore } from "../memory.js";
import { entriesAfter, prepareCapture, type CaptureBatch } from "./batch.js";
import type { CaptureJournal, PendingCapture } from "./journal.js";

const MAX_RETRY_BATCHES = 5;
interface CaptureDependencies {
  store: MemoryStore | undefined;
  auth: Authentication;
  journal: CaptureJournal;
  namespace: (cwd: string) => Promise<string>;
}
interface RunWindow {
  sessionId: string;
  namespace: string;
  journalId: string;
  authority: string;
  previousLeafId: string | null;
  privatePrompt: boolean;
  generation: number;
}
export interface CaptureControls {
  enabled(): boolean;
  enable(): void;
  disable(): Promise<void>;
  retry(ctx: ExtensionContext): Promise<number>;
  discard(ctx: ExtensionContext): Promise<number>;
}

function notify(ctx: ExtensionContext, message: string, kind: "info" | "warning" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, kind);
  else console.error(message);
}

function reconstruct(pending: PendingCapture, branch: readonly SessionEntry[], sessionId: string, namespace: string, authority: string): CaptureBatch {
  const byId = new Map(branch.map(entry => [entry.id, entry]));
  const entries = pending.sourceIds.map(id => {
    const entry = byId.get(id);
    if (!entry) throw new Error("Pending capture is not on the active branch; nothing was retried.");
    return entry;
  });
  // Honor later privacy/context edits by refusing replay of any changed source.
  const edited = branch.some(entry => entry.type === "context_edit" && pending.sourceIds.includes(entry.targetId));
  if (edited) throw new Error("Pending capture sources were edited; nothing was retried. Use capture discard to forget pending retry metadata.");
  const result = prepareCapture(sessionId, namespace, entries, authority);
  if (result.kind !== "batch" || result.batch.id !== pending.id || result.batch.digest !== pending.digest) {
    throw new Error("Pending capture no longer matches safe source content; nothing was retried.");
  }
  return result.batch;
}

export function registerCapture(pi: ExtensionAPI, deps: CaptureDependencies, initiallyEnabled: boolean): CaptureControls {
  let enabled = initiallyEnabled;
  let generation = 0;
  let window: RunWindow | undefined;
  let active: Promise<unknown> | undefined;
  let cancellation: AbortController | undefined;

  async function tracked<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (active) throw new Error("A capture operation is already running.");
    cancellation = new AbortController();
    const work = action(cancellation.signal);
    active = work;
    try { return await work; }
    finally { active = undefined; cancellation = undefined; }
  }

  async function send(batch: CaptureBatch, run: RunWindow, signal: AbortSignal): Promise<boolean> {
    const store = deps.store;
    if (!store) throw new Error("Supermemory is not configured; run /supermemory login.");
    return deps.journal.withSession(run.journalId, run.namespace, async records => {
      signal.throwIfAborted();
      if (!enabled || run.generation !== generation) throw new Error("Capture was disabled before sending.");
      if (await records.prepare(batch) === "accepted") return false;
      signal.throwIfAborted();
      const receipt = await store.capture(run.namespace, batch, signal);
      // Persist an acceptance even if off was requested as the response arrived.
      // The network side effect has happened; don't intentionally lose its receipt.
      await records.accept(batch.id, receipt);
      return true;
    });
  }

  pi.on("before_agent_start", async (event, ctx) => {
    window = undefined;
    if (!enabled || event.messageType !== "user" || !deps.store) return;
    const runGeneration = generation;
    if ((await deps.auth.status()).kind === "signed-out") return;
    const sessionId = ctx.sessionManager.getSessionId();
    const authority = await deps.auth.captureIdentity();
    const namespace = await deps.namespace(ctx.cwd);
    if (!enabled || generation !== runGeneration) return;
    window = {
      sessionId,
      authority,
      journalId: createHash("sha256").update(JSON.stringify({ sessionId, authority })).digest("hex"),
      namespace,
      previousLeafId: ctx.sessionManager.getLeafId(),
      privatePrompt: containsPrivateMarker(event.prompt),
      generation: runGeneration,
    };
  });

  pi.on("agent_settled", async (event, ctx) => {
    const run = window;
    window = undefined; // Duplicate settled events cannot re-enqueue the same run.
    if (!enabled || !run || event.aborted || run.sessionId !== ctx.sessionManager.getSessionId()) return;
    if (run.privatePrompt) {
      notify(ctx, "Supermemory capture skipped this entire run because it contains a <private> marker.");
      return;
    }
    try {
      if ((await deps.auth.status()).kind === "signed-out") return;
      if (await deps.namespace(ctx.cwd) !== run.namespace || await deps.auth.captureIdentity() !== run.authority) throw new Error("Capture destination or authorization changed during the run.");
      if (!enabled || run.generation !== generation) return;
      const branch = ctx.sessionManager.getBranch();
      const entries = entriesAfter(branch, run.previousLeafId);
      if (!entries) throw new Error("Capture source branch changed during the run.");
      const result = prepareCapture(run.journalId, run.namespace, entries, run.authority);
      if (result.kind === "skip") {
        if (result.reason === "private") notify(ctx, "Supermemory capture skipped this entire run because it contains a <private> marker.");
        if (result.reason === "oversize") notify(ctx, "Supermemory capture skipped this run: text exceeds the 32 KB payload/source-entry limit. Nothing was truncated or uploaded.", "warning");
        return;
      }
      if (ctx.hasUI) ctx.ui.setStatus("supermemory-capture", "Capture: sending…");
      const sent = await tracked(signal => send(result.batch, run, signal));
      if (ctx.hasUI) ctx.ui.setStatus("supermemory-capture", sent ? "Capture: submitted (indexing may be pending)" : "Capture: already submitted");
    } catch {
      if (ctx.hasUI) ctx.ui.setStatus("supermemory-capture", "Capture: unconfirmed");
      notify(ctx, "Supermemory capture was not confirmed. Pending batches can be retried with /supermemory capture retry (current branch only). If preparation failed, no pending batch exists; check local storage and /supermemory status. No transcript was logged.", "warning");
    }
  });

  return {
    enabled: () => enabled,
    enable() { generation++; enabled = true; window = undefined; },
    async disable() {
      generation++;
      enabled = false;
      window = undefined;
      cancellation?.abort();
      if (active) {
        // The hook/command awaiting this work reports its failure; shutdown/off
        // must still wait for network/checkpoint work before auth is torn down.
        await active.catch(() => undefined);
      }
    },
    async retry(ctx) {
      const operationGeneration = generation;
      if (!deps.store) throw new Error("Supermemory is not configured.");
      if ((await deps.auth.status()).kind === "signed-out") throw new Error("Run /supermemory login before retrying capture.");
      const authority = await deps.auth.captureIdentity();
      const sessionId = createHash("sha256").update(JSON.stringify({ sessionId: ctx.sessionManager.getSessionId(), authority })).digest("hex");
      const namespace = await deps.namespace(ctx.cwd);
      if (operationGeneration !== generation) throw new Error("Capture retry was cancelled before sending.");
      return tracked(signal => deps.journal.withSession(sessionId, namespace, async records => {
        let sent = 0;
        const pending = records.pending();
        // Validate all source batches selected for this attempt before sending
        // any of them. Never find sources on abandoned branches via getEntries().
        const batches = pending.slice(0, MAX_RETRY_BATCHES).map(batch => reconstruct(batch, ctx.sessionManager.getBranch(), sessionId, namespace, authority));
        for (const batch of batches) {
          signal.throwIfAborted();
          const store = deps.store;
          if (!store) throw new Error("Supermemory is not configured.");
          const receipt = await store.capture(namespace, batch, signal);
          await records.accept(batch.id, receipt);
          sent++;
        }
        return sent;
      }));
    },
    async discard(ctx) {
      const authority = await deps.auth.captureIdentity();
      const sessionId = createHash("sha256").update(JSON.stringify({ sessionId: ctx.sessionManager.getSessionId(), authority })).digest("hex");
      return deps.journal.withSession(sessionId, await deps.namespace(ctx.cwd), records => records.discardPending());
    },
  };
}
