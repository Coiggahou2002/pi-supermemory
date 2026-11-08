import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { containsPrivateMarker } from "../memory.js";

export const MAX_CAPTURE_BYTES = 32_000;
export const MAX_CAPTURE_SOURCE_ENTRIES = 1_000;
export const CAPTURE_VERSION = "pi-supermemory.capture.v1";
export interface CaptureBatch {
  id: string;
  digest: string;
  sourceIds: string[];
  content: string;
  authority: string;
}
export type CaptureSelection =
  | { kind: "batch"; batch: CaptureBatch }
  | { kind: "skip"; reason: "empty" | "private" | "incomplete" | "oversize" };

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Inspect all new raw messages for privacy, but serialize ONLY user text and
 * completed assistant text. Never serialize an AgentMessage wholesale. */
export function prepareCapture(sessionId: string, namespace: string, entries: readonly SessionEntry[], authority: string): CaptureSelection {
  const sources = entries.filter(entry => entry.type === "message"
    && ["user", "assistant", "toolResult"].includes(entry.message.role));
  if (sources.length > MAX_CAPTURE_SOURCE_ENTRIES) return { kind: "skip", reason: "oversize" };
  const sourceIdsInRun = new Set(sources.map(entry => entry.id));
  if (entries.some(entry => entry.type === "context_edit" && sourceIdsInRun.has(entry.targetId))) return { kind: "skip", reason: "incomplete" };
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  let lastAssistantComplete = false;
  let sawUser = false;
  for (const entry of sources) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
    // JSON is inspected for markers only; thinking, tools and arguments never
    // enter the serialized capture payload. Whole-run suppression prevents the
    // assistant's unmarked echo of a marked user/tool secret being uploaded.
    if (containsPrivateMarker(JSON.stringify(message.content))) return { kind: "skip", reason: "private" };
    const text = (typeof message.content === "string" ? message.content
      : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")).trim();
    if (message.role === "user") {
      sawUser = true;
      lastAssistantComplete = false;
      if (text) messages.push({ role: "user", text });
    } else if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") return { kind: "skip", reason: "incomplete" };
      lastAssistantComplete = message.stopReason === "stop" && !message.content.some(block => block.type === "toolCall");
      if (sawUser && lastAssistantComplete && text) messages.push({ role: "assistant", text });
    }
  }
  if (!sawUser || messages.length === 0) return { kind: "skip", reason: "empty" };
  if (!lastAssistantComplete || !messages.some(message => message.role === "assistant")) return { kind: "skip", reason: "incomplete" };
  const content = JSON.stringify({ kind: CAPTURE_VERSION, messages });
  if (Buffer.byteLength(content, "utf8") > MAX_CAPTURE_BYTES) return { kind: "skip", reason: "oversize" };
  const sourceIds = sources.map(entry => entry.id);
  const digest = sha256(content);
  const id = `pi_capture_${sha256(JSON.stringify({ version: CAPTURE_VERSION, sessionId, namespace, authority, sourceIds, digest }))}`;
  return { kind: "batch", batch: { id, digest, sourceIds, content, authority } };
}

/** A run boundary is the leaf BEFORE Pi appends its new user message. If tree
 * navigation abandoned that leaf, fail closed rather than uploading history. */
export function entriesAfter(branch: readonly SessionEntry[], previousLeafId: string | null): SessionEntry[] | undefined {
  if (previousLeafId === null) return [...branch];
  const index = branch.findIndex(entry => entry.id === previousLeafId);
  return index < 0 ? undefined : branch.slice(index + 1);
}
