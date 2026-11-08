import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { FileCaptureJournal } from "./capture/journal.js";
import { createAuthentication } from "./auth/index.js";
import { loadConfig } from "./config.js";
import { registerExtension } from "./extension.js";
import { resolveNamespace } from "./identity.js";
import { createSupermemoryStore } from "./store.js";

export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  const agentDirectory = getAgentDir();
  const auth = createAuthentication(agentDirectory, config.apiKey);
  registerExtension(pi, {
    config,
    auth,
    namespace: resolveNamespace,
    store: createSupermemoryStore(expectedIdentity => auth.getToken(expectedIdentity)),
    captureJournal: new FileCaptureJournal(join(agentDirectory, "supermemory", "capture")),
  });
}
