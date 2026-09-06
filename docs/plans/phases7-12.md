# Phase 7–12 execution briefs

Prepared by GPT Astra (medium), 2026-09-06, against `067a7dc`.
Status: Astra-prepared, independently reviewed by Opus 5, debated with Fable 5.1 medium in two rounds.
The original numbered phases and their Done-when clauses in PLAN.md remain the contract.
This document adds dependencies, concrete tests and work ownership; it does not tick phases.

## Crew and execution rules

| Role | Assignment |
|---|---|
| Lead, design, final decisions, integration acceptance | GPT Astra (`gpt-6-astra`), medium |
| Hard and medium implementation | Opus 5 |
| Simple mechanical implementation and inventories | GPT Luna (`gpt-5.6-luna`) |
| Core architecture/framework/trust-model debate | Fable 5.1, medium, with Astra deciding |
| Independent review | Different model from implementer; Opus reviews Astra work, Astra reviews Opus work |

No silent model substitution. Check actual availability before dispatch. Missing reviewers
leave an explicit gate open. Bound each batch to three workers and two review rounds; if
serious findings remain, open a corrective batch rather than declaring success. A failed task
gets one clarified attempt, then Opus diagnosis/fix; unavailable Opus means a recorded blocker.

For every phase: Astra freezes contracts and task briefs; assign disjoint files; the integrator
alone owns shared IPC registration/main wiring; builders commit only their task files by path.
Retain completed changes and unknown user edits. No push, release, install or sign-in is
implied by this plan. Read the reference before UI work; keep its tokens and NOTICE.

Acceptance sequence: implementation → focused checks → independent four-lens review
(correctness, security, UX parity, efficiency) → fixes → independent re-review → full gate
on the final implementation → Astra verifies Done-when → local acceptance commit and log.
Store findings and literal output tails before summarizing. A skipped live test is an open
live-proof item, not a passed test. Never copy authentication tokens to test homes.

## Phase 7 prerequisite batch: close the Phase 6 integration gaps

R-A–R-E refer to `docs/reviews/phase1-6.md`.

| Task | Owner/model | Surface | Acceptance |
|---|---|---|---|
| 7-P0 explicit project/repository/worktree identity | Astra contract; Opus implements | shared IPC/domain and desktop integration boundary, serial | two projects/windows; all settings operations and caches select the requested project; unknown ids refused |
| 7-P1/7-P3 effective runtime configuration | Opus, one owner | existing config stores/resolver, SessionRunner and API/widget factory wiring | add/disable API and Claude user-scope server through IPC → real fixture tools reflect it; no real-home reads/spawns; disabled/project approval precedence retained |
| 7-P2 connection identity | Opus | `apps/desktop/src/ipc/mcpPools.ts` and its tests | env/header differences isolate pools; equivalent maps share; no credentials in logs or digest inputs returned to renderer |
| 7-P3 acceptance within 7-P1 | same Opus owner | SessionRunner harness construction and boundary tests | hub defaults captured in Claude/Codex/API request options, overrides win, reset/restart/delegation covered |
| 7-P4 claims-to-code inventory | Luna, after behavior is verified | documentation only (R-E already fixed) | every claim cites a consumer/test; no unenforced policy presented as enforced |

7-P1 and 7-P3 are one implementation task because they own the same harness boundary.
7-P0/P1 share scope resolution and must not run concurrently on the same files. 7-P2 is
independent. Do not broaden this into a replacement configuration framework. Reuse the newer
stores and pure layering functions. Remove the legacy MCP loader or require explicit homes;
no implicit real-home fallback. GlobalSettings becomes runtime authority with compatibility
migration for legacy flat settings and all consumers (main, handlers, SessionRunner, renderer).
Define repository identity versus concrete worktree execution path in 7-P0 before IPC expands.
All effective transport options belong in pool identity, including env/headers; no exclusions
for sharing performance. Compare effective options canonically; do not expose digest inputs.
Tests that currently omit backend-home isolation must adopt an isolated fixture boundary.
Live login is an explicit user-managed test identity in a persistent isolated home outside the
repository (e.g. a dedicated test-user data directory), not a per-run disposable home. The user
signs that identity in directly with the isolated home selected; never copy personal credentials,
include them in diagnostics, or delete this home during test cleanup. No personal-home refresh.

## Phase 7: projects, worktrees, git, imports

First read existing `workspace/GitService`, project repositories, composer chips, Diff pane
and Omnigent P8/P9. Projects already exist; extend them rather than building a second store.

