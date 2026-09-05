# capygen — agent instructions

Read `SPEC.md` (contract), `PLAN.md` (build order, assumptions), `CONTEXT.md` (terms) first.

- **Push policy:** commit locally as you go; push only when the user asks; never force-push.
- **Never install anything silently** on the user's machine from the app: every install/upgrade
  step confirms the exact command in a dialog and runs in a visible console.
- **Reference is read-only:** `reference/omnigent/` is Omnigent (Apache-2.0) kept for layout,
  behaviour and API shapes. Never import it at runtime; reuse CSS tokens verbatim with NOTICE.
- **Efficiency is a requirement** (SPEC R23–R26): no per-turn system-prompt churn, cache-friendly
  request shapes, lazy MCP schemas, truncated tool outputs, live usage meters.
- **Windows-first:** spawn children with `windowsHide` and UTF-8 env; paths may contain spaces
  and non-ASCII; long paths are real.
- **Secrets:** never log or write API keys; use Electron `safeStorage`; refer to keys as
  `${ANTHROPIC_API_KEY}` etc. in docs.
- **Tests:** `corepack pnpm test` (vitest), `corepack pnpm e2e` (Playwright Electron),
  `corepack pnpm spike` (engine capability proof). Build: `corepack pnpm build:win`.
- **Every change:** restate the ask, name the files, touch only those, run the check, append one
  line to `PROJECT_LOG.md`. Keep `COMPAT.md` in sync with any CLI/SDK contract the app relies on.
- Crew for orchestrated batches is recorded in `PLAN.md` §Crew.
