# capygen — handoff (2026-09-08, Phase 9C accepted; Phases 10–12 in progress)

## Current work

Resumed 2026-09-08 after `1a429b3`: the complete unit suite passes (2917 passed,
4 skipped) after stale theme/dictation assertions and an oversized quota fixture were
corrected. Typecheck and build passed. The native suite initially reported 53 passed,
12 skipped and two failures; the prerequisite cancellation regression now passes in a
focused run. Local app pages remain unreachable after the Tools redesign, so the extension
native test is still failing and placement awaits the user's choice. No new phase is accepted.
Microphone acceptance awaits the user's test result. The user subsequently reauthorized
the Phase 11 live benchmark; dedicated test login is pending. Continue fixes and automated checks.
The existing uncommitted Codex isolation probe and
`state.lock` are preserved. Full CI on the old revision was cancelled after reproducing
its stale assertions locally; a new full CI run is needed after the navigation issue is resolved.

Phase 9 is accepted at `a319b5b`. Phase 9C passed its full gate on 2026-09-08: typechecks,
2815 unit tests (4 skipped), build, and 54 native Electron tests (12 live skipped, 2.3m).
The native Custom Mode test generates a tool-free draft, edits it visually, applies it and
restores policy/history after restart. Runtime fixtures cover diagram routes, bounded debate
and rejection of dispatch during restart. Migration 0014 preserves historical agents.
Phase 10's extension sample also passed native storage/reopen/network-isolation acceptance;
compiled speech metadata reports en-GB without opening a microphone. Real microphone
acceptance remains user-observed. Phases 11/12 measurement and packaged/private-feed proofs
remain open. See PROJECT_LOG for exact gate evidence and earlier failures/fixes.

The strict delegation foundation is pushed at `da3f06d`; the real Codex paired tool-definition
proof is recorded in `native-spawn-paired-proof.json` (spawn_agent present, baseline and
absent flags false, two local requests). Resume is unit-tested only; full Codex no-tool
authoring remains unsupported and unaccepted. Codex/API effort/provider metadata is now
preserved in harness listings; Claude model/effort metadata now comes from SDK initialization.

Phase 11 implementation now includes a SQL text-only round-table projection, paired benchmark
runner and bounded same-model API summarization for explicitly configured model capacities.
Phase 12 implementation includes private updater controls, native-confirmed installation,
Windows staging/audit and tag-release CI. Integrated native typecheck and 19 focused tests
passed. Local installer/portable builds are approximately 268 MiB and the actual packaged
runtime smoke passed (1 test, 10.1s): landing/bridge, updater status, speech helper, both
bundled CLI versions, PTY echo/raw Codex startup and extension assets. No installer was run
and no release was published. Benchmark authentication, microphone acceptance and actual
older-build/private-feed proof remain missing; Phases 10–12 are not accepted.

Clean Windows packaging diagnostic passed at `b574099` (GitHub run 34199812626):
frozen dependency install, `build:win`, artifact audit, packaged smoke (17.7s) and private
artifact upload. Both clean-build EXEs are approximately 265 MiB; the local builds are
approximately 268 MiB. CI manifest sourceDirty=false. This was explicitly package-only:
unit and ordinary Electron gates were skipped, and no release/tag was published. Full CI
acceptance remains open after fixture fixes; the preceding full run had 2831 passed,
two failures since fixed in focused checks, seven skipped and a worker RPC timeout.
Artifacts: https://github.com/leobbaroni/capygen/actions/runs/34199812626/artifacts/10045522661

Current execution is Astra low leading, Claude Opus medium for hard/medium work when
available (Astra low fallback), and Luna low for easy tasks. Reviews and tests focus on
new crucial behavior. Root alone stages and commits. No full phase acceptance should be
inferred from focused checks.

