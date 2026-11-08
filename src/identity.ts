import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 2_000;

/** Local identity: worktrees share a Git common directory; independent clones do not. */
export async function resolveNamespace(cwd: string, override?: string): Promise<string> {
  if (override) return override;
  const canonicalCwd = await realpath(cwd);
  let identity = canonicalCwd;
  try {
    const result = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: canonicalCwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8_192,
    });
    identity = await realpath(result.stdout.trim());
  } catch (error) {
    // Only a non-repository is an expected fallback. Missing git, timeouts,
    // and permission errors must not silently change the write destination.
    if (!(error instanceof Error) || !("stderr" in error)
      || typeof error.stderr !== "string"
      || !error.stderr.includes("not a git repository")) {
      throw new Error("Cannot determine Supermemory project identity; set PI_SUPERMEMORY_NAMESPACE explicitly.");
    }
  }
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `pi_local_${hash}`;
}
