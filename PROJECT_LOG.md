# PROJECT_LOG.md

## 2026-09-05 — Kickoff (plan)
- Grilling interview (6 questions): TypeScript rewrite; Claude + Codex + API models; round-table
  + solo modes with routed sub-agents; full Omnigent parity as v1 (staged M1–M7); SDK-first
  engine; name capygen, pixel capybara mascot, CheGuevaraBarry-Brown wordmark; efficiency
  requirement. See PLAN.md §Interview Ledger.
- Wrote SPEC.md, PLAN.md, CONTEXT.md, ADR-0001/0002, CLAUDE.md. Vendored Omnigent
  `main@44378d6` SPA sources + server routes + openapi + docs under `reference/omnigent/`
  (Apache-2.0, NOTICE kept). Copied the wordmark font to `assets/fonts/`.
- Machine: Claude Code 2.1.261 and Codex CLI 0.139.0 signed in natively; no API keys in env.

- Phase 1 / Codex spike: `packages/engine/scripts/spike-codex.ts` + `docs/spikes/codex-shapes.md` (SDK 0.153.4 `.d.ts`, app-server JSON-RPC bindings generated under `docs/spikes/codex-app-server-schema/`). app-server handshake/thread/turn/discovery proven on the wire; every model call fails with `codexErrorInfo:"unauthorized"` because the ChatGPT refresh token in `~/.codex/auth.json` is invalid (failing since 2026-09-03 per the Codex log DB) — user must run `codex logout` + `codex login`, then re-run `corepack pnpm --dir packages/engine exec tsx scripts/spike-codex.ts`. SDK has no approval hook (PARTIAL by design); codex 0.153.4 `exec` rejects `approval_policy="untrusted"`.
- Phase 1 consolidation: `packages/engine/scripts/spike-engine.ts` runs both probes as tsx children behind `corepack pnpm spike` (root script now `corepack pnpm --filter …` — bare `pnpm` is not on PATH under corepack) and printed `SPIKE 8 PASS, 1 PARTIAL, 4 FAIL` (Claude 7/7 PASS in 89 s; Codex: discovery PASS, SDK approval PARTIAL by design, auth/turn/approval FAIL on the dead ChatGPT sign-in). Table, shapes index, usage and per-capability fallbacks: `docs/spikes/engine.md`. PLAN.md Phase 1 stays unchecked until `codex login` + `corepack pnpm spike --only codex`.

## 2026-09-05 — Phase 1: engine spike
- Phase 1 (Claude half): `packages/engine/scripts/spike-claude.ts` proves, headless against the signed-in Claude Code 2.1.261 via `@anthropic-ai/claude-agent-sdk` 0.3.261: stream text, system init (92 slash commands incl. `cockpit:pilot`, 3 plugins, 56 skills), `/context` (structured `context_usage`), `/cockpit:pilot` executed, AskUserQuestion answered through `canUseTool.updatedInput.answers`, PreToolUse hook on the subagent tool (fires as `tool_name: 'Agent'`), usage/cost on every result. All 7 CAP lines PASS. Shapes + citations: `docs/spikes/claude-sdk-shapes.md`; raw stream: `docs/spikes/claude.raw.json` (gitignored).
- Adversarial verify (Opus): all 7 Claude capabilities reproduced live; Codex blocked only by the dead ChatGPT refresh token. Refuted gates to tighten: plugin_command PASS predicate (matches "phase|plan" text, not the expansion), usage gate accepts all-zero, PreToolUse routing lever (updatedInput/permissionDecision) unproven; ~24 `.d.ts` line citations off; raw evidence gitignored/overwritten. Follow-ups tracked in Phase 2 workflow (spike-fixes task).
- Mascot v2 (real capybara face, yuzu, pink hoodie) replaced the visor version at the user's request; crew rule recorded (Fable orchestrates; Opus 5 hard / Sonnet 5 mechanical).
- Kept only `docs/spikes/codex-app-server-schema/v0.153.4-ts` (1.8 MB); JSON bundles and 0.139.0 bindings gitignored/removed.

## Open / next
- USER ACTION: Codex sign-in is dead (`invalid_refresh_token` since 2026-09-03). Run `codex logout` then `codex login` in a terminal, then `corepack pnpm spike` should show the 4 Codex FAILs turn PASS. Phase 1 stays unchecked until then; Phase 2 proceeds on Claude.
- Phase 2: walking skeleton app + brand (workflow).