The user's 2026-09-08 findings take priority over later phases; the live repair checklist
is `docs/plans/2026-09-08-ux-repair.md`. The prerequisite repair is pushed at `a789044`.
The current repair tree replaces the Extensions navigation with canonical Tools editors,
adds shared read-only skill access across harnesses, fixes dark layout and settings
scrolling, remembers round-table preferences, exposes per-agent request context, and
makes explicit cross-backend delegation available without a routing settings panel.
Changing Codex dynamic tool declarations intentionally replaces an existing native thread
once, with the existing bounded continuity reference; it does not silently reuse a thread
whose tool definitions are stale. Image input and Custom-at-start apply/send now pass native checks. Pictures survive reload;
Custom awaits catalogue readiness and resolves the existing project before home fallback.
Targeted checks and the Windows build passed; these are not a later-phase full gate.
The native Custom fixture now lives outside the user-profile ancestry, because Claude can
load ancestor project instructions despite isolated config variables. No user config files
were written, and test provider traffic stayed on loopback.

## Phase 9 acceptance — 2026-09-08

Phase 9 is accepted following independent reviews and the complete Windows gate:
typecheck passed; 201 unit-test files passed (2749 tests passed, 4 skipped); build passed;
52 native tests passed, 12 live-backend tests skipped (1.8 minutes). The skipped tests are
not live-backend acceptance; dedicated authenticated test homes remain needed for Phase 11.
Evidence: `e2e-out/phase9-acceptance-final-gate.log` and `PROJECT_LOG.md`.

Session MCP editor activation, inert slash-menu tools and explicit disable are proven on
Claude and Codex without model turns. Codex refresh starts transient discovery processes;
repeated refresh retains exactly one persistent server and disposal leaves none. An empty
Codex override map does not suppress inherited servers; named enabled=false does.
Sharing exports/imports HTML/JSON, preserves local notes through redaction, and creates fresh
continuations. Members, Policies and Approve enforce local permissions in native fixtures.
Audit migration 0012 snapshots execution site at admission, including concurrent requests
and disposed captures. Migration 0011 stores local share comments.

At this historical Phase 9 checkpoint, next was Phase 9C Custom Mode, then Phases 10–12. The standalone customMode.ts contract draft
is not integrated or accepted. Codex no-tool authoring isolation remains unproven and must
stay unavailable. Opus reached its session quota (reset reported 07:40 Lisbon); Astra
continues integration and Luna handles small tasks/reviews. Root alone stages and commits.
The unrelated state.lock remains untouched. Earlier findings below are historical unless
explicitly carried into the remaining phase briefs.

Phase 8 acceptance crew (historical): GPT-6-Astra (Codex), low; hard/medium implementation and review: GPT-5.6-Sol,
medium; easy renderer work: GPT-5.6-Luna, medium. Different-model review was applied
before acceptance. Phases 1–6 remain historical acceptance, preserved below.

## Historical checkpoint — before Phase 9/9C acceptance

The current acceptance status is in the Current work section above.

Phases 7 and 8 are accepted at `f80500c` on `main`. The user has now authorized the
remaining phases: 9, 9C and 10–12. Current crew: Astra low lead, Opus 5 medium hard/medium,
Luna low simple tasks; different-model reviews, no Fable debate. Verified pushes use
`origin/main` (never force-push). The lead stages and commits completed tasks serially.

Phase 7 includes native worktree creation/registration/removal, session cwd, selected-file
Diff commits, Claude/Codex inert transcript import, restart/deduplication, and a fresh-session
continuation with a bounded reference. Scoped MCP configuration reaches real tools/widgets
through explicit project/backend snapshots, with safeStorage references for API-owned secrets.

Phase 8 adds cross-session Tasks, durable Inbox/read badges and notification deduplication,
Usage totals with known/unknown prices, and persisted automations. A run selects the agent's
current validated configuration and creates a fresh session through normal dispatch. Runs do
not overlap. Keep capygen or its tray process running; missed occurrences are skipped after a
restart. Pause stops future occurrences; cancel an active run before deleting its automation.

Final gate: all package/test typechecks passed; 144 unit files, 1883 tests passed and four
skipped; renderer/desktop build passed; Playwright 46 passed and 12 skipped in 1.4 minutes.
Native activity acceptance uses an actual minute timer and isolated profiles, with no model
calls. Dedicated authenticated live checks remain skipped and are not counted as passes.
Literal tails are in PROJECT_LOG.md; screenshots are under e2e-out/activity and e2e-out/imports.

