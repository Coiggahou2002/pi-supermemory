import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAuthentication } from "./auth/index.js";
import { loadConfig } from "./config.js";
import { registerExtension } from "./extension.js";
import { resolveNamespace } from "./identity.js";
import { createSupermemoryStore } from "./store.js";

export default function (pi: ExtensionAPI): void {
  const config = loadConfig();
  const auth = createAuthentication(getAgentDir(), config.apiKey);
  registerExtension(pi, {
    config,
    auth,
    namespace: resolveNamespace,
    store: createSupermemoryStore(() => auth.getToken()),
  });
}
