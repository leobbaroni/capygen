# capygen — how to run it

The operational companion to `README.md`. Everything below was run on this machine
(Windows 10 Pro 19045 · Node 22.16 · pnpm 11.15.1 via corepack · Electron 44.2.0).

Two rules that cause most of the confusion:

- **Always `corepack pnpm`, never bare `pnpm`.** Bare `pnpm` is not on PATH under corepack;
  the root scripts call `corepack pnpm …` internally for the same reason.
- **Build before you run.** Electron's entry point is `apps/desktop/dist/main.cjs`, not the
  TypeScript. `start` and `e2e:only` do not build for you; `dev` and `e2e` do.

---

## 0. First time

```sh
corepack pnpm install
```

If `apps/desktop/node_modules/electron/dist` is missing afterwards (pnpm has been seen to skip
Electron's postinstall on a very first install), repair it with:

```sh
node apps/desktop/node_modules/electron/install.js
```

Prerequisites for the *live* paths (unit tests and the offline e2e need none of this):

- Use persistent, separately authenticated test homes supplied explicitly through the environment.
  The live scripts refuse missing, relative, personal, or ancestor paths; they never fall back to
  `~/.claude`/`~/.codex` and never copy credentials. The e2e policy uses the corresponding
  `CAPYGEN_TEST_CLAUDE_HOME` and `CAPYGEN_TEST_CODEX_HOME` variables.
- The live Claude model is `claude-sonnet-5` at low effort; the live Codex model is
  `gpt-5.6-luna` at low reasoning effort. API smoke coverage is Anthropic with
  `claude-sonnet-5` only.

---

## 1. Develop

```sh
corepack pnpm dev
```

`scripts/dev.mts` bundles main+preload, starts Vite on <http://localhost:5273> (which stages the
brand assets first) and launches Electron against it via `CAPYGEN_DEV_URL`. The renderer
hot-reloads; **main-process and preload changes do not** — stop and re-run `dev` after editing
anything under `apps/desktop/src/`.

To open the app on a folder without the picker:

```sh
CAPYGEN_PROJECT_DIR=C:/src/thing corepack pnpm dev
# the packaged exe (Phase 12) will take the same thing as an argument: --project=<dir>
```

Nothing is opened implicitly: with neither set, the landing shows "Choose a folder".

Editing brand assets: change `assets/` (mascot states, wordmark font, icons), never
`apps/renderer/public/`, which is gitignored and re-staged from `assets/` on every `dev`/`build`
by `apps/renderer/scripts/sync-assets.ts`. The window/tray icons take a different route —
`apps/desktop/scripts/build.ts` copies `assets/icons/{tray,icon}.png` into
`apps/desktop/dist/assets/`.

---

## 2. Build

```sh
corepack pnpm build          # renderer (vite) then main+preload (esbuild)
corepack pnpm start          # launch Electron on the built output
```

`build` also copies the two things read from disk at runtime: `packages/db/migrations/*.sql`
into `apps/desktop/dist/migrations`, and the brand icons into `apps/desktop/dist/assets`.
A new migration needs no build change; a new runtime file read by path does.

Packaging (`build:win`, NSIS + portable + updater feed) is implemented for Phase 12. Local
artifact and packaged-smoke checks exist, while older-build updater, private-feed/release and
full Phase 12 acceptance remain open; see the Windows packaging section below.

---

## 3. Test

```sh
corepack pnpm typecheck      # tsc --noEmit per package + tests/tsconfig.json
corepack pnpm test           # vitest, all six projects
```

The vitest projects (`vitest.config.ts`): `shared`, `db`, `engine`, `desktop` (node),
`renderer-brand` (node + `react-dom/server`), `renderer` (jsdom + testing-library).
One project only:

```sh
corepack pnpm exec vitest run --project renderer
```

Nothing in `pnpm test` touches the network, a real model, or the real
`%APPDATA%\capygen` profile.

---

## 4. End-to-end

```sh
corepack pnpm e2e            # build, then all Playwright specs
corepack pnpm e2e:only       # Playwright only — build yourself first
corepack pnpm exec playwright test tests/e2e/launch.spec.ts   # offline only
```

