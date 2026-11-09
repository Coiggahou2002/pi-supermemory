import { Supermemory } from "supermemory";
import { z } from "zod";
import { MAX_QUERY_CHARS, MIN_SIMILARITY, receiptSchema, type MemoryStore } from "./memory.js";
import { documentStatusSchema } from "./capture/types.js";

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

const progressSchema = z.object({
  id: z.string().min(1).max(256),
  system: z.object({ status: documentStatusSchema, dreamingStatus: z.enum(["dreaming", "done"]) }),
  memories: z.array(z.unknown()),
});

/** Only this adapter knows the SDK contract. No retries on writes. */
export function createSupermemoryStore(credential: string | ((expectedCaptureIdentity?: string) => Promise<string>), fetchImpl: typeof fetch = fetch): MemoryStore {
  const client = async (expectedCaptureIdentity?: string) => new Supermemory({
    apiKey: typeof credential === "string" ? credential : await credential(expectedCaptureIdentity),
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
    async capture(namespace, batch, signal) {
      const sdk = await client(batch.authority);
      signal?.throwIfAborted();
      try {
        const raw: unknown = await sdk.add(namespace, {
          id: batch.id,
          content: batch.content,
          taskType: "memory",
          dreaming: batch.mode,
          // supportingContext mutates namespace-wide context/description. Do not
          // overwrite a user's namespace settings for each captured exchange.
          metadata: { source: "pi-supermemory", sm_scope: "personal", automatic_capture: true, capture_format: batch.format, title: batch.title },
        }, { abortSignal: signal });
        const receipt = receiptSchema.safeParse(raw);
        if (!receipt.success || receipt.data.id !== batch.id) throw new Error("Invalid capture acceptance.");
        return receipt.data;
      } catch {
        throw new Error("Automatic capture was not confirmed. Retry the same pending batch with /supermemory capture retry; it may already have reached the service.");
      }
    },
    async captureStatus(namespace, id, authority, signal) {
      const sdk = await client(authority);
      signal?.throwIfAborted();
      try {
        const raw: unknown = await sdk.documents.get(namespace, id, { include: "memories" }, { abortSignal: signal });
        const parsed = progressSchema.safeParse(raw);
        if (!parsed.success || parsed.data.id !== id) throw new Error("Invalid capture progress response.");
        return {
          id,
          documentStatus: parsed.data.system.status,
          memoryStatus: parsed.data.system.dreamingStatus,
          memoryCount: parsed.data.memories.length,
        };
      } catch {
        throw new Error("Could not inspect capture progress. The document may have been removed, access may have changed, or the service may be unavailable; no content was modified.");
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
