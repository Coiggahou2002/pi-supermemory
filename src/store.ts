import { Supermemory } from "supermemory";
import { z } from "zod";
import { MAX_QUERY_CHARS, MIN_SIMILARITY, type MemoryStore } from "./memory.js";

const REQUEST_TIMEOUT_SECONDS = 5;
const SEARCH_CANDIDATES = 20;
const searchResponseSchema = z.object({
  results: z.array(z.object({
    id: z.string().min(1),
    memory: z.string().optional(),
    chunk: z.string().optional(),
    similarity: z.number().finite().min(0).max(1),
    isLatest: z.boolean(),
  })),
});
const receiptSchema = z.object({
  id: z.string().trim().min(1),
  status: z.enum(["queued", "extracting", "chunking", "embedding", "indexing", "done"]),
});

/** Only this adapter knows the SDK contract. No retries on writes. */
export function createSupermemoryStore(credential: string | (() => Promise<string>), fetchImpl: typeof fetch = fetch): MemoryStore {
  const client = async () => new Supermemory({
    apiKey: typeof credential === "string" ? credential : await credential(),
    baseUrl: "https://api.supermemory.ai",
    fetch: fetchImpl,
    timeoutInSeconds: REQUEST_TIMEOUT_SECONDS,
    maxRetries: 0,
    headers: { "x-sm-source": "pi-supermemory" },
  });
  return {
    async search(namespace, query, signal) {
      // Resolve auth before entering the request boundary: an unauthenticated
      // operation did not reach the service and should tell the user to log in.
      const sdk = await client();
      signal?.throwIfAborted();
      try {
        const raw: unknown = await sdk.search(namespace, {
          query: query.trim().slice(0, MAX_QUERY_CHARS),
          searchMode: "memories",
          threshold: MIN_SIMILARITY,
          limit: SEARCH_CANDIDATES,
          rerank: "none",
          rewriteQuery: false,
        }, { abortSignal: signal });
        const parsed = searchResponseSchema.safeParse(raw);
        if (!parsed.success) throw new Error("Invalid response");
        return parsed.data.results
          .filter(hit => hit.isLatest)
          .flatMap(hit => {
            const text = (hit.memory ?? hit.chunk ?? "").trim();
            return text ? [{ id: hit.id, text, similarity: hit.similarity }] : [];
          });
      } catch {
        // SDK errors can contain request bodies/credentials. Never propagate
        // them into model context, notifications, or logs.
        if (signal?.aborted) throw new Error("Supermemory search cancelled.");
        throw new Error("Supermemory search failed. Check /supermemory status, network, and service access; if access was revoked, log out and log in again. No automatic retry was made.");
      }
    },
    async remember(namespace, text, signal) {
      const sdk = await client();
      signal?.throwIfAborted();
      try {
        const raw: unknown = await sdk.add(namespace, {
          content: text,
          taskType: "memory",
          dreaming: "dynamic",
          metadata: { source: "pi-supermemory", sm_scope: "personal" },
        }, { abortSignal: signal });
        const receipt = receiptSchema.safeParse(raw);
        if (!receipt.success) throw new Error("Invalid acceptance");
        return receipt.data;
      } catch {
        // A lost response may still mean the server accepted the write.
        throw new Error("Supermemory save was not confirmed. It may have been accepted; inspect the service before retrying.");
      }
    },
  };
}
