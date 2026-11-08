import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { resolveNamespace } from "../src/identity.js";

const exec = promisify(execFile);

test("local projects are isolated; git worktrees and subdirectories share identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-identity-"));
  try {
    const repo = join(root, "repo");
    const other = join(root, "other");
    const worktree = join(root, "worktree");
    await mkdir(repo);
    await mkdir(other);
    await exec("git", ["init", "-q", repo]);
    await exec("git", ["-C", repo, "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "--allow-empty", "-qm", "initial"]);
    await exec("git", ["-C", repo, "worktree", "add", "--detach", worktree]);
    await mkdir(join(repo, "src"));
    await symlink(repo, join(root, "alias"));
    const namespace = await resolveNamespace(repo);
    assert.equal(await resolveNamespace(worktree), namespace);
    assert.equal(await resolveNamespace(join(repo, "src")), namespace);
    assert.equal(await resolveNamespace(join(root, "alias")), namespace);
    assert.notEqual(await resolveNamespace(other), namespace);
    assert.equal(await resolveNamespace(other, "explicit_shared_project"), "explicit_shared_project");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