Known limits: Claude 2.1.263 has no persistent user/local server disable flag or server cwd;
those edits fail before mutation. Project .mcp.json approval toggles and HTTP headers work.
Packaging/SDK smoke belongs to Phase 12; live benchmark proof belongs to Phase 11. Custom Mode
9C remains specified, not implemented. No future-phase requirement has been silently dropped.
Preserve the unrelated untracked state.lock. AGENTS.md records the new main-branch policy.

## State

| Phase | Status | Proof |
|---|---|---|
| 1 Engine spike (Claude SDK, Codex app-server) | ✅ | `docs/spikes/engine.md`, `corepack pnpm spike` |
| 2 Walking skeleton + brand | ✅ | `tests/e2e/launch.spec.ts`, `skeleton.spec.ts` |
| 3 Harness layer (Claude, Codex, API models, tools, MCP client, MCP Apps widgets, cards) | ✅ | `harnesses.spec.ts`, `widget.spec.ts`, `docs/spikes/mcp-apps.md` |
| 4 Round-table, hop cap, sub-agent routing + delegation, agents pane | ✅ | `roundtable.spec.ts`, ADR-0004 |
| 5 Dockable workspace panes + dev servers | ✅ | `workspace.spec.ts`, ADR-0005 |
| 6 Settings hub, two-way config sync, prerequisites | ✅ | `settings.spec.ts` |
| 7 Projects/worktrees/imports | accepted | `worktrees.spec.ts`, `imports.spec.ts`, scoped MCP fixture |
| 8 Tasks/Inbox/Usage/Automations | accepted | `activity.spec.ts`, scheduler/Inbox/usage suites |
| 9, 9C | accepted | Native full gates recorded above |
| 10–12 | implementation advanced; live acceptance open | `PLAN.md`, focused checks and packaged smoke above |