1. Astra contracts: project/worktree relation and explicit source/target project identifiers;
   import provenance, warnings, supported format/version and deduplication key; typed IPC.
   A migration needs a backup/restore fixture before acceptance.
2. Opus git/worktree implementation: argument arrays, no shell interpolation; validate branch
   names and repository identity; paths with spaces/non-ASCII; select files for commit rather
   than staging everything; actionable no-git/unborn/detached/dirty/locked errors. Removing a
   dirty worktree requires a separate explicit destructive-action confirmation.
3. Opus import parsers: user-selected Claude JSONL and Codex rollout JSONL; bounded streaming,
   clear malformed/truncated-line diagnostics, stable order and source ids, duplicate detection,
   unknown event preservation as inert data. Imported tool calls never execute, imported
   permissions never authorize current work, source paths never become execution cwd implicitly.
   Do not import config, credentials, or raw environment dumps. Preview counts/warnings and
   destination before committing the transaction. Cancellation/failure leaves no partial session.
4. Luna handles established UI plumbing/fixtures after Astra supplies the reference layout and
   contracts; Opus owns stateful import/worktree behavior. Main registration remains serial.
5. Integration e2e: composer creates worktree → agent cwd is that worktree → file change appears
   in Diff → explicit UI commit contains only selected paths. Import both synthetic transcripts,
   restart, verify history/provenance and repeat import without duplicates. Source hashes unchanged.

Import format authority is the installed CLI's emitted sample/schema, recorded in COMPAT.md.
The historical sessions recovered in this review inform fixtures but must not be checked in raw.
Resuming an imported backend id is a separate explicit action, not an import side effect.

## Phase 8: Tasks, Inbox, Usage, Automations

Build on existing TasksService, notification tap and usage_events. Map Codex
`turn/plan/updated` into an observable block first (currently a known Phase 5 gap).

- Opus: persisted schedule lifecycle, next-run/recovery policy, one run lease per automation,
  no overlap, pause/delete/cancel behavior, app-closed behavior, DST/time-zone semantics and
  missed-run policy. Astra decision after Fable debate: run only while capygen's process is running (tray counts),
  skip missed executions and never replay a backlog after restart; explain this in the UI.
- Opus: Inbox projection from existing needs-input/finished/error events with stable dedup keys;
  restart does not duplicate notifications. Focused-window suppression remains in place.
- Luna: page wiring and fixture presentation after contracts; Tasks links to source session,
  Inbox links to the actual pending card, Usage groups per backend/model/day.
- Usage must distinguish unavailable prices from zero cost; do not fabricate sub-agent cost.
- Acceptance: real scheduler with injected clock and one real minute fixture; app restart,
  disabled schedule, failed run and overlapping tick cases. No model needed for those tests.
  Keep execution under the same permission gates and selected agent config as manual turns.

## Phase 9: catalogue, sharing, members, policies, approvals

This phase completes local policy enforcement; current unenforced rows stay clearly labelled
until then. Existing backend permission files remain authoritative (R29).

- Astra/Fable decision gate: precedence and limits of local policy relative to Claude/Codex
  native permissions, scope of member identity on one local machine, share schema/redaction.
  A policy UI must never claim it can intercept backend operations the protocol does not expose.
- Opus: enforcement at the actual tool/approval boundary, explicit allow/deny/ask precedence,
  scoped grants and revocation, audit metadata, no grant imported from history.
- Opus: inert HTML/JSON export/import with schema version, bounded assets, safe filenames,
  no scripts or active widgets on import, credential redaction, atomic import.
- Luna: catalogue/member/share/approval pages against agreed contracts and reference layouts.
- Acceptance: deny through the actual runtime despite UI tampering; ask reaches user and answer
  reaches correct request; revoked grant cannot authorize queued work; export→import→restart;
  malformed/traversal/script-bearing bundles rejected or rendered inert. MCP tools must be
  discoverable in the intended menu without confusing tools with slash commands.

## Phase 10: dictation, local hosts, terminal attach, extensions

Two genuinely unresolved core decisions require Fable debate and Astra's written decision:

1. Dictation: verify native Windows speech support/availability versus a local whisper runtime;
   language coverage, offline operation, microphone permission, installer size and CPU budget.
   Any model/runtime download uses the existing exact-command confirm/visible-console gate.
