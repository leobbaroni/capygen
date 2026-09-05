# capygen — COMPAT

Every external CLI/SDK contract capygen depends on at runtime, the version it was verified
against, what breaks if the contract moves, and the fallback. Update this file with any new
command, endpoint or SDK member the app starts to rely on (CLAUDE.md).

Verified on: Windows 10 Pro 19045 · Node 22.16 · Electron 44.2.0 (Node 24.20.0) · pnpm 11.15.1.

## Claude Code — `@anthropic-ai/claude-agent-sdk`

| Item | Pinned / verified | Used by | If it changes |
|---|---|---|---|
| package version | `0.3.261` (bundles Claude Code `2.1.261`) | `packages/engine/src/claude/*` | re-run `corepack pnpm --dir packages/engine live:claude` and `corepack pnpm spike` |
| `query({ prompt, options })` | `sdk.d.ts:2953-2956` | `ClaudeHarness.ensureQuery` | the harness's only entry point; a signature change is a compile error |
| streaming input (`prompt: AsyncIterable<SDKUserMessage>`) | verified live 2026-09-06 | one backend session per agent (SPEC R24) | fall back to one `query()` per turn with `options.resume`; costs a cold prefix per turn |
| `Options.env` **replaces** the child env | `sdk.d.ts:1525-1527` | `packages/engine/src/env.ts` builds a complete env | if it became a patch, `cleanEnv` would still be correct, just redundant |
| `Options.settingSources: ['user','project']` | `sdk.d.ts:2085` | loads the user's `~/.claude` settings, skills, plugins, MCP servers and hooks (SPEC R7) | drop to `[]` for isolation; the slash menu then only has built-ins |
| `Options.model` passed explicitly | spike §6 warning 4 | the account default is `claude-opus-5[1m]`, the user's settings say `sonnet` | never rely on the default |
| `Options.includePartialMessages` → `stream_event` | `sdk.d.ts:1725` / `:4826-4844` | text/thinking deltas | without it the harness still works — the settled `assistant` message carries the same text |
| `canUseTool` → `PermissionResult` | `sdk.d.ts:209-269`, `:2339-2351` | permission cards + AskUserQuestion (SPEC R27) | see the AskUserQuestion row |
| `AskUserQuestion` answered via `{behavior:'allow', updatedInput:{...input, answers}}` | `sdk-tools.d.ts:2575-2577`, verified in the spike | `ClaudeHarness.onCanUseTool` | if the field moves, the question card stops round-tripping; the deny path still protects the user |
| `AskUserQuestion` reaches `canUseTool` even under `bypassPermissions` | spike §8.5 | question cards in every permission mode | ordinary tools do **not**: they need `permissionMode: 'default'`/`'auto'` |
| the same `AskUserQuestion` call *also* arrives on the stream as `tool_use` + `tool_result`, under the id `canUseTool` gave as `toolUseID` | verified live 2026-09-06 (`tests/e2e/skeleton.spec.ts`) | `ClaudeHarness` `INTERACTION_TOOLS`: those frames are dropped so the question card is not shadowed by a raw tool-call card | if the ids stopped matching, the transcript would show the question card *and* a duplicate `AskUserQuestion` tool card — cosmetic, not a data loss |
| `PreToolUse` hook matcher must be `'Task\|Agent'` | spike §8.6 — `init.tools` says `Task`, the wire name is `Agent` | sub-agent blocks + routing policy (SPEC R12) | a matcher of `'Task'` alone silently never fires |
| `hookSpecificOutput.updatedInput.model` steers a sub-agent | spike §8.9, `sdk.d.ts:2577-2583` | routing policy (stubbed; the lever is wired) | fallback: deny the Task/Agent call and re-issue the work as a fresh `query()` with `options.model` |
| `result` is the turn boundary, one per turn | `sdk.d.ts:5000-5003` | turn status + usage | a second `result` per turn would double-count usage |
| `result.modelUsage` is **cumulative** in a streaming session | `sdk.d.ts:5036-5039` | per-turn usage is the delta (`deltaUsage`) | if it became per-turn, every turn after the first would under-report |
| `result.usage` is main-loop only | `sdk.d.ts:5032-5035` | fallback when `modelUsage` is empty (local slash commands) | — |
| `Query.interrupt()` | `sdk.d.ts:2615`, streaming input only | `chat.interrupt` | the harness still ends the turn after `interruptGraceMs` (5 s) |
| `system/init.slash_commands` / `.skills` / `.plugins` | `sdk.d.ts:5148-5208` | the slash menu (R14) | fallback: build the list from `~/.claude/commands`, `<repo>/.claude`, `installed_plugins.json` |
| slash commands are plain prompt text | spike §3 | `chat.send` passes the text through unchanged | — |
| ESM-only package, loaded with a runtime `import()` | `package.json` `"type": "module"` | `packages/engine/src/claude/sdk.ts` | it is **external** to the esbuild bundle (`apps/desktop/scripts/build.ts`): the SDK finds its bundled `claude.exe` through `createRequire(import.meta.url)`, which an inlined copy could not do. Verified inside Electron 44 (`node=24.20.0`, `query=function`) |
| SDK spawns the child with `windowsHide: true` | grep of `sdk.mjs` | no console flash on Windows | if it regresses, pass `Options.spawnClaudeCodeProcess` |

Sign-in: claude.ai OAuth (`init.apiKeySource: "none"`). No API key is read or stored by the Claude
harness.

## Codex — `codex app-server` / `@openai/codex-sdk`

Not wired yet (Phase 3). Shapes and the current sign-in failure are recorded in
`docs/spikes/codex-shapes.md` and `docs/spikes/engine.md` §5.

## Internal seams

| Seam | Meaning |
|---|---|
| `CAPYGEN_ENGINE=stub` | run the offline echo engine instead of a real backend (the e2e suite sets it) |
| `CAPYGEN_USER_DATA_DIR` | isolated Electron profile |
| `CAPYGEN_PROJECT_DIR` / `--project=<dir>` | pre-select a project folder |
| `CAPYGEN_DEV_URL` | load the renderer from Vite |
