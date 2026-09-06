# ADR 0005 — Terminal pane: `node-pty` 1.1.0, no `@electron/rebuild`

Status: accepted (2026-09-06, Phase 5 / task B1)

Implements the Terminal half of SPEC R16 ("Terminal (node-pty + xterm, the session's cwd)").
This is capygen's **first native module** — ADR-0003 removed the only other candidate by
choosing `node:sqlite` over `better-sqlite3` precisely to avoid a native build step. So the
question this ADR answers is the one PLAN.md §Risks asks of any native dependency: *does it
load under our Electron as shipped, or does it drag a rebuild toolchain into every install?*

## Context

A pseudo-terminal cannot be faked. `child_process.spawn` gives a pipe, not a console: no
ConPTY, so no resize, no ANSI cursor addressing, no interactive prompt — `powershell.exe`
would not even print a prompt. `node-pty` is the only maintained Windows ConPTY binding, and
it is what the design reference uses (Omnigent pairs it with `@xterm/xterm` 6).

`node-pty` 1.1.0 (verified: `npm view`, 2026-09-06) is a native addon:

```
"install":     "node scripts/prebuild.js || node-gyp rebuild",
"postinstall": "node scripts/post-install.js",
"dependencies": { "node-addon-api": "^7.1.0" }
```

`node-addon-api` means **N-API**, and N-API is ABI-stable across Node majors — and therefore
across Electron versions, which is exactly the property `better-sqlite3` (NAN, V8-ABI) lacks.
The 64 MB tarball is 286 files of prebuilds: `prebuilds/{win32-x64,win32-arm64,darwin-x64,
darwin-arm64}`. So the prebuilt binary *should* load in both runtimes with no rebuild. That
had to be measured, not assumed.

## Decision drivers — measured, not assumed

Install took the prebuild path, never `node-gyp` (no compiler on this machine):

```
$ corepack pnpm install
.../node-pty@1.1.0/node_modules/node-pty install$ node scripts/prebuild.js || node-gyp rebuild
.../node-pty@1.1.0/node_modules/node-pty install: > Checking prebuilds...
.../node-pty@1.1.0/node_modules/node-pty install: Done
.../node-pty@1.1.0/node_modules/node-pty postinstall: > Moving conpty.dll...
.../node-pty@1.1.0/node_modules/node-pty postinstall:   Found version 1.23.251008001
.../node-pty@1.1.0/node_modules/node-pty postinstall:   Copying ...\third_party\conpty\1.23.251008001\win10-x64\conpty.dll -> ...\build\Release\conpty\conpty.dll
Done in 5.7s using pnpm v11.15.1
```

Electron 44 main process (a real 30-line probe app — ADR-0003 explains why `electron -e`
cannot be used: Electron treats the first argument as an app path). It requires `node-pty`,
spawns `cmd /c echo capygen-pty-ok` through a pty and reads the output back:

```
$ apps/desktop/node_modules/electron/dist/electron.exe <probe app>
electron=44.2.0 node=24.20.0 modules=149
require(node-pty): ok
spawn: ok pid=4660
exit code=0
saw-marker=true
data-bytes=64
```

The vitest runner (plain Node 22.16, a **different** module ABI):

```
$ node -e "const pty=require('./apps/desktop/node_modules/node-pty'); ..."
node=22.16.0 modules=127 require ok
exit=0 marker=true
```

One installed binary, two ABIs (149 and 127), both fine — which is N-API behaving exactly as
advertised.

## Decision

Use **`node-pty` 1.1.0 as installed. No `@electron/rebuild`, no postinstall rebuild script,
no compiler requirement.**

- `TerminalService` (`apps/desktop/src/workspace/TerminalService.ts`) loads it with a lazy
  `await import("node-pty")`, so a profile that never opens a Terminal pane never loads a
  native module at all, and the `PtySpawner` seam lets every test drive a fake.
- The desktop esbuild bundle keeps `node-pty` **external**
  (`apps/desktop/scripts/build.ts`). This is not about the native file being unbundleable —
  it is that `node-pty/lib/utils.js` resolves its binding with a *relative*
  `require("../build/Release/pty.node")`, walking `build/Release`, `build/Debug`, then
  `prebuilds/<platform>-<arch>`. Inlined into `dist/main.cjs` that require would look next to
  the bundle and find nothing. Verified resolvable from the built bundle's own require.
- ConPTY explicitly (`useConpty: true`), with the `conpty.dll` the post-install step places
  next to the binding — not winpty.

### What Phase 12 packaging must do

1. **`asarUnpack`** `**/node_modules/node-pty/**`. A native `.node` cannot be loaded from
   inside an asar archive, and neither can `conpty.dll` / `OpenConsole.exe` / `winpty.dll`,
   which node-pty launches as *files* rather than loading as modules. electron-builder:

   ```json
   "asarUnpack": ["**/node_modules/node-pty/**"]
   ```

2. **Ship the whole package directory**, not just the `.node`: the loader needs
   `lib/`, `build/Release/conpty/{conpty.dll,OpenConsole.exe}` and
   `prebuilds/win32-<arch>/` intact, because it finds the binding by walking those relative
   paths.
3. **Do not prune the prebuild for the other arch** unless the installer is arch-specific;
   an arm64 build needs `prebuilds/win32-arm64`.
4. No rebuild step in CI. If a future Electron ever *does* refuse the prebuild, the fix is
   `@electron/rebuild` 4.2.0 scoped to this one module
   (`electron-rebuild -f -o node-pty`) as a postinstall — recorded here so the option is
   costed, not discovered.

## Consequences

Good:

- `corepack pnpm install` still needs no compiler; a fresh clone still builds on a bare
  Windows machine (the property ADR-0003 bought, kept).
- An Electron upgrade cannot break the terminal's ABI, only its behaviour.
- The lazy import means the native module is not even loaded until a terminal is opened.

Bad / watch:

- capygen now has a native dependency, so packaging is no longer "copy JS": the `asarUnpack`
  entry above is load-bearing, and a packaged build that skips it fails *only* when a user
  opens the Terminal pane — the worst possible failure mode. Phase 12 must open a terminal
  in the packaged app as an acceptance step, not just launch it.
- The install is 64 MB unpacked, most of it prebuilds for platforms this Windows-only app
  does not ship. It is `node_modules` weight, not installer weight, once (3) prunes.
- `useConpty` needs Windows 10 1809+; SPEC's target is 19045, so this is a non-issue here,
  and node-pty falls back to winpty (also bundled) if ConPTY is unavailable.

## Revisit if

- Electron ships a version whose N-API level the prebuild does not satisfy (then:
  `@electron/rebuild` 4.2.0, scoped, as above), or
- a Terminal pane requirement appears that ConPTY cannot serve (attaching to an *existing*
  console, which is Phase 10's "terminal attach" — a different mechanism, not a pty).
