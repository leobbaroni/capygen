# capygen

A native-Windows desktop app for working with Claude Code, Codex and API models side by side:
Omnigent's UI and features, no server to connect to, dockable panes, one-click dev servers, and
in-app management of harnesses, MCP servers, skills and plugins.

Status: in development — Phase 2 done (landing → live Claude reply → persisted across a
relaunch). See `SPEC.md` (contract), `PLAN.md` (build order), `CONTEXT.md` (glossary),
`PROJECT_LOG.md` (what happened), `docs/RUN.md` (how to dev/build/test/e2e), `COMPAT.md`
(external contracts).

Design and behaviour reference: Omnigent (Apache-2.0), vendored read-only under
`reference/omnigent/` with its NOTICE. capygen reuses its CSS tokens verbatim (see
`apps/renderer/src/themePalettes.generated.css`) and never imports its code at runtime.

## Layout

```
apps/desktop/     Electron main + preload (TypeScript, bundled with esbuild → dist/*.cjs)
apps/renderer/    Vite 8 + React 18 + Tailwind 4 + shadcn/ui (the SPA)
packages/shared/  domain types, zod schemas, the typed IPC contract (`defineIpc`)
packages/db/      SQLite schema, numbered migrations, repositories
packages/engine/  harnesses — Claude (SDK) today, Codex/API in Phase 3; spikes in its scripts/
assets/           mascot states, wordmark font — the source of truth for brand assets
docs/adr/         decisions   docs/spikes/   capability proofs
```

## Commands

All package-manager calls go through corepack; bare `pnpm` is not on PATH here.

| Command | What it does |
|---|---|
| `corepack pnpm install` | install the workspace |
| `corepack pnpm dev` | build main+preload, start Vite, launch Electron against it |
| `corepack pnpm build` | renderer `vite build`, then main+preload with esbuild |
| `corepack pnpm start` | launch Electron on the built output |
| `corepack pnpm test` | vitest across the workspace |
| `corepack pnpm typecheck` | `tsc --noEmit` per package, plus the e2e specs |
| `corepack pnpm e2e` | build, then Playwright against the real Electron app |
| `corepack pnpm spike` | Phase 1 engine capability proof |

`corepack pnpm build` must run before `start` or `e2e:only`: Electron's entry point is
`apps/desktop/dist/main.cjs`, not the TypeScript. `pnpm e2e` runs two suites —
`tests/e2e/launch.spec.ts` offline against the echo double, and `tests/e2e/skeleton.spec.ts`
against the real Claude backend (**real model calls, real money**). Details in `docs/RUN.md`.

## Environment variables

| Variable | Effect |
|---|---|
| `CAPYGEN_DEV_URL` | load the renderer from this URL instead of the built `index.html`. Set by `pnpm dev`. |
| `CAPYGEN_USER_DATA_DIR` | override Electron's userData dir (database, logs, window state). Used by the e2e harness for an isolated profile. |
| `CAPYGEN_PROJECT_DIR` | pre-select a project folder at launch, so the landing page can start a session without the folder picker. Same as `--project=<dir>`. |

Nothing is opened implicitly: with neither `--project` nor `CAPYGEN_PROJECT_DIR` set, the landing
page shows "Choose a folder" and the native picker runs before the first turn.

## Where things live at runtime

```
%APPDATA%\capygen\capygen.db                    SQLite (node:sqlite — see docs/adr/0003)
%APPDATA%\capygen\capygen.db.backup-<ts>.db     written before any pending migration
%APPDATA%\capygen\logs\capygen-desktop.log      rotating, secret-redacting (2 MB × 5)
```
