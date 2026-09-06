# Astra review: bootstrap session and Phases 1–6

Date: 2026-09-06. Reviewed baseline: `067a7dc`. Lead: GPT Astra, medium
(session metadata verified). Scope: recover the earlier session's decisions, review the
implementation and workflow, and prepare Phases 7–12. This is not a release approval.

## Imported session context

Read-only sources, both titled **Omnigent Windows app bootstrap**, under
`C:/Users/TugaPlayz/.claude/projects/C--Users-TugaPlayz-Desktop-GITHUB-Omnigent-windows/`:

| Session | Range (UTC) | Relevance |
|---|---|---|
| `3fab5c75-0e84-4c88-865f-c6a7537f003e.jsonl` | 2026-09-05 01:44–19:38 | Earlier Omnigent Windows wrapper; background, not capygen implementation |
| `02ab77d9-b4b2-4020-9113-df8a9062894c.jsonl` | 2026-09-05 14:30–2026-09-06 19:08 | Capygen specification, Phases 1–6, and handoff |

“Import” here is a curated, source-linked context record for this development session.
No app database was modified; the app's transcript-import feature remains Phase 7.
Raw transcripts and their tool payloads are not copied into the repository. Luna performed
an independent read-only inventory; Astra checked the capygen source records and code.

Key user records in the second source:

| UTC | Message UUID | Decision carried forward |
|---|---|---|
| 2026-09-05 20:29:03 | `246ea1d0-c1e4-41f9-8482-da347bab8762` | Name capygen; reactive capybara; wordmark font; token/context efficiency |
| 2026-09-05 20:52:27 | `3934c278-7ae6-4be6-838a-444dd5da8eb5` | Mascot must not imitate Codex's face; historical Fable/Opus/Sonnet crew |
| 2026-09-05 22:34:54 | `5ec27d10-69b5-4e07-b4b0-50ff7ce93503` | Plugins, skills, MCP, tools, two-way config sync, global settings, structured questions/widgets |
| 2026-09-06 15:52:04 | `2dae321e-49ee-4a2a-8429-28c45ccd2412` | Finish Phase 6, hand leadership to Astra, preserve policies and handoff |
| 2026-09-06 19:08:34 | `9fc14b71-6275-43dc-875b-08e3c6c848ec` | Assistant's handoff at `067a7dc`, historical gate and known skips |

Earlier remote-host/WSL wrapper requests are not added back to capygen: SPEC explicitly parks
WSL and remote/cloud operation. The current user's request is review/preparation plus mascot
work; old automated “continue all phases” messages do not expand this turn's scope.

## Architecture and workflow assessment

Keep the accepted Electron/React/TypeScript, SDK-first harness, dockview, node:sqlite and
ConPTY architecture. Repository evidence supports incremental completion rather than a
framework rewrite: working typed IPC, fixtures across harnesses, persisted sessions,
real Windows terminal/browser integration, and recorded engine spikes. ADR-0003 and
ADR-0005 explain the SQLite and terminal native-module choices with measurements.

The sequence was sensible: prove risky backend contracts, build a walking skeleton, add
backends, collaboration, workspace, then settings. Contracts-first and per-task commits
made large parallel changes reviewable. Deterministic hop-cap tests are stronger evidence
of a bound than a live model that may voluntarily stop. Documented live/API skips are useful,
but passing fixtures must not be presented as renewed live-provider acceptance.

Workflow corrections for the next phases:

- `.claude/workflows/phase6-settings.js` task C ticks the phase before the review wave;
  task D fixes findings without a second independent review. Future acceptance comes after
  fixes, independent re-review, and the final gate on the same revision.
- Contracts tasks allow compatibility edits outside ownership, while other workers own
  registration lines in the same files. Use one integrator for shared registrations;
  builders receive explicit non-overlapping files and existing contract names.
- Workflow summaries are sliced to short strings. Preserve complete findings and acceptance
  output on disk before summarizing; do not treat a truncated returned report as the record.
- Specs sometimes prove storage or rendering but not the shipping consumer: the green
  settings tests missed the runtime wiring findings below. Add boundary-spanning checks.

## Verified findings

R-A–R-D remain open implementation tasks; R-E was corrected in this review. No runtime fixes were silently bundled
into this planning review. Line anchors refer to baseline `067a7dc`.

### High — R-A: API/widget MCP discovery bypasses isolated homes and the settings source

