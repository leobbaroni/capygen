# Phase 7 transcript import contract

Astra decision after Fable 5.1 medium trust-boundary review, 2026-09-07.
Parser work may proceed independently; shipping integration follows runtime configuration fixes.

## User flow and authority

The user selects one Claude JSONL or Codex rollout file in a native picker. The main process
parses that selected file only; it never scans a backend home or follows source paths to other
files. Preview shows detected backend, native id, title, counts, warnings and destination project.
Source cwd is provenance only. Import never starts a backend, executes a recorded tool, creates
permission grants, restores source configuration, or assigns a native resume id.

Imported sessions are read-only artifacts. Enforce this in the main process as well as replacing
the composer. Historical tool calls/results, permissions and questions become inert text/code
with historical labels, not interactive block variants with pending state or invented decisions.
Historical speakers are labels, never dispatchable agents.

Continue as new session creates a fresh local session in a user-selected project, using current
validated model/configuration and no imported backend identity. Record a provenance link. On the
first actual send, include a bounded, escaped transcript tail as explicitly untrusted quoted
reference at user-message priority; never promote source instructions to system instructions.
Show the reference before sending. Capture actual Claude, Codex and API requests to prove receipt;
SQLite history alone does not establish that native backends saw the continuation context.

The current delta labels null-agent turns as the user, so storing a generic system/user turn
is insufficient. Use the existing `speaker_label` with an explicit imported-reference marker,
honour it before the agent-id fallback in transcript mapping, and emit its escaped quotation at
user-message priority in API history too. It must never become an API system message or a new
dispatchable speaker. Cap the delivered reference at 6,000 UTF-8 bytes including labels, with
an explicit truncation marker; give this identified reference its own bound rather than silently
clipping it again to the ordinary 1,500-character per-turn delta limit. Prove delivered bounds.

## Parsing and limits

- Stream UTF-8 JSONL with explicit limits: 256 MiB selected bytes, 1 MiB per line, 100,000
  normalized records and 256 MiB normalized bytes. Fail the entire preview on exceeding a
  limit, malformed JSON/UTF-8, conflicting native identities, or unsupported file structure.
- Recognized message fields are allowlisted. Drop configuration/auth/environment/credential
  records and count them without retaining values. Unknown events retain a bounded type label
  and count only, never raw payloads. Ordinary transcript prose may itself contain sensitive
  information; preview must not claim automatic secret removal.
- Bound historical tool text to 64 KiB UTF-8, preserving truncation indication and using the
  existing output storage boundary if full supported output is retained. Never execute content.
- Claude uses the installed SDK's `getSessionMessages` with a read-only custom `SessionStore`
  containing only selected, sanitized records. Supply an explicit inert directory and prove no
  scan, spawn or source write. Do not change process-global backend homes inside a running app;
  any helper requiring an isolated environment must run in an isolated worker boundary.
- Codex uses the pinned native JSONL wire shapes, preferring canonical response items to event
  echoes to avoid duplicate user/assistant text. Referenced history prefixes are not opened:
  mark a snapshot incomplete if its history depends on another file. Unsupported compression,
  multimodal content, compaction variants and branch semantics get explicit warnings/refusal;
  do not invent missing history or claim lossless import.

The isolated Claude SDK custom-store probe is in ignored
`e2e-out/review/import-probe/probe.mjs`: three synthetic linked messages, one store load, no CLI
or model call. This proves only that supplied fixture's canonical chain, not every transcript.
Codex format authority is the pinned
[history wire source](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/history/src/rollout_payload.rs),
[record envelope](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/history/src/lib.rs)
and [metadata definition](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/protocol/src/protocol.rs).
Add synthetic fixtures and exact installed versions to COMPAT when implemented.

## Staging and persistence

Main owns bounded staging storage and opaque handles, scoped to the requesting window, with a
10-minute TTL. Renderer receives preview metadata only. Cancel, expiry, window close and failure
clean staging; startup removes abandoned owned staging files. Commit consumes a handle once in
one database transaction. Hash the actual selected bytes while parsing so commit imports the
reviewed snapshot even if the source later changes; never reopen a source to silently substitute.

Add import provenance with session id, backend, native id, source path, SHA-256, format,
counts/warnings and timestamp; enforce unique (backend, native id, hash) in SQLite. Add explicit
session origin and nullable continuation provenance. Same identity/hash returns the existing
artifact. Same native id with another hash creates a separate snapshot after preview warning;
never overwrite or merge an existing chat. Only confirmed imports persist transcript content.

## Acceptance

Synthetic Claude/Codex fixtures prove chronological canonical text, inert activity, dropped
configuration values, unknown counts, Unicode byte limits and missing-prefix warnings. No test
reads personal backend files. Verify no native home access, tool/model dispatch, source writes
or backend resume id; main refuses sends to imports. Prove dedup including concurrent commits,
snapshot isolation, rollback with zero partial rows, handle ownership/expiry/cleanup and fresh
continuation request context across all three harnesses. Electron e2e exercises picker preview,
cancel/import/open and continuation. Independent review and the full phase gate remain required.

## Production worker decision (Astra + Fable review, 2026-09-07)

Parse each selection in a fresh Electron utility process with a bundled `importWorker.cjs`
entry. Give it an explicit allowlisted environment and disposable homes, including Claude's
`CLAUDE_SECURESTORAGE_CONFIG_DIR`, plus an inert cwd. The worker never imports Electron and
also supports plain Node IPC for isolated fixture verification. Import the SDK only inside
the Claude reconstruction callback, after verifying those directories. This prevents accidental
personal-home access; it is process/config isolation, not a filesystem sandbox.

The worker exclusively writes the normalized result to a main-supplied app-owned path and
returns bounded metadata (64 KiB maximum), avoiding a 256 MiB transcript over a message port.
Main validates the result before adoption/commit. The client must kill cancelled/timed-out
children, await exit before cleanup, bound pipe draining, and cap active workers at two;
staging's 256 MiB aggregate reservation may admit fewer. Partial writes and failed deletion
remain owned/accounted until removed. Packaged worker/SDK resolution is a Phase 12 smoke check.
Tests use owned sentinels only; even mtime probes of personal backend homes are excluded.
