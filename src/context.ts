import type { SessionProjection } from "@earendil-works/pi-coding-agent";
import { memoryKey, parseMemories, RECALL_TYPE, SEARCH_TOOL } from "./memory.js";

/** Inspect the model-visible projection, not historical metadata or a global
 * seen set. Compaction, branch navigation, reload, and context edits are
 * accounted for by Pi before we inspect actual message content. */
export function presentMemoryKeys(projection: SessionProjection, namespace: string): Set<string> {
  const keys = new Set<string>();
  for (const message of projection.messages) {
    if (message.role === "custom" && message.customType === RECALL_TYPE) {
      const texts = typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap(block => block.type === "text" ? [block.text] : []);
      for (const text of texts) {
        for (const memory of parseMemories(text, namespace)) keys.add(memoryKey(memory.text));
      }
    }
    if (message.role === "toolResult" && message.toolName === SEARCH_TOOL && !message.isError) {
      for (const block of message.content) {
        if (block.type !== "text") continue;
        for (const memory of parseMemories(block.text, namespace)) keys.add(memoryKey(memory.text));
      }
    }
  }
  return keys;
}
