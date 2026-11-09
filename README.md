# pi-supermemory

A small **community** [Pi](https://pi.dev) extension for [Supermemory](https://supermemory.ai). Not affiliated with either project.

- Browser OAuth login once; future Pi sessions reuse and refresh the saved credentials. No copied API key required.
- `memory_search`: the agent searches saved project facts.
- `memory_remember`: the default destination for ordinary “remember this / 记住这个” requests, with confirmation by default. You do not need to name the tool.
- Optional automatic recall: append relevant, new facts once before a run, preserving the existing conversation prefix.
- Context-aware exact-text deduplication across automatic recall and proactive searches, using Pi's active session projection rather than a permanent “seen” list.
- **Automatic capture is on by default after sign-in:** completed runs submit new user/final-answer text for remote memory extraction. Startup warns about this and possible charges. Use `/supermemory capture off` for this session or `PI_SUPERMEMORY_AUTO_CAPTURE=false` across restarts. No MCP proxy.

**Status:** early preview release, distributed through GitHub (not npm). Tested against Pi **1.5.0**, Node **22.23.2**, and the official **supermemory 5.1.2** SDK. Offline integration tests pass. Live OAuth discovery and public-client registration have been verified; OAuth-authenticated capture and same-ID resubmission have also been verified with synthetic data in a disposable namespace, followed by namespace cleanup. Extraction quality, real-model reasoning, and exact billing semantics still need acceptance testing.

## Install once, then just use Pi

Requires [Pi](https://pi.dev) **1.5.0**, Node **22.19+**, Git, and a Supermemory account. Pi downloads the package and installs its runtime dependencies; you do not need to clone this repository first.

```bash
# One-time installation into Pi's personal package list.
pi install git:github.com/Coiggahou2002/pi-supermemory@v0.5.0

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

Remove the installed package with `pi remove git:github.com/Coiggahou2002/pi-supermemory@v0.5.0`; removing the package does not revoke the account grant, so log out first if desired. Version tags are pinned; install a newer release tag explicitly when upgrading.

If you previously installed a local checkout, remove that local package first and remove any extra `-e` flag to avoid loading two copies of the extension.

You can chat normally; no special “remember this” phrase or enable command is required:

```text
When explaining architecture, I prefer minimal skeleton code rather than long prose.
```

After the completed answer, the new exchange is submitted for extraction automatically. Explicit `memory_remember` calls still require their own confirmation by default. After memory generation finishes, try asking:

```text
What explanation style did I ask you to remember?
```

Writes return an acceptance receipt. **Source acceptance/searchability is not completed memory generation.** Both stages are asynchronous; dynamic memory generation may lag searchable source processing by several minutes. A miss immediately after a save is not proof of failure. Inspect the stages with `/supermemory capture status`.

### Default destination and local memory skills

The extension adds a stable routing policy, including before sign-in (when it asks you to log in rather than falling back locally): ordinary durable-memory requests use Supermemory by default, whether automatic recall is on or off. The advertised description of a skill named `memory` is narrowed to explicitly requested local/Markdown storage for this run. No skill file or global configuration is edited. Explicit “save locally in ~/memory” requests can still use the local backend. Higher-priority host instructions and other extensions can still override prompt guidance; this is not a filesystem interceptor.

Failures must not silently fall back to local files, and a save should not be reported as successful without a tool receipt. Previously saved local notes are not migrated or deleted. Reload an already-running Pi session to receive the new policy; a fresh session also avoids old local-skill instructions lingering in history.

Manual tool routing and automatic capture are separate. Manual `memory_remember` calls still require confirmation by default; automatic capture is on by default and submits eligible new exchanges without a per-turn dialog after the startup disclosure.

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

### Automatic capture is on by default

**Behavior change in v0.4.0:** earlier versions required capture opt-in. New sessions now capture automatically once signed in, including headless sessions. A startup notice is emitted before the first user message (to stderr in headless mode). If you do not want remote uploads, turn capture off before chatting or set `PI_SUPERMEMORY_AUTO_CAPTURE=false` before launching Pi. Automatic recall is still a separate opt-in.

```text
/supermemory capture on       # re-enable after turning it off (interactive confirmation)
/supermemory capture off      # stop future capture and settle/cancel in-flight work
/supermemory capture retry    # confirm retry of up to 5 pending batches
/supermemory capture discard  # discard pending retry metadata, not remote memories
/supermemory capture status   # inspect source status, memory stage and memory count
```

By default, completed runs send **new user text and completed assistant answer text** to Supermemory's memory extraction pipeline automatically. You no longer have to say “remember this” for every fact. This may incur ingestion/extraction charges. It does not enable auto recall; `/supermemory on` controls that separately.

- No backfill: only new runs begun while capture is on and signed in are eligible. Custom-message starts, aborted/failed/incomplete runs and edited sources are skipped.
- Tools/results, thinking, images, system prompts, injected recalls and extension state are excluded. **Answers can still describe facts seen in tools or images.** If a user/assistant/tool source in the run contains any `<private>` marker, the entire run is skipped, including unmarked assistant echoes. This cannot detect secrets or protect later unmarked paraphrases.
- New captured documents are readable Markdown: a heading derived from the first user text, followed by quoted User/Assistant sections, not internal JSON. A title hint is provided in metadata; the service may generate a different title. Namespace-wide `supportingContext` is no longer overwritten on every upload. Existing namespace descriptions are left alone.
- The complete source payload is limited to **32 KB UTF-8** and 1,000 source entries. Oversize runs are visibly skipped, not truncated.
- Capture is awaited at the settled boundary, not run in a detached worker; it can add auth/SDK latency after the visible answer. A queued acceptance is not proof that facts have finished extracting or are searchable.
- A private metadata-only journal under `~/.pi/agent/supermemory/capture/` records pending/accepted batches. It stores source references, format, processing mode and receipt state, not another transcript copy. Pending text is reconstructed from exact source entries on the active branch only when you explicitly retry. No historical resend happens automatically on restart.
- Retries retain the same caller-defined document ID/content. The service supports ID-based append/diff deduplication; **exactly-once extraction/billing after a lost response is not guaranteed**. Accepted batches are not retried. Corrupt journals and changed/edited/missing sources fail closed.
- Pending work is bound to its original namespace, session and authorization grant (or API-key fingerprint), including a check against the credential actually used by the SDK. Re-login deliberately creates a new grant: old pending captures are not sent to that new login, even if it is the same account. Refreshing a token preserves the binding. Old journals contain only metadata and can be removed locally if no longer needed.
- Turning capture off, logging out, or uninstalling cannot retract a request already accepted by the service. Use Supermemory's controls to remove remote content. Session toggles reset on `/reload`/replacement, so `/supermemory capture off` alone is **not a persistent opt-out**. Set `PI_SUPERMEMORY_AUTO_CAPTURE=false` to keep it off across restarts; `true` restores the default.

## Configuration

OAuth credentials are stored in this extension's own private directory under Pi's agent directory. Optional overrides come from process environment variables. This extension does **not** read other agents' credentials, `.env` files, or project configuration files.

| Variable | Default | Meaning |
|---|---|---|
| `SUPERMEMORY_API_KEY` | unset | Optional explicit override for CI/API-key users. When set, browser login/logout explains that you must unset it and restart before using OAuth. |
| `PI_SUPERMEMORY_NAMESPACE` | derived locally | Explicit namespace, 1–128 ASCII letters, digits, `_` or `-`. |
| `PI_SUPERMEMORY_AUTO_RECALL` | `false` | Enable automatic query sharing. Must be `true` or `false`. |
| `PI_SUPERMEMORY_AUTO_CAPTURE` | `true` | Automatically upload eligible new conversation deltas after sign-in, including unattended sessions. Set `false` for a persistent opt-out. Independent of recall and manual-write permissions. |
| `PI_SUPERMEMORY_CAPTURE_MODE` | `dynamic` | `instant` opts into one extra operation per captured document for independent immediate processing. Original modes are retained on retries. |
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

### Source searchability vs memory generation

`/supermemory capture status` reads the latest accepted capture **for the current session, namespace and login grant**. Resume the original session to inspect its last capture; this command is not an account-global document browser. It reports:

```text
Source=done; memory generation=dreaming; derived memories=0
```

This means the original document is searchable, but its memory-generation stage is still pending (which can include retries). It is not proof of an extraction failure or a bad source format. If both stages finish and the count remains zero, the service reports no derived memories for that document; not every exchange contains durable facts. The command shows no source text and modifies nothing. There is **no automatic progress polling** after every upload.

Dynamic remains the default; no extra operation is silently added. For future runs you may explicitly choose:

```text
/supermemory capture mode instant  # confirms ONE EXTRA OPERATION per document
/supermemory capture mode dynamic # return to grouped, delayed generation
```

Instant processes each document independently right away, but is still asynchronous and does not guarantee useful facts. A session mode change affects future runs only; pending retries retain their original mode and billing behavior. Modes reset on reload; `PI_SUPERMEMORY_CAPTURE_MODE=instant` is the explicit unattended/startup setting. Startup discloses its extra charge when selected.

**Upgrade compatibility:** old JSON documents are not rewritten or re-uploaded. Old pending journals lacking format/mode fields reconstruct their exact original JSON bytes/ID and dynamic mode. New batches use readable v2 content. Journal v1 is read compatibly; subsequent writes use journal v2 so older plugins fail closed rather than erase format/mode metadata. Do not downgrade while v2 pending work remains if you need those retries. Retry is for unconfirmed uploads, not a way to force a new memory-generation pass on an already accepted document.

### Project identity

Default namespaces are `pi_local_<hash>` derived from the canonical absolute **Git common directory**. Subdirectories, symlinks, and linked worktrees share memory. Different clones, moved repositories, and different machines do not automatically share it. Outside Git, the canonical current directory is used, so sibling/nested directories have different identities.

For cross-machine or cross-client sharing, deliberately set the same `PI_SUPERMEMORY_NAMESPACE`. There is **no automatic compatibility claim** with Claude Code/Codex/OpenCode container names. Namespace selection scopes requests within your Supermemory account; it is not a replacement for service-side authorization.

## How it works

```ts
export default function (pi: ExtensionAPI) {
  const auth = createAuthentication(getAgentDir());
  const store = createSupermemoryStore(expectedIdentity => auth.getToken(expectedIdentity));

  registerRecall(pi, dependencies, isEnabled);
  registerTools(pi, dependencies);
  registerCapture(pi, captureDependencies, config.autoCapture);
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

agent_settled (capture on by default; respects opt-out)
  → inspect only this run's new safe source entries
  → persist stable pending batch metadata
  → send role-labeled delta through the same SDK
  → checkpoint validated acceptance
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

- Manual search sends the query; manual save sends the confirmed fact. Auto recall additionally sends eligible expanded prompts. Default-on automatic capture sends new user/final-answer text for remote extraction unless disabled. Returned facts are sent to your configured LLM provider and persisted in Pi's session file, even when the recall message is hidden in the UI.
- `<private>` markers block the entire search/save operation or skip automatic recall for that prompt. They are a convenience guard, **not secret detection or DLP**. Do not submit sensitive content.
- Manual-save confirmation reviews the exact trimmed text and namespace. Headless manual saving fails closed unless unattended writes are explicitly enabled. Automatic capture is on by default, disclosed at startup, and does not prompt for each turn; disable it before chatting if you do not want remote ingestion.
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
src/capture/       readable/versioned source, mode selection, stage diagnostics, grant-bound journal/retries
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

Readable formatting, exact legacy JSON/ID reconstruction, original-mode retry retention, stage parsing/zero-memory diagnostics, and extra-cost confirmation are tested. Default-on configuration and startup disclosure are tested, with persistent environment opt-out and an actual Pi run that captures without an enable flag/command. Capture tests also cover future-only windows, full-run private suppression and assistant echoes, failed/aborted/custom starts, source edits, bounded payloads, restart/retry, mismatched receipts, corrupt journals, branch/namespace/grant isolation, off/upload races, and actual competing processes. The end-to-end Pi test includes automatic capture after each complete answer and confirms that tool turns do not trigger extra captures.

**Live checks completed:** official OAuth discovery/client registration; OAuth-authenticated synthetic capture and same-ID resubmission. A real existing capture was diagnosed as source `done` but memory stage `dreaming` (0 memories), then a later read showed memory stage `done` with 1 derived memory, matching the asynchronous dynamic-mode documentation. A new disposable readable capture was retrieved with User/Assistant sections and a non-JSON title/fallback; its namespace supporting context remained unset, and the new status adapter correctly reported both stages. The disposable namespace was deleted and a subsequent get returned 404. No real user document was rewritten. Earlier disposable namespace cleanup was checked via the newest namespace listing. A document-delete receipt during queued processing did not confirm deletion, so the entire random QA namespace was deleted and its absence checked instead.

**Not yet tested:** automatic extraction quality/searchability after indexing, real model reasoning, a manual interactive TUI confirmation pass, or provider-side cache/billing metrics. These are pre-publication acceptance checks, not replaced by offline tests.

## Acknowledgements

Design research used the official integrations as references; this implementation is independent:

- [opencode-supermemory](https://github.com/supermemoryai/opencode-supermemory)
- [claude-supermemory](https://github.com/supermemoryai/claude-supermemory)
- [codex-supermemory](https://github.com/supermemoryai/codex-supermemory)

MIT. Source and version tags are public on GitHub. npm publication remains intentionally disabled with `private: true`.