`packages/engine/src/mcp/client/config.ts:47,75,88` defaults to `os.homedir()` and reads
`.claude/settings.json` / `.codex/config.toml`, without `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.
`packages/engine/src/api/ApiHarness.ts:821` and
`apps/desktop/src/ipc/widgets.ts:188` use this loader. Meanwhile
`apps/desktop/src/integrations/IntegrationsService.ts:156` exposes API-owned servers from
`api_mcp_servers` and inherited servers from the newer config stores.

Scenario: add an API MCP server in Settings, then start an API turn: the default factory
never supplies those saved servers. An isolated API/widget run can instead discover real-home
servers, and subsequently connect or spawn them. Claude user-scope `.claude.json` registrations
are also missing from the old loader. The Settings list is not the runtime list.

Probe: `loadMcpServers` with an injected read function and fixture home, while both isolation
environment variables point elsewhere, requested only the fixture *real-home* paths.
No real configuration was read by this probe. Fix: one effective server resolver using the
existing stores, explicit project/homes, enabled state and precedence; inject it into API and
widget consumers. Prove UI add → runtime tool discovery with a fixture server and assert
zero reads/spawns outside the isolated homes. Cover `.claude.json`, API-owned rows and disable.

### High — R-B: MCP pool identity omits credentials and environment

`apps/desktop/src/ipc/mcpPools.ts:52` fingerprints name/transport/command/args/cwd/url/disabled,
but not `headers` or `env`. `packages/engine/src/mcp/client/McpClientPool.ts:224,231` actually
uses both to construct transports.

Scenario: two sessions use the same server URL with different authorization headers, or the
same command with different workspace/account environment. The second lease reuses the first
transport, potentially executing with the wrong account or workspace.

Probe: distinct synthetic Authorization headers and WORKSPACE env values produced equal keys.
Fix: include canonicalized effective connection options in a non-logged digest; preserve
sharing for truly identical configurations. Tests must prove distinct configs get different
pools, identical reordered maps share, and release/close remains correct. Never log raw keys.

### High — R-C: saved Codex safety defaults do not reach the harness

`apps/desktop/src/integrations/SettingsService.ts:107` projects a subset of hub settings,
including Claude permissionMode, but no Codex defaults. `SessionRunner.ts:357,359` uses
flat permissionMode and passes `agent.config` unchanged. `effectiveBackendConfig` at
`packages/engine/src/config/layering.ts:55` is exported and unit-tested but has no shipping
consumer. The settings editor writes `settings.backends.codex`.

Scenario: choose read-only sandbox or a stricter approval default in Settings and create an
agent without overrides. Its Codex harness receives no saved default and uses its own fallback.
The same omission affects global effort/provider settings. This is a safety-relevant false
promise even when the harness's fallback still applies some sandboxing.

Fix: resolve the global/backend/agent layers at the harness boundary, including delegated
agents. Request-capture tests must assert the actual thread-start/turn options from a hub
patch, explicit overrides, reset and restart. Preserve session-stable prompts.

### Medium — R-D: project configuration follows recency, not the user's active session

`apps/desktop/src/integrations/IntegrationsService.ts:121–150` chooses `projects.list()[0]`
for reads and writes. Integrations IPC carries no project identifier.

Scenario: open session A after project B was recently created/touched, or use two windows.
A project-scope settings operation can target B while the user is working in A. The documented
recency assumption is insufficient for Phase 7's projects/worktrees.

Fix: explicit validated project identity across integrations IPC, UI and watcher/cache scope.
Test two projects/windows and worktree paths; an operation for A must neither read nor mutate B.

### Medium — R-E (fixed): acceptance/handoff text contradicted the reviewed implementation

`PLAN.md` opening still says only Phases 1–2 exist; Phase 6 deviations and `docs/HANDOFF.md`
still describe dev-server localStorage controls removed in `2222cd6`.
`COMPAT.md` claims local Codex/API tool-policy rows are enforced, although the reviewed UI
correctly says they await Phase 9. Fix the current-state prose and preserve historical log
entries. Phase ticks remain historical evidence, not a blanket approval of all requirements.

## Independent review and core-decision debate

Requested crew ran: Astra medium led; Luna inventoried history; Opus 5 independently verified
R-A–R-D and the workflow findings; Fable 5.1 medium debated the core decisions in two rounds.
The initial Claude dispatches failed before user reauthentication; subsequent dispatches
completed. Opus session `7653990c251144df8b3065517d8a6778` used `claude-opus-5[1m]`;
Fable session `7b24d93f29cd4bb2a5984923cd6792b9` used `claude-fable-5-1`, medium.

Opus confirmed the shipping API factory never injects the hub's server list, the exact Codex
fallback is `workspace-write` when the UI default is unconsumed, and project recency is unsafe.
It correctly requested marking R-E fixed and merging 7-P1/7-P3 because both edit SessionRunner.
One reviewer assertion was rejected and withdrawn: args are separated by U+0001, not joined
with an empty string, so `['ab','c']` and `['a','bc']` are not a demonstrated collision.
The confirmed pool finding is the omitted env/headers. Review findings were not accepted blindly.

Fable agreed to retain the stack and prioritize corrective work. Astra's decisions after debate:

- Retain the architecture; no framework replacement. Make GlobalSettings the runtime authority
  through a bounded compatibility migration instead of adding more flat projections.
- Require explicit config homes and project/worktree identity; remove or make explicit-home-only
  the legacy resolver. Combine shared harness-boundary work under one owner.
- Include every effective transport option in pool identity. Reject excluding environment
  fields merely to improve sharing; isolation takes priority. Fable withdrew that caveat.
- Dedicated live-test identity lives in a persistent separately authenticated home outside
  the repository. Never copy personal credentials or delete a persistent test login on cleanup.
- Automations run while the capygen process runs (tray counts); missed runs are skipped.
- Keep compaction implementation plus measurement in Phase 11, but put the known UTF-8 byte-cap
  gap into the corrective backlog; preserve R25/outputRef rather than weakening its wording.
- Recheck Codex delegation capabilities before assuming config-file registration is the only
  path: the pinned spike lists `dynamicTools`, per-thread `config`, and spawn-time overrides.
  None is live-proven for this use. Phase 9 tests them before an opt-in file-write fallback.
- Dictation runtime and extension service contract remain open. Extensions get a sandboxed
  iframe/validated message boundary, never unrestricted Node/preload access; implementation
  follows a documented primary-contract proof.

The findings are reviewed, not fixed. Phases 7–12 remain open. The detailed execution brief
records these decisions and their acceptance checks in `docs/plans/phases7-12.md`.