Latest offline worker validation: 43 passed, 12 skipped in 55.6 s; the settings offline subset
reported 9 passes. The skipped cases are policy-gated live coverage, not live-model proof.

Playwright drives the app's own Chromium through `_electron.launch`, so there is no browser to
install. `workers: 1` — Electron windows are singletons per user-data-dir.

| Spec | Engine | Network / cost |
|---|---|---|
| `tests/e2e/launch.spec.ts` | `CAPYGEN_ENGINE=stub` (offline echo double) | none |
| `tests/e2e/skeleton.spec.ts` | the real Claude harness | **real model calls, real money** |
| `tests/e2e/harnesses.spec.ts` | the real Codex, Claude and API harnesses | **real model calls** |
| `tests/e2e/widget.spec.ts` | the real Claude harness + a fixture MCP server | **real model calls** |
| `tests/e2e/roundtable.spec.ts` | four live (Claude + Codex), one offline (`CAPYGEN_ENGINE=stub-roundtable`) | **real model calls** |
| `tests/e2e/workspace.spec.ts` | `CAPYGEN_ENGINE=stub` | none — it spawns a 30-line node http server on 5199, nothing else |
| `tests/e2e/settings.spec.ts` | config-store checks on isolated backend homes | offline checks pass; live cases skip without an explicit dedicated authenticated pair |

`skeleton.spec.ts` is the PLAN Phase 2 proof: landing → live Claude reply with a usage/cost line
→ close → relaunch → same transcript out of SQLite; plus an `AskUserQuestion` card answered in
the UI whose answer reaches the model. Its intended test model is `claude-sonnet-5` at low
effort. These UI-created live turns currently skip before dispatch until the runtime-default
dependency below is implemented, even when a dedicated test identity is supplied.

The pinned low-effort configuration is policy intent; runtime inheritance into every UI-created
turn remains a Phase 7 P1 dependency. The shared policy skips those live sends until runtime
layering and an effective-config assertion exist. An explicit `sessions.create` path with pinned
configuration remains runnable. A skipped turn is not evidence that a live model call succeeded.

`harnesses.spec.ts` is the Phase 3 proof. Each test asks `harness.list` first and **skips with
that backend's own reason** rather than failing on a 401, so a machine with no Codex login still
gets a green run and a sentence saying why:

- Codex picked in the composer answers "pong" with a usage/cost line;
- a Codex shell approval (`approvalPolicy: "untrusted"`, set through the agent's own config so the
  card is guaranteed to appear) renders a permission card whose **Allow once** runs the command;
- `/` in a Claude session lists Built-ins plus what Claude itself reports — on this machine the
  `/cockpit:*` plugin commands;
- the API-model test is Anthropic-only, pinned to `claude-sonnet-5` at low effort; without its
  configured key it skips and says so.

`roundtable.spec.ts` is the Phase 4 proof (SPEC R10-R13, ADR-0002). It skips per backend the
same way `harnesses.spec.ts` does:

- **round table** — a session with `@claude` (Claude Code) and `@codex` (Codex); one message
  mentioning both opens two agent turns *in mention order*, and Codex's review quotes Claude's
  response, which is only possible because the labelled context delta reached it (R23: a stateful
  backend is sent the turns since its own last one, never the transcript again). The two may then
  go on talking to each other — R11 allows that, and the hop cap bounds it — so the test asserts
  on the hop-1 round and interrupts the session before closing;
- **hop cap** — offline, on `CAPYGEN_ENGINE=stub-roundtable`: every echoed reply ends
  `over to @<next agent>`, so two agents would ping-pong forever. The real dispatcher stops them
  at hops 1-2-3, writes one "Chain stopped after 3 hops" system turn, shows the Continue bar, and
  Continue grants exactly one more hop (4) before the cap applies again. A loop bound must not be
  proved with a model that might choose to stop by itself;
- **routed sub-agent** — a solo Claude session pinned to `claude-sonnet-5` at low effort. The
  hook runs and the child can be observed, but parent and child use the same pinned model, so this
  test is partial evidence and does not prove a different-model rewrite. The deterministic hook
  and block-shape coverage remains the place to test routing mechanics without spending a second
  live model budget;