2. Extensions: define supported sample-extension contract and trust boundary before loading any
   third-party page. Prefer the existing sandboxed boundary; do not expose Node/preload/IPC
   wholesale. Prove navigation, permissions, shutdown and message validation.

Local hosts means this machine's harness status, not remote hosting (SPEC scope). Terminal
attach means explicitly launching a raw CLI in the existing terminal; no claim to reconnect
an SDK session unless the installed CLI supports and proves it. Opus handles lifecycle/security,
Luna handles reference-page plumbing. Acceptance includes mic cancel/denied/no-device,
terminal interrupt/close, and a hostile sample extension denied privileged operations.

## Additional corrective acceptance: output byte bounds

`ApiHarness.ts` currently uses `DEFAULT_MAX_TOOL_OUTPUT_CHARS`; multibyte content can exceed
64 KB. Add an Opus corrective task at the tool-result boundary: enforce UTF-8 bytes without
splitting a character, store the full output behind an outputRef, and prove the displayed stub
retrieves the original after restart. Do not loosen AGENTS R25 to match the current code.
This shares tool-output/persistence ownership, so schedule it serially with runtime wiring.

## Phase 11: efficiency implementation and measurement

Safety and isolation checks are not postponed to this phase. Preserve current caching while
features land; Phase 11 closes quantitative G9 and compaction/output requirements.

- Baseline first: same model/version, prompts, tool outcomes, settings, starting files and
  cache state for CLI and app; record 20 turns, per-model input/output/cache usage, repeats and
  variance. Use dedicated credentials; no real-user refresh or prompt-spending without a
  controlled live run. Missing credentials leave the benchmark pending.
- Prove existing system/tool cache breakpoints via actual request capture. No settings/IPC data
  reaches model context. Verify lazy listing and bounded output in UTF-8 bytes with a working
  outputRef, including restart retrieval and multibyte content.
- Build the missing automatic/native-dispatch/API-summary compaction paths; then prove the
  configured threshold is used by the shipping harness, pending interaction preserved,
  cancellation and backend failure surfaced, replay/tool-result pairing preserved.
- Unknown prices are unknown, not zero. Update price evidence separately from token counts.
- Done only with measured ≤110% baseline plus the original full gate; no estimate substitutes.

## Phase 12: packaging, updater, CI, docs, parity audit

- Native Windows clean-machine CI: full gate, NSIS/portable/latest.yml artifacts, bundled
  Codex runtime, unpacked entire node-pty directory (ConPTY DLL/exe/prebuilds/lib), migrations,
  fonts and mascot assets. Verify installation path containing spaces/non-ASCII.
- Smoke the installed app: launch/focus budget, real terminal, browser overlay, SQLite restart,
  config isolation, tray manual checklist, and uninstall behavior without deleting user data.
- Updater fixture: all four modes, explicit install click, failure/cancellation, older build
  reads test feed. Preparing workflow/artifacts is authorized; publishing/tagging/pushing is not.
- Start resolving font redistribution by Phase 10; Phase 12 acceptance requires resolution: converting a font to an SVG does not establish a right
  to distribute its artwork. Obtain license evidence or select an authorized fallback through
  the design decision process; no legal conclusion is inferred from a missing license file.
- Reconcile every P1–P20/R1–R32 item with proof or an explicit remaining gap. Two independent
  clean review rounds after fixes, then final full gate, release notes and runnable/revert docs.

## Carried open items

Nothing in docs/HANDOFF.md is silently dropped: Claude/API live proof; Codex cross-backend
routing opt-in design and absent sub-agent cost; CLI probe refresh cost; prerequisites UI
duplication; unfinished parity pages; delegation e2e flake; harness avatar glyphs and nested
Codex activity; browser hidden-tab history loss; floating-tab affordance; sub-agent task source;
Codex plan mapping; native packaging; connector widget fallback. Assign to the relevant phase
above and retain the remaining items in the handoff until their checks actually pass.

## Codex delegation feasibility order (Astra after Fable debate)

In Phase 9, read the pinned thread-start schema and test `dynamicTools` with tool-call replies
first, then per-thread `config` overrides, then spawn-time overrides; stop at a proven suitable
path. Config-file registration is an explicit opt-in fallback. `docs/spikes/codex-shapes.md`
records these fields but not live proof of cross-backend delegation. ADR-0004's current lack
of implementation stands; its claim that config.toml is the only possible path is unproven.
A new accepted ADR requires the capability proof, not this planning hypothesis.
