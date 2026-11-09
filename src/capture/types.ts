import { z } from "zod";

export const captureFormatSchema = z.enum(["json-v1", "text-v2"]);
export const captureModeSchema = z.enum(["dynamic", "instant"]);
export type CaptureFormat = z.infer<typeof captureFormatSchema>;
export type CaptureMode = z.infer<typeof captureModeSchema>;
export interface CaptureOptions { format: CaptureFormat; mode: CaptureMode }
export interface CaptureBatch extends CaptureOptions {
  id: string;
  digest: string;
  sourceIds: string[];
  content: string;
  title: string;
  authority: string;
}
export const documentStatusSchema = z.enum(["unknown", "queued", "extracting", "chunking", "embedding", "indexing", "done", "failed"]);
export interface CaptureProgress {
  id: string;
  documentStatus: z.infer<typeof documentStatusSchema>;
  memoryStatus: "dreaming" | "done";
  memoryCount: number;
}
export interface CaptureInspection {
  pending: number;
  mode: CaptureMode | undefined;
  progress: CaptureProgress | undefined;
}

export function describeCaptureProgress(progress: CaptureProgress, mode: CaptureMode = "dynamic"): string {
  if (progress.documentStatus === "failed") return "Source processing failed; memory extraction is not confirmed.";
  if (progress.documentStatus !== "done") return `Source processing: ${progress.documentStatus}; memory extraction is not yet confirmed.`;
  if (progress.memoryStatus === "dreaming") return `Source is searchable; memory generation is still pending (possibly queued or retrying). ${mode === "dynamic" ? "Dynamic mode can take several minutes." : "Instant mode is still asynchronous; completion is not yet confirmed."}`;
  return progress.memoryCount > 0
    ? `Memory generation finished: ${progress.memoryCount} derived memory item(s).`
    : "Memory generation finished; the service reports 0 derived memories for this document.";
}
