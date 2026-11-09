import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { hasCode } from "../auth/storage.js";
import { receiptSchema, type Receipt } from "../memory.js";
import { MAX_CAPTURE_SOURCE_ENTRIES, type CaptureBatch } from "./batch.js";
import { captureFormatSchema, captureModeSchema } from "./types.js";

const MAX_PENDING = 20;
const MAX_BATCHES = 10_000;
const MAX_JOURNAL_BYTES = 8_000_000;
const idSchema = z.string().regex(/^pi_capture_[a-f0-9]{64}$/);
const pendingSchema = z.object({
  state: z.literal("pending"), id: idSchema,
  format: captureFormatSchema.default("json-v1"), mode: captureModeSchema.default("dynamic"),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceIds: z.array(z.string().min(1).max(256)).min(1).max(MAX_CAPTURE_SOURCE_ENTRIES),
});
const acceptedSchema = z.object({
  state: z.literal("accepted"), id: idSchema, receipt: receiptSchema,
  format: captureFormatSchema.default("json-v1"), mode: captureModeSchema.default("dynamic"),
});
const recordSchema = z.discriminatedUnion("state", [pendingSchema, acceptedSchema]);
const journalSchema = z.object({
  version: z.literal(1), sessionId: z.string().min(1).max(256), namespace: z.string().min(1).max(128),
  batches: z.array(recordSchema).max(MAX_BATCHES),
});
export type PendingCapture = z.infer<typeof pendingSchema>;
export type AcceptedCapture = z.infer<typeof acceptedSchema>;
export interface CaptureRecords {
  pending(): PendingCapture[];
  latestAccepted(): AcceptedCapture | undefined;
  prepare(batch: CaptureBatch): Promise<"pending" | "accepted">;
  accept(id: string, receipt: Receipt): Promise<void>;
  discardPending(): Promise<number>;
}
export interface CaptureJournal {
  withSession<T>(sessionId: string, namespace: string, action: (records: CaptureRecords) => Promise<T>): Promise<T>;
}

/** Journal is metadata only. Text is reconstructed from explicitly identified
 * source entries for a user-requested retry; no second transcript is stored. */
export class FileCaptureJournal implements CaptureJournal {
  constructor(private readonly directory: string) {}

  async withSession<T>(sessionId: string, namespace: string, action: (records: CaptureRecords) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe capture journal directory.");
    if (process.platform !== "win32") await chmod(this.directory, 0o700);
    const key = createHash("sha256").update(JSON.stringify({ sessionId, namespace })).digest("hex");
    const path = join(this.directory, `${key}.json`);
    let compromised = false;
    const release = await lockfile.lock(path, {
      realpath: false, stale: 60_000, update: 5_000,
      retries: { retries: 25, minTimeout: 100, maxTimeout: 100, factor: 1, randomize: false },
      onCompromised: () => { compromised = true; },
    });
    const assertOwned = () => { if (compromised) throw new Error("Capture journal lock was lost."); };
    try {
      let state: z.infer<typeof journalSchema> = { version: 1, sessionId, namespace, batches: [] };
      let file;
      try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw new Error("Cannot open capture journal."); }
      if (file) {
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Unsafe capture journal file.");
          let raw: unknown;
          try { raw = JSON.parse(await file.readFile("utf8")); }
          catch { throw new Error("Invalid capture journal JSON; no data was sent."); }
          const parsed = journalSchema.safeParse(raw);
          if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.namespace !== namespace
            || new Set(parsed.data.batches.map(batch => batch.id)).size !== parsed.data.batches.length
            || parsed.data.batches.some(batch => (batch.state === "accepted" && batch.receipt.id !== batch.id) || (batch.format === "json-v1" && batch.mode !== "dynamic"))) {
            throw new Error("Invalid capture journal identity/state; no data was sent.");
          }
          state = parsed.data;
        } finally { await file.close(); }
      }
      const save = async () => {
        assertOwned();
        const serialized = JSON.stringify(state);
        if (Buffer.byteLength(serialized) > MAX_JOURNAL_BYTES) throw new Error("Capture journal is full.");
        const temporary = join(this.directory, `.capture-${randomUUID()}.tmp`);
        try {
          const file = await open(temporary, "wx", 0o600);
          try { await file.writeFile(serialized); await file.sync(); }
          finally { await file.close(); }
          assertOwned();
          await rename(temporary, path);
          if (process.platform !== "win32") {
            const parent = await open(this.directory, "r");
            try { await parent.sync(); }
            finally { await parent.close(); }
          }
        } finally { await rm(temporary, { force: true }); }
      };
      return await action({
        pending: () => {
          assertOwned();
          return state.batches.flatMap(batch => batch.state === "pending" ? [{ ...batch, sourceIds: [...batch.sourceIds] }] : []);
        },
        latestAccepted: () => {
          assertOwned();
          const latest = state.batches.findLast(batch => batch.state === "accepted");
          return latest?.state === "accepted" ? { ...latest, receipt: { ...latest.receipt } } : undefined;
        },
        prepare: async batch => {
          assertOwned();
          const existing = state.batches.find(record => record.id === batch.id);
          if (existing) {
            if (existing.state === "pending" && (existing.digest !== batch.digest || existing.format !== batch.format || existing.mode !== batch.mode || JSON.stringify(existing.sourceIds) !== JSON.stringify(batch.sourceIds))) throw new Error("Capture batch identity mismatch.");
            return existing.state;
          }
          if (state.batches.length >= MAX_BATCHES || state.batches.filter(batch => batch.state === "pending").length >= MAX_PENDING) throw new Error("Capture journal is full; retry or discard pending batches first.");
          const pending = pendingSchema.parse({ state: "pending", id: batch.id, digest: batch.digest, sourceIds: batch.sourceIds, format: batch.format, mode: batch.mode });
          state.batches.push(pending);
          await save();
          return "pending";
        },
        accept: async (id, receipt) => {
          assertOwned();
          const parsed = receiptSchema.safeParse(receipt);
          const index = state.batches.findIndex(batch => batch.id === id);
          const existing = state.batches[index];
          if (!parsed.success || parsed.data.id !== id || !existing) throw new Error("Capture acceptance does not match the pending document.");
          state.batches[index] = { state: "accepted", id, receipt: parsed.data, format: existing.format, mode: existing.mode };
          await save();
        },
        discardPending: async () => {
          assertOwned();
          const count = state.batches.filter(batch => batch.state === "pending").length;
          state.batches = state.batches.filter(batch => batch.state === "accepted");
          if (count > 0) await save();
          return count;
        },
      });
    } finally { if (!compromised) await release(); }
  }
}
