# Changelog

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
