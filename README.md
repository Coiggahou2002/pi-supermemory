# pi-supermemory

A small **community** [Pi](https://pi.dev) extension for [Supermemory](https://supermemory.ai). Not affiliated with either project.

- Browser OAuth login once; future Pi sessions reuse and refresh the saved credentials. No copied API key required.
- `memory_search`: the agent searches saved project facts.
- `memory_remember`: the default destination for ordinary “remember this / 记住这个” requests, with confirmation by default. You do not need to name the tool.
- Optional automatic recall: append relevant, new facts once before a run, preserving the existing conversation prefix.
- Context-aware exact-text deduplication across automatic recall and proactive searches, using Pi's active session projection rather than a permanent “seen” list.
- **No automatic transcript capture. No background uploads. No MCP proxy.**

**Status:** early preview release, distributed through GitHub (not npm). Tested against Pi **1.5.0**, Node **22.23.2**, and the official **supermemory 5.1.2** SDK. Offline integration tests pass. Live OAuth discovery and public-client registration have been verified; browser consent, account-specific REST access, extraction, relevance, and billing still need live acceptance testing.

## Install once, then just use Pi

Requires [Pi](https://pi.dev) **1.5.0**, Node **22.19+**, Git, and a Supermemory account. Pi downloads the package and installs its runtime dependencies; you do not need to clone this repository first.

```bash
# One-time installation into Pi's personal package list.
pi install git:github.com/Coiggahou2002/pi-supermemory@v0.2.0

# Start Pi normally in your project.
pi
```

In Pi, connect your account once:

```text
/supermemory login
```

Your browser opens Supermemory's consent page. Review and approve access, then return to Pi. Future launches need only `pi` — no wrapper command, API-key export, or `-e` flag.

If you previously exported `SUPERMEMORY_API_KEY`, unset it in your shell and restart Pi before OAuth login. An explicit environment key takes precedence over OAuth. This extension does not change model credentials or other agents' credentials.

```text
/supermemory status
/supermemory logout
```

Remove the installed package with `pi remove git:github.com/Coiggahou2002/pi-supermemory@v0.2.0`; removing the package does not revoke the account grant, so log out first if desired. Version tags are pinned; install a newer release tag explicitly when upgrading.

If you previously installed a local checkout, remove that local package first and remove any extra `-e` flag to avoid loading two copies of the extension.

Try asking the agent:

```text
Remember that I prefer explanations with minimal skeleton code.
```

Approve the dialog after reviewing both the fact and destination. Then ask:

```text
What explanation style did I ask you to remember?
```

Writes return an acceptance receipt. **A queued write is not yet searchable**; extraction and indexing happen asynchronously. A miss immediately after a save is not proof of failure.

### Default destination and local memory skills

The extension adds a stable routing policy, including before sign-in (when it asks you to log in rather than falling back locally): ordinary durable-memory requests use Supermemory by default, whether automatic recall is on or off. The advertised description of a skill named `memory` is narrowed to explicitly requested local/Markdown storage for this run. No skill file or global configuration is edited. Explicit “save locally in ~/memory” requests can still use the local backend. Higher-priority host instructions and other extensions can still override prompt guidance; this is not a filesystem interceptor.

Failures must not silently fall back to local files, and a save should not be reported as successful without a tool receipt. Previously saved local notes are not migrated or deleted. Reload an already-running Pi session to receive the new policy; a fresh session also avoids old local-skill instructions lingering in history.

This default routing does **not** automatically extract and upload every conversation. It handles ordinary remember requests without special tool wording; write confirmation remains the privacy boundary.

### Automatic recall is opt-in

```text
/supermemory on
/supermemory off
```

Enabling automatic recall authorizes sending eligible **expanded prompt text** (up to 500 UTF-16 code units) to Supermemory for search. It does not enable automatic transcript capture. Toggles last only for the current extension instance and reset on `/reload` or session replacement. For a persistent startup preference:

```bash
export PI_SUPERMEMORY_AUTO_RECALL=true
```

Turning recall off stops future automatic searches, but does not remove previously injected messages or remote facts.

## Configuration

OAuth credentials are stored in this extension's own private directory under Pi's agent directory. Optional overrides come from process environment variables. This extension does **not** read other agents' credentials, `.env` files, or project configuration files.

| Variable | Default | Meaning |
|---|---|---|
| `SUPERMEMORY_API_KEY` | unset | Optional explicit override for CI/API-key users. When set, browser login/logout explains that you must unset it and restart before using OAuth. |
| `PI_SUPERMEMORY_NAMESPACE` | derived locally | Explicit namespace, 1–128 ASCII letters, digits, `_` or `-`. |
| `PI_SUPERMEMORY_AUTO_RECALL` | `false` | Enable automatic query sharing. Must be `true` or `false`. |
| `PI_SUPERMEMORY_ALLOW_WRITES` | `false` | Explicitly permit unattended writes; bypasses the confirmation dialog. Required for headless saves. |

Restart Pi after changing shell environment variables. `/reload` rereads the current Pi process environment, not a separate shell's environment.

The endpoint is deliberately fixed to `https://api.supermemory.ai`; this prototype has no custom-host, legacy-API, profile, or MCP proxy integration. Memory requests have a 5-second SDK timeout and zero SDK retries. A lost save response can mean the write was accepted; inspect the service before retrying.

### OAuth lifecycle and storage

- `/supermemory login` uses Authorization Code + PKCE S256, random state, and public-client registration through `openid-client`. It requests `openid profile email offline_access`, with the hosted MCP resource indicator used by the official coding-agent integrations. Tokens are used for direct REST SDK calls; no MCP connection is opened.
- Credentials are in `~/.pi/agent/supermemory/oauth.json`, or under `PI_CODING_AGENT_DIR` when configured. On POSIX the dedicated directory is mode **0700** and the file **0600**. Atomic writes are fsynced. **This file contains access and refresh tokens in plaintext**; filesystem permissions are not encryption. Do not commit, share, or sync it insecurely. Windows users must secure the directory with their account ACLs; POSIX modes do not provide that guarantee there.
- Browser login is explicit and interactive, never triggered by an ordinary memory operation. The callback binds to `127.0.0.1:19878`; login expires after 3 minutes. Run the browser and Pi on the same machine; remote/headless callback forwarding is not implemented. Environment API keys remain available for headless setups.
- Tokens refresh before expiry. File locking serializes login/refresh/logout across Pi processes; there is no independent per-process token cache. Shutdown waits for an in-flight refresh to persist rotated credentials. If the refresh response is lost or invalid, local login is cleared instead of retrying a potentially rotated token. Run login again. A discovery-only outage retains credentials.
- Logout attempts remote refresh-token revocation and removes local credentials even if the service is unreachable. A warning tells you when revocation was not confirmed; revoke access in Supermemory account settings in that case. Logout does not erase saved memories or existing session text, and in-flight requests/access tokens may remain usable until the server invalidates them or they expire.
- The production issuer and endpoint origins are pinned and redirects rejected. Supermemory currently returns HTTP 200 from public client registration; a narrow adapter normalizes only that response to RFC 7591's 201 for standard-library validation. No other response or authorization error is rewritten.

### Project identity

Default namespaces are `pi_local_<hash>` derived from the canonical absolute **Git common directory**. Subdirectories, symlinks, and linked worktrees share memory. Different clones, moved repositories, and different machines do not automatically share it. Outside Git, the canonical current directory is used, so sibling/nested directories have different identities.

For cross-machine or cross-client sharing, deliberately set the same `PI_SUPERMEMORY_NAMESPACE`. There is **no automatic compatibility claim** with Claude Code/Codex/OpenCode container names. Namespace selection scopes requests within your Supermemory account; it is not a replacement for service-side authorization.

## How it works

```ts
export default function (pi: ExtensionAPI) {
  const auth = createAuthentication(getAgentDir());
  const store = createSupermemoryStore(() => auth.getToken());

  registerRecall(pi, dependencies, isEnabled);
  registerTools(pi, dependencies);
  // registerCapture is intentionally not implemented yet.
}
```

This snippet illustrates composition; the real entry point also passes validated configuration and authentication into the registered commands. Creating the extension does not initiate login or network activity.

```text
before_agent_start
  → search current namespace
  → inspect buildSessionProjection()
  → select relevant facts absent from surviving memory envelopes
  → return one persistent custom message

memory_search / memory_remember
  → same MemoryStore adapter
  → official Supermemory SDK
```

Recall messages are appended to the conversation, not interpolated into a changing system-prompt section. Tool-loop requests extend that prefix instead of moving the memory block to the end on every request. This is cache-friendly structure, **not a guarantee of provider cache hits**.

### Selection policy

`src/memory.ts` owns the policy:

- Skip empty prompts, commands, a small explicit set of acknowledgements, and prompts containing `<private>` markers. There is no English-centric minimum length.
- Search the `memories` mode, discard non-latest facts, require similarity ≥ 0.55, then sort descending.
- Deduplicate normalized exact text, not IDs or semantic equivalence. Preserve case because code and paths can be case-sensitive.
- Return at most 5 facts, at most 1,000 Unicode code points per fact, with the **complete JSON envelope capped at 6,000 UTF-8 bytes**. This is a byte budget, not an exact token budget.
- Inspect the actual projected content of our recall messages and successful `memory_search` results. No sidecar “seen” cache is written.

After compaction, a fact absent from surviving envelopes can be recalled again. **A summary may still express the same fact in other words**; we do not claim semantic awareness of summaries or arbitrary assistant/user text. Other extensions can modify request context after this check; the projection is Pi's persisted view, not a guarantee about the final provider payload.

## Privacy and safety

- Manual search sends the query; manual save sends the confirmed fact. Auto recall additionally sends eligible expanded prompts. Returned facts are sent to your configured LLM provider and persisted in Pi's session file, even when the recall message is hidden in the UI.
- `<private>` markers block the entire search/save operation or skip automatic recall for that prompt. They are a convenience guard, **not secret detection or DLP**. Do not submit sensitive content.
- Save confirmation reviews the exact trimmed text and namespace. Headless saving fails closed unless unattended writes are explicitly enabled.
- Retrieved text is labeled historical data, not instructions. This is not a prompt-injection sandbox.
- No raw SDK error bodies, credentials, queries, or saved facts are logged by this extension. Pi itself still stores ordinary messages and tool calls in sessions.
- Automatic recall failure warns and allows the coding task to continue. Explicit tool failures are reported as errors. Nothing is silently treated as a successful save.
- Deletion/forget tools and remote cleanup are not implemented. Use Supermemory's own controls; deleting a Pi session does not delete remote facts.

## Development

```text
src/index.ts       entry point and composition
src/extension.ts   default memory routing, registerRecall, registerTools, /supermemory command
src/memory.ts      domain types, selection, formatting, policy
src/context.ts     projected-context deduplication
src/store.ts       validated official-SDK adapter
src/identity.ts    local project identity
src/config.ts      validated environment configuration
src/auth/          OAuth lifecycle, validated private storage, optional env-key override
```

```bash
git clone https://github.com/Coiggahou2002/pi-supermemory.git
cd pi-supermemory
npm ci --ignore-scripts
npm run verify
npm pack --dry-run

# Temporary development load (does not install globally).
pi -e ./src/index.ts
```

Tests cover strict typing, selection/bounds, Chinese prompts, project/worktree identity, actual Pi TypeScript extension loading and runner dispatch, context edits, compaction, branching, file reopen, SDK request contracts, cancellation, error redaction, and save consent. An offline end-to-end test drives a **real Pi AgentSession** through a local OpenAI-compatible HTTP fixture, automatic recall, proactive search, save, tool results, and final answers using an injected SDK transport. It checks that the serialized request prefix remains unchanged during the tool loop.

OAuth tests also exercise the real `openid-client` library and real loopback HTTP callbacks with fixture authorization-server responses: state/issuer rejection, single-use callbacks, PKCE, refresh rotation, concurrent auth instances, cancellation, timeout, secure storage/reopen, revocation failures, malformed responses, and SDK bearer authentication.

**Live checks completed:** official discovery and client registration, stopped before browser consent with no user tokens requested or saved.

**Not yet tested:** browser consent and account-specific REST access through OAuth, real model reasoning, a manual interactive TUI confirmation pass, or provider-side cache metrics. These are pre-publication acceptance checks, not replaced by offline tests.

## Acknowledgements

Design research used the official integrations as references; this implementation is independent:

- [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)
- [claude-supermemory](https://github.com/supermemoryai/claude-supermemory)
- [codex-supermemory](https://github.com/supermemoryai/codex-supermemory)

MIT. Source and version tags are public on GitHub. npm publication remains intentionally disabled with `private: true`.
