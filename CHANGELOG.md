# Changelog

## 0.4.0 — 2026-11-08

- Automatic capture is now on by default after sign-in: new completed exchanges are submitted for memory extraction without an extra enable command.
- Startup clearly discloses remote uploads and possible charges. Use `/supermemory capture off` for this session, or `PI_SUPERMEMORY_AUTO_CAPTURE=false` to keep it off across restarts.
- No history backfill; private-run filtering, bounded payloads, grant-bound retries, and manual-save confirmation are unchanged. Automatic recall remains independently opt-in.

## 0.3.0 — 2026-11-08

- Opt into automatic memory capture with `/supermemory capture on`: future completed conversations can become memories without a separate “remember this” request.
- Capture only new user/final-answer text; skip entire private-marked, incomplete or oversize runs, with no history backfill.
- Retry unconfirmed captures with stable document IDs and a private metadata-only journal; pending uploads stay within their original session, namespace, branch and authorization grant.
- Stop with `/supermemory capture off` or discard pending retry metadata with `/supermemory capture discard`. Recall and manual-write settings never enable capture implicitly.

## 0.2.0 — 2026-11-08

- Install the community preview directly from GitHub with Pi; no local checkout or per-launch wrapper is required.

- Sign in through the browser with `/supermemory login`; saved OAuth credentials refresh across Pi sessions without an API-key wrapper command.
- Inspect sign-in state and log out with `/supermemory status` and `/supermemory logout`.
- API-key environment variables remain an explicit optional override. Automatic query sharing is still opt-in, and writes still require confirmation by default.

## 0.1.0

- Ordinary “remember this / 记住这个” requests default to Supermemory; the local memory skill remains available for explicitly requested local storage.
- Search and explicitly save project-scoped memories through the official Supermemory SDK.
- Opt-in automatic recall with bounded, append-only injection and projected-context deduplication.
- Confirm writes by default; no automatic transcript capture or global installation.