Historical gate on parent revision `2222cd6` (2026-09-06; handoff committed as `067a7dc`): typecheck 5/5 packages;
vitest 99 files, 1296 passed, 4 skipped; build ok; Playwright 24 passed, 10 skipped. The skips
are every live-Claude test (Claude Code's OAuth session on this machine is expired — `claude -p
"say ok"` answers "OAuth session expired"; run `claude` in a terminal to sign in, then they run
again) and the API-key case (no key stored). With Claude signed in, the previous runs were
16/16 live tests green.

## How to run

```
corepack pnpm install
corepack pnpm dev                    # Vite + Electron
corepack pnpm build && corepack pnpm start
corepack pnpm typecheck && corepack pnpm test
corepack pnpm exec playwright test   # e2e; live tests spend cents, skip when a backend is not signed in
corepack pnpm spike                  # engine capability proof (regression check on SDK upgrades)
```
Details, env flags and troubleshooting: `docs/RUN.md`. Data: `%APPDATA%\capygen\capygen.db`,
logs in `%APPDATA%\capygen\logs`. Isolated e2e homes: `CAPYGEN_CLAUDE_CONFIG_DIR`,
`CAPYGEN_CODEX_HOME`, `--user-data-dir`.

## How a phase was run (repeat for 7–12)

`.claude/workflows/phase{2..6}-*.js` are the exact orchestration scripts: a contracts task, 3–4
parallel build tasks with strict file ownership, an integration task that writes the phase's
e2e and runs the full gate, then a four-lens review wave (correctness, security, UX parity vs
`reference/omnigent`, efficiency) on a different model, then a fix task. Copy the shape; keep the
"Done when" from `PLAN.md` as the integration target; commit per task by path.

## Revert

Every task is one commit on `main` (52+ commits, linear). `git log --oneline` names them
"Phase N: …". To back out a phase: `git revert <range>` newest-first; migrations are forward-only
numbered SQL. For a schema rollback, close the app and preserve the current database and
its sidecars, then restore a verified compatible pre-migration backup together with the matching
app revision. Do not delete the user's database as a default revert step.
No pushes were made; origin is not configured.

## Open items (carry into Phases 7–12)

- At the Phase 6 handoff Claude sign-in was expired. The user later reauthenticated the
  review worker; isolated app test homes still have no login. API key never stored, so the `api`
  backend has never made a real call — the live e2e unskips when a key is set in Settings ▸ API
  keys. `api` model list is curated; prices `[assumed 2026-09-06]`.
- Codex dynamic client-tool support is implemented and a bundled 0.153.4 loopback proof
  confirms call/reply and tool restoration across process restart (202fe4d). Desktop
  delegation wiring is in progress; live model choice remains unproved. The old claim
  that config.toml is the only path was disproved; no personal config registration is needed.
- Codex cost is estimated (tokens only from app-server); Codex sub-agent blocks carry no cost.
- `harness.list` spawns a Codex probe child every 60 s of use; TTL/refresh button if it shows.
- Dev-server preferences are unimplemented (no `GlobalSettings.devServers` yet); the inactive
  localStorage controls were removed by `2222cd6`;
  `PrereqsSection`/`PrereqPanel` duplicated; `import`/`updates`/`members`/`policies`/`sharing`
  sections are reference-layout placeholders until Phases 7/9/12.
- Live e2e flake: cross-backend delegation depends on the lead choosing `delegate_task`; harden
  or assert on the routed policy.
- Per-harness avatar glyphs (deferred low finding); Codex `collabAgentToolCall` nested activity
  is summarised, not rendered as nested blocks.
- Phase 12 packaging must ship `@openai/codex-sdk` (direct desktop dependency, see
  `packages/engine/src/codex/binary.ts`) and `node-pty` prebuilds (ADR-0005, `asarUnpack`).
- Higgsfield / claude.ai proxy connectors expose no MCP App UI; they render through the rich
  fallback card by design (`docs/spikes/mcp-apps.md`).

## Where things are

`SPEC.md` (R1–R32, P1–P20) · `PLAN.md` (phases, assumptions A1–A14, crew) · `CONTEXT.md` ·
`docs/POLICIES.md` · `docs/adr/0001–0005` · `COMPAT.md` · `docs/RUN.md` · `docs/spikes/*` ·
`PROJECT_LOG.md` (per-task entries with command output) · `e2e-out/*.png` (latest screenshots).

## Historical Astra review addendum — 2026-09-06

See `docs/reviews/phase1-6.md` for recovered session provenance and confirmed open findings.
See `docs/plans/phases7-12.md` for the corrective prerequisite batch and next-phase briefs.
The current crew is Astra low (lead/orchestrator/design/final decisions) / Sol medium
(hard+medium work and core-decision challenge) / Luna medium (easy work); Astra decides core issues.
Initial Claude dispatches failed; after reauthentication Opus reviewed the findings and Fable
debated the plan in two rounds. Four runtime findings remain open corrective tasks.
Phases 7–12 are not implemented or newly accepted by this review.

## Earlier continuation checkpoint — 2026-09-07

On `review/phase7-preparation`, P1-A canonical settings, captured runtime config,
provider/model selection and restart corrections pass the full native gate:
119 unit files, 1734 passed / 4 skipped; build and typecheck clean; Playwright
43 passed / 12 skipped. The latest output tails are in `PROJECT_LOG.md`.
The parser, bounded continuation formatter, utility-process worker, staging client, DB import
store, import IPC and read-only UI are implemented in the current checkout. The native picker
creates an opaque preview handle; commit consumes that handle into an immutable paginated
historical session, and continuation creates a fresh session with a bounded quoted reference.
Worker jobs use owned homes and an inert project directory, and renderer IPC never receives the
transcript during preview.

Scoped MCP runtime resolution is also wired: explicit project scope, backend precedence and
disabled-name shadowing are shared by settings and harness dispatch; API-owned secrets resolve
through main-process safeStorage references. Worktrees were subsequently accepted by the final gate above. Packaged SDK-resolution
verification remains pending. Live benchmark evidence belongs to Phase 11 and awaits dedicated authenticated test homes.

Claude MCP compatibility follows the installed runtime rather than the generic editor shape.
Claude 2.1.263 and its pinned Agent SDK do not support a per-server `cwd` or a persistent disabled
flag for user/local servers, so those mutations are rejected before Claude's remove/add update can
touch the existing row. HTTP/SSE headers use Claude's native `--header` option. Project `.mcp.json`
servers remain switchable through Claude's `enabledMcpjsonServers` / `disabledMcpjsonServers`
approval lists in `.claude/settings.local.json`.

The following notes are from an earlier, superseded checkpoint. At the current checkpoint,
Custom Mode is accepted (see the current-work summary above); retain this paragraph only as
historical context for the pre-acceptance state.
Mascots remain static sharp PNGs. Live app prompts must use Luna low or Sonnet 5
low, with dedicated test homes; the skipped live proofs are not completion.
Opus/Fable hit the Claude session limit at approximately 02:35 Lisbon, with reset
reported at 04:50. Final worker delta review by Fable remains unavailable; Astra
reviewed the worker changes and Luna independently reviewed the small root fixes.
No push had been made at that earlier checkpoint. The final Phase 8 promotion follows the later user instruction. Preserve the unrelated untracked `state.lock`.

## Earlier import/MCP implementation checkpoint — 2026-09-07

Evidence from the current tree:

```text
e2e-out/import-build.log                 renderer + desktop build; importWorker.cjs emitted
e2e-out/import-integrated-typecheck.log  shared/db/engine/desktop/renderer typecheck passed
e2e-out/import-shell-tests.log            3 files, 33 tests passed (renderer import/UI shell)
e2e-out/import-provider-green.log        ImportedTranscript provider guard: 3 tests passed
e2e-out/mcp-root-review.log               5 focused files, 113 tests passed
```

The native import e2e has one verified pass including restart/deduplication, unchanged source hash
and the 380px screenshot. These
checks preceded the final Phase 7–8 acceptance gate above. Packaged SDK smoke remains Phase 12 work, and Phase 11 live benchmark evidence awaits dedicated authenticated homes.


## Superseded Phase 9 work-in-progress checkpoint

Reviewed commits on main: share bundle contract `5f72db8`, atomic share storage `c7f23fd`,
Codex dynamic bridge `202fe4d`, informational MCP menu presentation `c5fbb85`.
The independently verified local Hosts page is `da9e27a` (Phase 10 subtask only).
Share codec is reviewed at `13d8ff8` (44 focused tests). Codex desktop delegation and its
routing UI are now reviewed (114 engine/desktop plus five renderer focused tests); native
dynamic-call blocks retain full-output references, and declaration changes start a fresh
thread with a bounded inert prose reference. Live model choice remains unproved.
At that earlier checkpoint no new phase was accepted. Sharing IPC/UI, runtime policies/members/approvals and session MCP
catalogue integration were in progress. RoundTable's existing whole-history block read
is a known efficiency follow-up; delegation continuity itself now reads only bounded prose.
Migration 0010 and the local policy service are reviewed (86 focused tests): separate local
profiles/rules/audit, per-agent boundaries, exact in-memory grants and cancellation-safe
approval validation. Management IPC and actual harness/widget/automation enforcement remain
pending. Do not confuse the accepted service with runtime policy coverage.

Runtime policy design is ADR-0007; execution ownership/migration allocation is in
`docs/plans/phase9.md`. ADR-0008 is a proposal for later dictation/extensions, not an
accepted implementation. The current Windows machine enumerates an en-GB offline
recognizer; microphone/accuracy tests remain pending. Font provenance is now documented
from the embedded CC0 notice in `docs/font-provenance.md`; packaged asset verification
remains Phase 12 work. Static PNG mascots remain the accepted asset behavior.
## Superseded 9C/10 handoff — 2026-09-08

At that checkpoint Custom Mode remained unaccepted and its full gate was pending. Native 9C custom-mode and runtime
diagram/restart checks passed (one test each); paired Codex spawn evidence is limited to definitions
and local observations, with resume unit-tested only. Dictation’s C# helper compiled/probed without a
microphone for en-GB and 17 focused tests passed; real microphone behavior remains pending.

Extension backend (7), host (1), and UI (1) focused tests passed; native extension verification has
not run. Session summaries use authoritative unread/provisional/worktree values and otherwise `null`.
Cross-extension page navigation is intentional: the target receives a fresh instance and target grants.
