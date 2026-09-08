# capygen

A native-Windows desktop app for working with Claude Code, Codex and API models side by side:
Omnigent's UI and features, no server to connect to, dockable panes, one-click dev servers, and
in-app management of harnesses, MCP servers, skills and plugins.

Status: Phases 1–11 and 9C are accepted. Local microphone transcription works, extension pages
are available under Tools → App pages, and the full efficiency cohort passed at 102.25% of the
CLI baseline. Phase 12 awaits full CI, release publication and the older-build private updater
check. See `SPEC.md` (contract), `PLAN.md` (build order), `CONTEXT.md` (glossary),
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
packages/engine/  Claude/Codex/API harnesses, routing, tools, MCP and round-table runtime
assets/           static PNG mascot states, wordmark font — the source of truth for brand assets
docs/adr/         decisions   docs/spikes/   capability proofs
```

## Commands

All package-manager calls go through corepack; bare `pnpm` is not on PATH here.

| Command | What it does |
|---|---|
| `corepack pnpm install` | install the workspace |
| `corepack pnpm dev` | build main+preload, start Vite, launch Electron against it |
| `corepack pnpm build` | renderer `vite build`, then main+preload with esbuild |
| `corepack pnpm build:win` | build and stage the Windows x64 runtime, then produce local installer/portable artifacts |
| `corepack pnpm package:win` | package the staged Windows runtime and audit its required files/checksums |
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

Local Windows packages are currently about 268 MiB per artifact and are unsigned. They are written
under `release/artifacts/` as `capygen-<version>-setup.exe`, `capygen-<version>-portable.exe`,
`latest.yml`, and `artifact-audit.json`; no published release is claimed.

## Where things live at runtime

```
%APPDATA%\capygen\capygen.db                    SQLite (node:sqlite — see docs/adr/0003)
%APPDATA%\capygen\capygen.db.backup-<ts>.db     written before any pending migration
%APPDATA%\capygen\logs\capygen-desktop.log      rotating, secret-redacting (2 MB × 5)
```