- **cross-backend delegation** — the same lead with `subagentRouting: {backend:"codex"}`: no hook
  can do that, so the lead calls `mcp__capygen__delegate_task` and the block is
  `backend: "codex", delegated: true`;
- **agent info drawer** — after one live turn, the drawer shows the agent's own description, the
  generated usage description, the model, the live tool list and the other agent; the same facts
  are then re-read straight off `agents.describe` so a UI change cannot hide a regression in the
  channel.

`workspace.spec.ts` is the Phase 5 proof (SPEC R16-R18, G5, G6) and is **entirely offline** — no
model, no network, no cost. It is one `test.describe.configure({mode:"serial"})` run against one
profile and one temp project (the `tests/fixtures/servers/node` fixture copied out of the repo,
then `git init` + one commit so the Diff pane has a baseline):

- **(a) Files + Editor** — expand the tree, double-click `src/greeting.txt`, type into CodeMirror,
  Ctrl+S, then assert the *bytes on disk* changed. `fs.list` → `fs.read` → `fs.write` end to end;
- **(b) Diff** — that same edit appears in `git.status` and its unified patch in `git.diff`;
- **(c) Tasks** — a `todo: a, b, c` message makes the echo engine write a real Claude-shaped
  `TodoWrite` tool call, and the broadcast tap in `ipc/handlers.ts` turns it into task rows. No
  model is asked for a plan, which is the point (R26);
- **(d) Terminal** — `echo capy` into a real ConPTY and `capy` back out of **xterm's own buffer**
  (under WebGL there is nothing in the DOM to assert on);
- **(e) Layout** — drag the Terminal tab into the bottom quadrant of the Browser group with the
  mouse, assert two groups, assert the saved `layout.set` row has the same shape, then **restart
  the app on the same profile** and assert the group tree comes back identical (R17, G5);
- **(f) Servers** — the fixture's `dev` script is detected (`npm run dev`, port 5199), Start
  streams its log, discovery reads the `Local: http://…` line it printed, and the Browser pane
  opens it *with nobody clicking anything else* (R18, G6). Both the app's URL bar/title and the
  native view's own `capturePage()` are asserted, because neither process can photograph the other;
- **(g) Overlay tracking** — the `WebContentsView`'s `getBounds()` and the placeholder's
  `getBoundingClientRect()` agree to within 2px through a group maximise and a window resize.

