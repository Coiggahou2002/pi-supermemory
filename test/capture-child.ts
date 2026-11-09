// Subprocess fixture; no real credentials or user session paths are used.
import { createHash } from "node:crypto";
import { z } from "zod";
import { FileCaptureJournal } from "../src/capture/journal.js";
import { createSupermemoryStore } from "../src/store.js";
import type { CaptureBatch } from "../src/capture/types.js";

const [directory, origin] = z.tuple([z.string().min(1), z.string().url()]).parse(process.argv.slice(2));
const local = new URL(origin);
if (local.protocol !== "http:" || local.hostname !== "127.0.0.1") throw new Error("Fixture requires loopback.");
const transport: typeof fetch = (input, init) => {
  const remote = new URL(input instanceof Request ? input.url : input);
  return fetch(new URL(remote.pathname, local), init);
};
const content = "Synthetic capture journal contention test; not a real user fact.";
const digest = createHash("sha256").update(content).digest("hex");
const batch: CaptureBatch = { id: `pi_capture_${digest}`, digest, sourceIds: ["entry-1", "entry-2"], content, authority: "fixture", title: "Capture journal fixture", format: "text-v2", mode: "dynamic" };
const journal = new FileCaptureJournal(directory);
const store = createSupermemoryStore("fixture-token", transport);
await journal.withSession("fixture-session", "fixture-project", async records => {
  if (await records.prepare(batch) === "accepted") return;
  const receipt = await store.capture("fixture-project", batch);
  await records.accept(batch.id, receipt);
});
process.stdout.write("ok\n");
