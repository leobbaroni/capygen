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

- Claude Code signed in — the harness uses the machine's claude.ai OAuth login, not an API key
  (`init.apiKeySource: "none"`; see `COMPAT.md`). `claude --version` should print 2.1.x.
- No `ANTHROPIC_API_KEY` is required, and none is ever read or written by the Claude harness.

---

## 1. Develop

```sh
corepack pnpm dev
```

`scripts/dev.ts` bundles main+preload, starts Vite on <http://localhost:5273> (which stages the
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

Packaging (`build:win`, NSIS + portable + updater feed) is Phase 12 and does not exist yet.

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

Playwright drives the app's own Chromium through `_electron.launch`, so there is no browser to
install. `workers: 1` — Electron windows are singletons per user-data-dir.

| Spec | Engine | Network / cost |
|---|---|---|
| `tests/e2e/launch.spec.ts` | `CAPYGEN_ENGINE=stub` (offline echo double) | none |
| `tests/e2e/skeleton.spec.ts` | the real Claude harness | **real model calls, real money** |
| `tests/e2e/harnesses.spec.ts` | the real Codex, Claude and API harnesses | **real model calls** (a few cents) |
| `tests/e2e/widget.spec.ts` | the real Claude harness + a fixture MCP server | **real model calls** |
| `tests/e2e/roundtable.spec.ts` | four live (Claude + Codex), one offline (`CAPYGEN_ENGINE=stub-roundtable`) | **real model calls** (a few cents) |

`skeleton.spec.ts` is the PLAN Phase 2 proof: landing → live Claude reply with a usage/cost line
→ close → relaunch → same transcript out of SQLite; plus an `AskUserQuestion` card answered in
the UI whose answer reaches the model. It pins the session to `claude-sonnet-5` through the app's
own `settings.set` channel, so a full run costs a few cents and about a minute. It needs the
Claude login; without one it fails with the backend's own error rather than hanging.

`harnesses.spec.ts` is the Phase 3 proof. Each test asks `harness.list` first and **skips with
that backend's own reason** rather than failing on a 401, so a machine with no Codex login still
gets a green run and a sentence saying why:

- Codex picked in the composer answers "pong" with a usage/cost line;
- a Codex shell approval (`approvalPolicy: "untrusted"`, set through the agent's own config so the
  card is guaranteed to appear) renders a permission card whose **Allow once** runs the command;
- `/` in a Claude session lists Built-ins plus what Claude itself reports — on this machine the
  `/cockpit:*` plugin commands;
- the API-model test runs **only** with a key in Settings ▸ API keys or in
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY`; otherwise it skips and says so.

`roundtable.spec.ts` is the Phase 4 proof (SPEC R10-R13, ADR-0002). It skips per backend the
same way `harnesses.spec.ts` does:

- **round table** — a session with `@claude` (Claude Code) and `@codex` (Codex); one message
  mentioning both opens two agent turns *in mention order*, and Codex's review quotes Claude's
  haiku, which is only possible because the labelled context delta reached it (R23: a stateful
  backend is sent the turns since its own last one, never the transcript again). The two may then
  go on talking to each other — R11 allows that, and the hop cap bounds it — so the test asserts
  on the hop-1 round and interrupts the session before closing;
- **hop cap** — offline, on `CAPYGEN_ENGINE=stub-roundtable`: every echoed reply ends
  `over to @<next agent>`, so two agents would ping-pong forever. The real dispatcher stops them
  at hops 1-2-3, writes one "Chain stopped after 3 hops" system turn, shows the Continue bar, and
  Continue grants exactly one more hop (4) before the cap applies again. A loop bound must not be
  proved with a model that might choose to stop by itself;
- **routed sub-agent** — a solo Claude session with `subagentRouting: {backend:"claude",
  model:"haiku"}`: the `PreToolUse` hook rewrites `updatedInput.model` and the stored `subagent`
  block names a haiku model, `delegated: false` (the CLI still spawned it — capygen only re-homed
  it);
- **cross-backend delegation** — the same lead with `subagentRouting: {backend:"codex"}`: no hook
  can do that, so the lead calls `mcp__capygen__delegate_task` and the block is
  `backend: "codex", delegated: true`;
- **agent info drawer** — after one cheap turn, the drawer shows the agent's own description, the
  generated usage description, the model, the live tool list and the other agent; the same facts
  are then re-read straight off `agents.describe` so a UI change cannot hide a regression in the
  channel.

Every run writes screenshots to `e2e-out/`: `landing.png`, `chat.png` (offline),
`chat-pong.png`, `restored.png`, `chat-question.png`, `codex-pong.png`, `codex-permission.png`,
`codex-allowed.png`, `slash-menu.png`, `roundtable.png`, `roundtable-hopcap.png`,
`roundtable-routed-subagent.png`, `roundtable-delegated.png`, `roundtable-agent-info.png` (live).

Each spec launches into a fresh `mkdtemp` profile and a fresh temp project directory, so the real
`%APPDATA%\capygen` is never touched.

---

## 5. Spikes and live smoke checks

```sh
corepack pnpm spike                                  # Phase 1 capability proof (Claude + Codex)
corepack pnpm --dir packages/engine live:claude      # one live Claude turn, no Electron, no UI
corepack pnpm --dir packages/engine live:codex       # two live Codex turns, incl. an approval
corepack pnpm --dir packages/engine live:api         # one live API-model turn — SKIPs without a key
```

`live:claude` is the smallest thing that proves the harness against the real backend; run it
first when the live e2e fails, to tell "the harness broke" apart from "the UI broke". It takes
`--model <id>` and prints the session id, the blocks, and the turn's usage and cost.

`live:codex` is the same idea for the Codex harness (`--model <id>`, default `gpt-5.5`). It runs
two turns in a throwaway `mkdtemp` thread: "pong", then a shell command under
`approvalPolicy: "untrusted"` whose approval it accepts **programmatically** — the one unattended
`allow` in the repo, and it is one `echo`. It prints which `codex.exe` it resolved and from where;
that line should say `(bundled)`, because the machine's installed CLI is a different protocol
version. Codex sign-in is the ChatGPT OAuth in `~/.codex`; without it the turn fails with
"Codex is not signed in".

`live:api` is the same for the `api` backend. It takes `--provider anthropic|openai|openrouter`,
`--model <id>` and `--tool` (which forces one `read_file` so the loop is proved, not just the
stream). It reads the key from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` only —
the engine never reads a key from disk (R21); in the app the desktop injects the `safeStorage` one.
**This machine has none of the three**, so the script prints `SKIP` and exits 0. Only the ends of a
key are ever printed.

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
  there. It probes with `account/read {refreshToken:true}`, not `codex login status`, so "Logged in
  using ChatGPT" from the CLI is not a contradiction: that command only checks that
  `~/.codex/auth.json` exists, and a dead refresh token passes it. The fix is `codex logout` then
  `codex login`. The answer is cached for 60 s.
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
