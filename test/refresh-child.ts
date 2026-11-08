// Subprocess fixture: never outputs a token or reads the user's Pi directory.
import { z } from "zod";
import { CredentialStorage } from "../src/auth/storage.js";
import { OAuthAuthentication } from "../src/auth/oauth.js";

const args = z.tuple([z.string().min(1), z.string().url()]).parse(process.argv.slice(2));
const [directory, origin] = args;
const local = new URL(origin);
if (local.protocol !== "http:" || local.hostname !== "127.0.0.1") throw new Error("Fixture requires loopback.");
const transport: typeof fetch = (input, init) => {
  const remote = new URL(input instanceof Request ? input.url : input);
  return fetch(new URL(remote.pathname, local), init);
};
const auth = new OAuthAuthentication(new CredentialStorage(directory), transport, 0);
try {
  const token = await auth.getToken();
  if (token !== "access-2") throw new Error("Unexpected fixture token.");
  process.stdout.write("ok\n");
} finally { await auth.close(); }
