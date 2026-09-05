# ADR 0003 — SQLite driver: `node:sqlite`, not better-sqlite3

Status: accepted (2026-09-05, Phase 2 / task A1)
Supersedes the storage line in SPEC.md §Key Decisions ("better-sqlite3, one DB at
`%APPDATA%\capygen\capygen.db`"). The location is unchanged; only the driver moves.

## Context

SPEC.md picked `better-sqlite3` as an assumption ("[assumed: default]") and PLAN.md §Risks
flagged the cost: `better-sqlite3` is a native addon, so every Electron upgrade needs
`@electron/rebuild`, the module must be unpacked from the asar, and CI needs a toolchain.
PLAN.md Phase 2 says to verify the native build "before anything depends on it".

Node 22.5 added the built-in `node:sqlite` module (`DatabaseSync`), which is compiled into the
Node binary — and therefore into Electron's. If Electron 44 exposes it, the whole native-build
risk disappears.

## Decision drivers — measured, not assumed

Electron main process (the process that owns the DB):

```
$ & apps/desktop/node_modules/electron/dist/electron.exe <probe app>
44.2.0 24.20.0 node:sqlite ok DatabaseSync roundtrip={"a":42}
```

(The probe app is a 12-line `main.cjs` that `require("node:sqlite")`, creates an in-memory
`DatabaseSync`, runs `CREATE TABLE` / `INSERT` / `SELECT`, then `app.quit()`s. Passing the same
expression to `electron -e` does not work — Electron treats the first argument as an app path and
never evaluates it — which is why the check is a real app directory.)

The vitest runner (Node 22.16.0, no flag):

```
$ node -e "const s=require('node:sqlite'); new s.DatabaseSync(':memory:') ..."
node22 plain: ok
```

So the same code path works unflagged in both runtimes we care about.

## Decision

Use **`node:sqlite` (`DatabaseSync`)** as capygen's only SQLite driver.

- No `better-sqlite3`, no `@electron/rebuild`, no `asarUnpack`, no per-Electron-version rebuild
  step in CI or in the user's install.
- `packages/db` wraps `DatabaseSync` behind a tiny `Database` facade (`exec`, `get`, `all`,
  `run`, `transaction`, `close`) so the driver stays swappable.
- The DB is opened only in the Electron **main** process (`%APPDATA%\capygen\capygen.db`) and in
  tests (temp files). Renderers never touch it; they go through the typed IPC contract.
- `PRAGMA journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000` on open.

## Consequences

Good:
- `corepack pnpm install` needs no compiler; a fresh clone builds on a bare Windows machine.
- Electron upgrades cannot break the storage layer's ABI.
- The synchronous API is the same shape `better-sqlite3` has, so repositories read the same.

Bad / watch:
- `node:sqlite` is marked *experimental* in Node's docs; the API can change between majors.
  Mitigation: the `Database` facade in `packages/db/src/driver.ts` is the only file that names
  it, and the repositories are covered by tests, so a swap back to `better-sqlite3` is a
  one-file change plus a rebuild step.
- No `Database.prototype.backup()`. The migrator therefore takes its pre-migration backup with a
  plain file copy **before the file is opened** (see `packages/db/src/migrate.ts`), which is
  correct precisely because nothing holds the file yet.
- Node 22 prints an `ExperimentalWarning` under `--experimental-sqlite`; unflagged Node 22.16 and
  Electron 44 do not.

## Revisit if

- `node:sqlite` is missing or broken in an Electron version we want to ship, or
- we need an extension (FTS5 via a loadable extension, sqlite-vec) that `node:sqlite` will not
  load. Then: add `better-sqlite3` + `@electron/rebuild`, keep the facade, keep the schema.
