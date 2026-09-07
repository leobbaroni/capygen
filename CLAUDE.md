# capygen — agent instructions (Claude side)

The project lead from Phase 7 on is **GPT-6-Astra (Codex), low**; its instructions live in `AGENTS.md`
and are the source of truth for both CLIs. **GPT-5.6-Sol (medium)** handles hard/medium tasks and
substantive reviews; **GPT-5.6-Luna (medium)** handles easy tasks. **GPT-5.6-Sol** challenges core
decisions, frameworks and architecture with Astra. Astra owns orchestration, design and final decisions. Read `AGENTS.md`,
then `SPEC.md` (contract), `PLAN.md` (build order, assumptions, crew), `CONTEXT.md` (terms),
`docs/POLICIES.md` (app policies), `docs/HANDOFF.md` (state and how to run a phase).

- **Branch and push policy (user update, 2026-09-07):** after Phase 8 acceptance,
  work on `main` and push verified updates to `origin/main`; never force-push.
  Stop this run after Phase 8. Only one agent may stage/commit at a time; never
  amend another agent's commit.
- **Never install anything silently** on the user's machine from the app: every install/upgrade
  step confirms the exact command in a dialog and runs in a visible console.
- **Never modify the real user configuration** (`~/.claude/**`, `~/.codex/**`) from tests or
  probes; use `CLAUDE_CONFIG_DIR` / `CODEX_HOME` isolated homes (the app honours
  `CAPYGEN_CLAUDE_CONFIG_DIR` / `CAPYGEN_CODEX_HOME`).
- **Reference is read-only:** `reference/omnigent/` is Omnigent (Apache-2.0) kept for layout,
  behaviour and API shapes. Never import it at runtime; reuse CSS tokens verbatim with NOTICE.
- **Efficiency is a requirement** (SPEC R23–R26): no per-turn system-prompt churn, cache-friendly
  request shapes, lazy MCP schemas, truncated tool outputs, live usage meters.
- **Windows-first:** spawn children with `windowsHide` and UTF-8 env; paths may contain spaces
  and non-ASCII; long paths are real.
- **Secrets:** never log or write API keys; use Electron `safeStorage`; refer to keys as
  `${ANTHROPIC_API_KEY}` etc. in docs.
- **Tests:** `corepack pnpm typecheck`, `corepack pnpm test` (vitest), `corepack pnpm build`,
  `corepack pnpm exec playwright test` (Electron e2e; live tests spend cents and skip when a
  backend is not signed in), `corepack pnpm spike` (engine capability proof).
- **Every change:** restate the ask, name the files, touch only those, run the check, append one
  line to `PROJECT_LOG.md`. Keep `COMPAT.md` in sync with any CLI/SDK contract the app relies on.
- **Review protocol:** findings ranked by severity, each anchored to `file:line` with the concrete
  inputs → wrong outcome; verify against the actual code path before reporting; no style nits.
- Mascot: a real capybara face (bead eyes, blunt muzzle, ears, yuzu slice on the head, pink
  hoodie with a `>_` badge) — never a visor/screen face; the user rejected the Codex-like look.