Screenshots: `workspace-layout.png`, `workspace-server.png`, `workspace-server-view.png` (the
native view's own pixels), `workspace-tasks.png`. To run it alone:

```sh
corepack pnpm build && corepack pnpm exec playwright test tests/e2e/workspace.spec.ts
```

Executed cases write screenshots to `e2e-out/`: `landing.png`, `chat.png` (offline),
`chat-pong.png`, `restored.png`, `chat-question.png`, `codex-pong.png`, `codex-permission.png`,
`codex-allowed.png`, `slash-menu.png`, `roundtable.png`, `roundtable-hopcap.png`,
`roundtable-routed-subagent.png`, `roundtable-delegated.png`, `roundtable-agent-info.png` (live).
Skipped cases do not refresh their screenshots; existing files may be historical.

Each spec launches into a fresh `mkdtemp` profile and a fresh temp project directory, so the real
`%APPDATA%\capygen` is never touched.

---

`settings.spec.ts` is the Phase 6 proof (SPEC R3, R19–R21, R27–R30). Everything it can write —
MCP servers, tool policies, `config.toml`, API keys — goes to a **temp** `CLAUDE_CONFIG_DIR` and
`CODEX_HOME`, handed to the app as `CAPYGEN_CLAUDE_CONFIG_DIR` / `CAPYGEN_CODEX_HOME`
(`apps/desktop/src/win/configHomes.ts` maps them onto the CLIs' own variables for the app, for
every child it spawns, and for the config stores). The cases do not use the machine's personal
backend homes:

- **(a)** the nav lists all 22 section ids and each one routes to a non-empty body; the app's own
  log is then checked for the two `[config] …=<temp>` lines, so a run that silently used the real
  homes cannot pass as an isolated one;
- **(b)** adding a stdio server at user scope in the UI writes the isolated `.claude.json`, and
  **`claude mcp list`** — the CLI, pointed at the same temp home — prints it back;
- **(b3)** capygen's own MCP client then connects to that registered server and reads its tools
  (`show_card`, `echo`). Live in the sense that matters — a real child process and a real MCP
  handshake — with no model and no sign-in, so it never skips;
- **(b2)** the model half starts with a skip unless an explicitly supplied dedicated authenticated
  Claude/Codex home pair is present. It applies the pinned low-effort config before dispatch. UI
  created live sends remain gated by the shared P1 runtime-inheritance check; explicit
  `sessions.create` paths remain runnable. A skip is not live-model evidence;
- **(c)** a `permissions.allow` entry appended to the isolated `settings.json` from outside the
  app appears in the Tools table within 3 s — R29's watcher half;
- **(d)** Codex: a UI add patches `config.toml` and every pre-existing comment survives; an
  external `[mcp_servers.…]` block comes back into the UI;
- **(e)** an API key entered in Providers is absent, byte-for-byte, from every file in the
  profile and both backend homes, and from the log — while `secrets.has` says `stored` (R21);
- **(f)** with the bundled Codex CLI available and an isolated signed-out home, the setup panel
  shows the sign-in step; **Run…** reaches the exact-command confirmation, and Cancel spawns
  nothing (R3/R27). Missing-CLI and dependency refusal remain covered by unit tests;
- **(g)** the dark-theme screenshot, and `nativeTheme.themeSource === "dark"` in the main process;
- **(h)** the Plugins page uses a synthetic isolated plugin registry; its isolated screenshot is
  `settings-plugins-isolated.png`.

### Transcript import (current Phase 7 work)

Open Settings ▸ Import, choose a destination project, and choose one Claude JSONL or Codex
rollout transcript through the native file picker. The main process previews bounded metadata and
warnings behind an opaque handle; the renderer never supplies transcript contents. Importing
commits an immutable, read-only historical session with paginated entries. Historical tool calls,
approvals, configuration and permissions render as inert text and cannot run. Repeating the same
source snapshot opens the existing session; a changed source produces a separate snapshot.

Use “Continue” from an imported session only to create a fresh session. The imported history is
quoted as a bounded reference with its imported speaker label; no native backend resume id is
passed to Claude, Codex or an API model. The worker runs in an Electron utility process with
owned backend homes and an inert project directory, and staging files are app-owned under the
profile. This boundary is process separation, not an OS filesystem sandbox.

Focused verification currently available:

```sh
corepack pnpm exec vitest run --project renderer src/components/ImportedTranscript.test.tsx src/pages/settings/ImportSection.test.tsx
corepack pnpm exec vitest run --project engine test/mcpServerResolver.test.ts
```

The current implementation checkpoint and output tails are in `PROJECT_LOG.md`. The native import
e2e currently has one verified pass including restart/deduplication and source-hash stability.
Worktree integration is accepted by the final Phase 7–8 gate. Packaged worker SDK-resolution verification remains Phase 12 work; live benchmark evidence remains a Phase 11 requirement. Live checks require dedicated authenticated
homes; never point them at personal Claude or Codex configuration.

---

## 5. Spikes and live smoke checks

Before any live e2e, spike, or smoke command, point both backends at dedicated authenticated test
homes. In PowerShell, for example:

```powershell
$env:CAPYGEN_TEST_CLAUDE_HOME = 'D:\capygen-test\claude'
$env:CAPYGEN_TEST_CODEX_HOME = 'D:\capygen-test\codex'
$env:CLAUDE_CONFIG_DIR = $env:CAPYGEN_TEST_CLAUDE_HOME
$env:CODEX_HOME = $env:CAPYGEN_TEST_CODEX_HOME
```

Use separate directories outside the personal configuration roots. Authentication is established
in those test homes independently; these commands do not read or copy personal configuration.

```sh
corepack pnpm spike                                  # Phase 1 capability proof (Claude + Codex)
corepack pnpm --dir packages/engine live:claude      # one live Claude turn, no Electron, no UI
corepack pnpm --dir packages/engine live:codex       # two live Codex turns, incl. an approval
corepack pnpm --dir packages/engine live:api         # one live API-model turn — SKIPs without a key
```

`live:claude` is the smallest thing that proves the harness against the real backend; run it
first when the live e2e fails, to tell "the harness broke" apart from "the UI broke". It is pinned
to `claude-sonnet-5` at low effort and rejects other model ids.

`live:codex` is the same idea for the Codex harness, pinned to `gpt-5.6-luna` at low reasoning
effort and rejecting other model ids. It runs two turns in a throwaway `mkdtemp` thread: "pong", then a shell command under
`approvalPolicy: "untrusted"` whose approval it accepts **programmatically** — the one unattended
`allow` in the repo, and it is one `echo`. It prints which `codex.exe` it resolved and from where;
that line should say `(bundled)`, because the machine's installed CLI is a different protocol
version. Codex sign-in must be present in the explicitly supplied dedicated test home; there is no
personal-home fallback.

`live:api` is the same for the `api` backend. It accepts Anthropic only, pins
`claude-sonnet-5`, and uses low effort; unsupported providers/models fail without substitution.
`--tool` forces one `read_file` so the loop is proved, not just the stream. It reads the Anthropic
key from `ANTHROPIC_API_KEY` without printing the secret.

---

## 6. Where the app keeps things

```
%APPDATA%\capygen\capygen.db                    SQLite (node:sqlite — docs/adr/0003)
%APPDATA%\capygen\capygen.db.backup-<ts>.db     written before any pending migration
%APPDATA%\capygen\logs\capygen-desktop.log      rotating, secret-redacting (2 MB × 5)
```

The tray menu has **Open Log Folder**. The log is the first place to look when a turn fails: the
harness writes the backend's stderr there (`[claude:stderr]`), and every IPC handler error is
logged with its real message before it is re-thrown to the renderer.

---

## 7. Environment seams

| Variable | Effect |
|---|---|
| `CAPYGEN_DEV_URL` | load the renderer from this URL instead of built `index.html` (set by `dev`) |
| `CAPYGEN_USER_DATA_DIR` | override Electron's userData dir — database, logs, window state |
| `CAPYGEN_PROJECT_DIR` / `--project=<dir>` | pre-select a project folder at launch |
| `CAPYGEN_ENGINE=stub` | run the offline echo double instead of a real backend |
| `CAPYGEN_ENGINE=stub-roundtable` | the same echo double, but every reply @-mentions the next agent and dispatch goes through the real round table — how the hop cap is proved offline |
| `CAPYGEN_CLAUDE_CONFIG_DIR` | set `CLAUDE_CONFIG_DIR` to this for the app **and every child it spawns** — the whole Claude home (settings, `.claude.json`, credentials, skills, plugins) moves there. The directory is created if absent, and the mapping is logged once as `[config] CLAUDE_CONFIG_DIR=… (from CAPYGEN_CLAUDE_CONFIG_DIR)` |
| `CAPYGEN_CODEX_HOME` | the same for `CODEX_HOME` (`config.toml`, skills, plugin cache) |
| `CAPYGEN_PREREQ_CONFIRM=cancel` | **e2e only.** Replaces the prerequisites confirm dialog — and only the dialog — with one that answers Cancel without drawing, so `settings.spec.ts` can click Run… and prove nothing was spawned. Any other value (including unset) leaves the real `dialog.showMessageBox` in place |

---

## 8. Things that will bite you

- **`Code generation from strings disallowed`** in the renderer or preload: something removed
  `z.config({ jitless: true })` from `packages/shared/src/zodRuntime.ts`. zod 4 builds validators
  with `new Function`, which the page CSP blocks — and Electron applies the page CSP to the
  preload's isolated world too. Restore the flag; do **not** add `'unsafe-eval'`. There is a test
  asserting it.
- **A turn never finishes / the composer stays locked**: look for `the backend ended the turn
  without a result` in the log. The runner closes an orphaned turn rather than leaving the row
  `streaming`, so a locked composer means the renderer missed the status event, not the backend.
- **The live e2e times out at the first turn**: check the Claude login (`claude --version`, then
  `corepack pnpm --dir packages/engine live:claude`). The harness strips nested-session markers
  (`CLAUDECODE`, `CLAUDE_CODE_*`) from the child env, so running it from inside a Claude Code
  terminal is fine.
- **`pnpm start` shows a white window**: the renderer was not built, or was built after the
  desktop bundle. Re-run `corepack pnpm build`.
- **Codex is greyed out in the model picker**: the reason is on the row — `harness.list` puts it
  there. Confirm that the explicitly supplied dedicated Codex test home is authenticated and that
  `CODEX_HOME` points to it; the test policy never falls back to or repairs the personal home. The
  answer is cached for 60 s.
- **Codex runs but every approved command fails with "Access to the path ... is denied"**: the
  project folder is an 8.3 short path (`C:\Users\TUGAPL~1\...`). capygen expands
  `--project`/`CAPYGEN_PROJECT_DIR` and the picker's answer with `longPath()`; a project row stored
  before that keeps its short form — re-pick the folder.
- **An agent ignores its `permissionMode` / `approvalPolicy` and still shows a permission card**:
  check that `SessionRunner.harnessFor` is still reading `agent.config.<backend>.permissionMode`
  before the global setting. `HarnessAgent.permissionMode` is the *highest* priority a harness
  knows, so filling it from the global setting unconditionally makes the per-agent override dead.
- **A routed sub-agent shows no model in the agents pane**: the block is upserted twice — once by
  the `PreToolUse` hook (which knows the routed model) and once by the assistant `tool_use` frame
  that follows it. The second must not pass `model: null`, or it erases the first. There is a
  regression test (`packages/engine/test/ClaudeHarness.test.ts` › "keeps the routed model when the tool_use frame for the same spawn arrives after").
- **A Claude reply appears twice in the transcript**: block keys are
  `msg:<messageId>:<kind>:<ordinal within that kind>`, never the raw content index — the delta
  stream and the settled `assistant` message number their content differently (the settled one
  drops the thinking block), so an index-keyed block gets written under two keys. And
  `BlocksRepo.upsert` must update `kind` on conflict, or the stored row keeps the old kind with the
  new payload and a relaunched session renders the answer as a collapsed thinking card.
- **The chat header's buttons do nothing**: `.titlebar-drag` is a window-wide fixed strip at
  `z-index: 40` over the top 36 px, exactly the height of the chat header. A header that lives in
  that row needs `.titlebar-clearance`, which lifts it above the strip and supplies its own drag
  region.
- **The app drove the wrong Codex**: the log line `[codex] app-server <path> (<source>)` says which
  binary answered. It should say `(bundled)`; `(installed)` means the walk-up for
  `node_modules/@openai/codex-sdk` failed and the machine's own CLI — a different protocol version
  — is being driven, on which approvals never fire. `@openai/codex-sdk` must stay a dependency of
  `apps/desktop`, not only of `packages/engine`.
- **The Terminal pane is empty in a packaged build but fine in `pnpm dev`**: `node-pty` was packed
  into the asar. Its binding loader does a relative `require("../build/Release/pty.node")` and it
  launches `conpty.dll` / `OpenConsole.exe` as *files*, neither of which works from inside an
  archive. Phase 12 must `asarUnpack` `**/node_modules/node-pty/**` — see
  `docs/adr/0005-terminal-node-pty.md`. Nothing needs rebuilding: node-pty 1.1.0's prebuilds are
  N-API and load under Electron 44 and Node 22.16 unchanged (both measured).
- **Stopping a dev server leaves the port taken**: the stop path must tree-kill *synchronously*.
  `taskkill /T` walks the process tree by parent pid, so firing it asynchronously and then calling
  `child.kill()` kills the shell first and reparents the server that actually holds the port.
  `killProcessTree` uses `spawnSync` for exactly this reason, and
  `apps/desktop/test/workspaceServers.test.ts` asserts the port stops answering.
- **"Port 3000 is already in use by PID …" instead of a start**: that is deliberate. When a dev
  server's declared port already answers, capygen adopts the running server and hands you its URL
  rather than spawning a second one that would die on EADDRINUSE. Stopping an adopted server kills
  nothing — capygen did not start it.
- **A Terminal loses its scrollback, or a server finishes starting with nobody listening**:
  `WorkspaceHost` passes `defaultRenderer="always"` to dockview. Dockview's default,
  `onlyWhenVisible`, *unmounts* every tab that is not the active one in its group — which throws
  away an xterm instance and its buffer, unsubscribes the Servers pane from `servers.status`
  mid-start (this is exactly how "click Start, watch the Browser tab" used to lose the URL), and
  destroys a `WebContentsView`. Every pane that owns a live resource depends on `always`.
- **The workspace toolbar's buttons are dead, or the chat header has a 9rem hole in it**: the
  window's caption buttons are drawn over the top *right* corner, so whichever column is rightmost
  owns that clearance. `WorkspaceHost`'s toolbar reserves it while it is mounted and `ChatPage`'s
  header drops its own copy (`titlebar-clearance-no-caption`). Reserve it in both and you get the
  hole; reserve it in neither and the buttons sit under `.titlebar-drag` and are unclickable.
- **The terminal cursor lands in the wrong column**: xterm writes its `fontFamily` into a
  `CanvasRenderingContext2D.font` string and into the WebGL atlas, where `var(--font-mono)` is not
  resolvable — Chromium drops the whole declaration and measures a proportional face.
  `xtermTheme.readXtermFontFamily()` resolves it to real family names first, the same way the
  colours are read.
- **A restored layout points at the wrong project**: dockview's `toJSON()` serialises each panel's
  `params`, which is where every pane reads its `projectId`/`sessionId`. A layout saved yesterday
  would replay yesterday's ids — a Terminal pane would `terminal.create` against a project that may
  not exist. `applySavedOrDefaultLayout` rewrites those two fields after `fromJSON`
  (`updateParameters` merges, so `initialFilePath`/`initialUrl` survive).
- **A Playwright drag of a dockview tab does nothing**: dockview tabs are HTML5 drag sources and
  its pointer backend ignores mouse input on a fine-pointer device. Chromium synthesises the DnD
  sequence from mouse input only for a *stepped* gesture — one jump from source to target never
  produces the `dragover` the drop target needs — and the drop overlay needs a few frames of dwell
  inside the quadrant before it commits. `dragTabToBottomOfGroup` in the workspace e2e is the
  working recipe.
- **The Browser pane's page vanishes when you click another tab in its group**: it is supposed to.
  A hidden native view would float over whatever is now in front, so the pane detaches on hide and
  re-attaches (re-navigating to the same URL) on show. The address survives; the back/forward
  history does not. Keeping it alive needs a "park it off-screen" mode the contract does not have
  yet — see PLAN.md's Phase 5 deviations.

## Pixel mascot authoring (2026-09-06)

Use `python scripts/mascot-pixels.py` from the repo root with the existing Python/Pillow
installation, then `corepack pnpm build`. No install occurs in the generator. The source,
frame layout and preview are documented in `assets/mascot/README.md`; generated assets are
committed under `assets/mascot`, while renderer/public remains staged output.
`corepack pnpm exec playwright test tests/e2e/mascot.spec.ts` checks static PNG loading,
sharp rendering, the larger landing mascot, and zero animations. It runs offline. The desktop's minimum window width remains the supported
layout; a 380px renderer screenshot is a stress check, not a mobile-support claim.

## Activity pages (Phase 8)

The sidebar opens Tasks, Inbox, Usage and Automations. Tasks lists agent todos across sessions;
Inbox opens the exact request card or completed turn. Mark read updates the sidebar badge.
Usage supports preset/custom ranges in the machine's local time zone; unknown prices are
counted separately from known reported/estimated cost.

Create a session with the desired agent first, then choose Automations → New automation,
its project and agent, a prompt, and a recurrence. Each occurrence creates a fresh session
using that agent's latest configuration. Keep capygen running, including in the tray, for
scheduled execution. Exiting skips missed occurrences on the next launch. Pause stops future
runs; Run now also works while paused. Cancel a running occurrence before deleting its
automation. This feature installs no Windows service or startup task.

Offline acceptance: `corepack pnpm exec playwright test tests/e2e/activity.spec.ts` uses a real
every-minute timer and isolated profiles, with no model tokens. The full acceptance gate is
typecheck, unit tests, build, then all Playwright tests.


## Phase9 local workflows

- Open a live session's header gear to add a credential-free stdio MCP server for its lead
  agent. Refresh explicitly to start discovery; type `/` to see informational tool names.
  Editing waits for an idle session. Backend files remain the source for inherited servers.
- Settings > Members assigns local execution profiles; Settings > Policies edits additional
  restrictions, previews decisions, revokes grants and displays decision activity. A policy
  card's restriction link opens its exact rule, or explains that the rule was deleted.
- Approve lists pending tool requests across sessions and uses the normal answer path.
- Settings > Sharing prepares a reviewable export and saves HTML or JSON. Import previews
  remain inert. Received transcripts accept separate local notes; Continue creates a fresh
  live conversation with quoted reference text, preserving the original artifact.

Offline native regression commands (build first):

```sh
corepack pnpm build
corepack pnpm exec playwright test tests/e2e/sessionMcp.spec.ts tests/e2e/sharingShell.spec.ts tests/e2e/localPolicyTools.spec.ts tests/e2e/localPoliciesShell.spec.ts
```

These fixtures use owned homes, local providers and dummy credentials. Live authenticated
skips remain separate; they are not evidence of a successful live model run. The workspace
server fixture requests an OS-assigned loopback port and does not require stopping another
service on the machine.
### Dictation and extensions

On Windows, choose **Install local speech** below the composer, review the exact command in
the native confirmation, and let the visible console download the pinned whisper.cpp runtime
and multilingual model (about 199 MB). Choose **Check again** when it finishes. Availability
checks and microphone clicks never download anything. The runtime lives under the app profile's
`speech` directory and detects the spoken language automatically.

Click the microphone, speak one instruction, then pause for 1.5 seconds. Capture is capped
at 25 seconds; a spinning **Transcribing locally…** indicator follows capture while CPU
inference runs. It uses up to 12 available CPU threads, reserving two for the app where
possible. Cancel remains available and discards the result.
Text enters the editable draft without submitting. Audio stays in memory and is piped to the
local recognizer. The capture helper compiles during desktop build. The earlier Windows Speech
recognizer failed the user's test; real microphone accuracy still needs repeat acceptance.

After explicitly installing an isolated test runtime, run
`corepack pnpm exec tsx scripts/verify-local-speech.mts <isolated-runtime-directory>`.
This exercises production transcription with generated audio, without a microphone or download.

Open **Tools → App pages** to register/open local extension packages. Strict package identity
and capability checks remain. Native verification passes storage, restart, navigation and
network isolation through this visible path.

### Composer attachments

Attach accepts UTF-8 text/code files up to 64 KiB each, 256 KiB total and 8 files, plus PNG, JPEG,
and WebP images up to 5 MiB each, 10 MiB total and 4 images. Images stay in app data and are sent
as real image input only to compatible backends and app-delegated workers; unsupported or unverified
model input is reported explicitly. Other binary files and PDFs are not supported. Text-only sharing
emits an omission notice and excludes picture contents. API replay keeps recent images within bounded
count and total size, with notes for older or unavailable images; it does not claim the entire image
history is retained.

### Windows packaging

On native Windows x64, run `corepack pnpm build:win` to build and stage the runtime, or
`corepack pnpm package:win` to package and audit it. Local output is under `release/artifacts/`:
`capygen-<version>-setup.exe`, `capygen-<version>-portable.exe`, `latest.yml`, and
`artifact-audit.json`. Current artifacts are about 268 MiB each and unsigned. There is no verified
published release or live updater acceptance yet.

### Repair build: tools and session setup

Use **Tools** in the sidebar for skills, plugins, MCP servers and tool permissions.
These editors use the harness configuration files; **Open folder** reveals the
native backend's directory. Account provides direct Claude/Codex sign-in and refresh.
Every setup/sign-in command still requires the native command confirmation.

The start screen offers Solo, Round-table and Custom. Custom opens the crew editor
before sending the task. A folder choice is optional; the home folder is the default.
Round-table roster and hop/parallel choices are reused. Context details in chat show
separate latest-request windows, including app-delegated workers; unknown limits
remain labelled unknown. Model effort choices come from the runtime catalogue.
