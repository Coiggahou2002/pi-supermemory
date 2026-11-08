import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { z } from "zod";

export const ISSUER = "https://api.supermemory.ai/api/auth";
export const RESOURCE = "https://mcp.supermemory.ai/mcp";
export const credentialSchema = z.object({
  version: z.literal(1),
  issuer: z.literal(ISSUER),
  resource: z.literal(RESOURCE),
  clientId: z.string().min(1).max(4096),
  redirectUri: z.string().url().refine(value => {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/callback"
      && Boolean(url.port) && !url.search && !url.hash && !url.username && !url.password;
  }),
  accessToken: z.string().min(1).max(32_768),
  refreshToken: z.string().min(1).max(32_768),
  expiresAt: z.number().finite().positive(),
});
export type Credentials = z.infer<typeof credentialSchema>;
const MAX_CREDENTIAL_BYTES = 100_000;
const LOCK_STALE_MS = 60_000;
const LOCK_UPDATE_MS = 5_000;

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class CredentialStorage {
  readonly path: string;
  constructor(readonly directory: string) {
    this.path = join(directory, "oauth.json");
  }

  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe Supermemory credential directory.");
    if (process.platform !== "win32") await chmod(this.directory, 0o700);
  }

  async read(): Promise<Credentials | undefined> {
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe Supermemory credential directory.");
      if (process.platform !== "win32" && (directory.mode & 0o077) !== 0) throw new Error("Supermemory credential directory must have mode 0700.");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    let file;
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw new Error("Cannot read Supermemory OAuth credentials.");
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) throw new Error("Invalid credential file.");
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Supermemory credentials must have mode 0600; fix permissions before continuing.");
      let input: unknown;
      try { input = JSON.parse(await file.readFile("utf8")); }
      catch { throw new Error("Invalid Supermemory credential JSON. Run /supermemory logout, then login again."); }
      const parsed = credentialSchema.safeParse(input);
      if (!parsed.success) throw new Error("Invalid Supermemory OAuth credentials. Run /supermemory logout, then login again.");
      return parsed.data;
    } finally { await file.close(); }
  }

  async write(credentials: Credentials): Promise<void> {
    await this.prepare();
    const parsed = credentialSchema.safeParse(credentials);
    if (!parsed.success) throw new Error("Refusing invalid Supermemory credentials.");
    const temporary = join(this.directory, `.oauth-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(parsed.data));
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, this.path);
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); }
        finally { await directory.close(); }
      }
    } finally { await rm(temporary, { force: true }); }
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }

  async withLock<T>(action: (assertOwned: () => void) => Promise<T>): Promise<T> {
    await this.prepare();
    let compromised = false;
    let release;
    try {
      release = await lockfile.lock(this.path, {
        realpath: false, stale: LOCK_STALE_MS, update: LOCK_UPDATE_MS,
        retries: { retries: 25, minTimeout: 100, maxTimeout: 100, factor: 1, randomize: false },
        onCompromised: () => { compromised = true; },
      });
    } catch {
      throw new Error("Supermemory credentials are busy or unavailable. Finish the other login/refresh, then retry.");
    }
    const assertOwned = () => {
      if (compromised) throw new Error("Supermemory credential lock was lost. Log in again before continuing.");
    };
    try {
      assertOwned();
      return await action(assertOwned);
    } finally {
      if (!compromised) await release();
    }
  }
}
