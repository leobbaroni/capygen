/**
 * Phase 6 end to end: the Settings hub, two-way config sync and the
 * prerequisites gate (SPEC R3, R19-R21, R27-R30; PLAN A9, A14).
 *
 * **Isolation first.** Every test that can write a backend's configuration
 * runs against a temp `CLAUDE_CONFIG_DIR` and a temp `CODEX_HOME`, handed to
 * the app as `CAPYGEN_CLAUDE_CONFIG_DIR` / `CAPYGEN_CODEX_HOME`
 * (`apps/desktop/src/win/configHomes.ts` maps them onto the CLIs' own
 * variables for the app, for every child it spawns and for the config stores).
 * The machine's real `~/.claude` and `~/.codex` are never written by this
 * file. The one test that reads the real home says so in its name and only
 * ever lists (h).
 *
 * Eight proofs, in the order Task C names them:
 *
 *   (a) the nav lists every section id in `SETTINGS_SECTIONS` (R19);
 *   (b) adding a stdio MCP server at user scope for Claude **in the UI**
 *       writes Claude's own `.claude.json`, and `claude mcp list` — the CLI,
 *       run against the same isolated home — agrees (R20, R29, A14);
 *   (b3) capygen's own MCP client connects to that same registered server and
 *       reads its tool list — live (a real child process and a real MCP
 *       handshake), but with no model and no sign-in, so it never skips;
 *   (b2) a new Claude session's live tool list contains that server's tools —
 *       the same add, done at **project** scope in a temp project directory so
 *       that a real, signed-in Claude can be used without writing one byte of
 *       the machine's own `~/.claude`. Real model call, one cheap turn; skips
 *       with the backend's own reason when Claude is unavailable;
 *   (c) an edit made **outside** the app (a `permissions.allow` entry appended
 *       to the isolated `settings.json`) reaches the Tools table within 3 s —
 *       the watcher half of R29;
 *   (d) Codex: adding a server in the UI patches `config.toml` **without
 *       losing the comments that were already in it**, and an external edit to
 *       the same file comes back into the UI;
 *   (e) an API key stored through Providers is absent, as plaintext, from the
 *       settings database, the log file and every config file — while
 *       `secrets.has` is true (R21);
 *   (f) with `codex` taken off PATH the setup panel shows the step, and Run…
 *       reaches the confirm dialog and spawns **nothing** when it is cancelled
 *       (R3, R27);
 *   (g) the dark-theme screenshot, `e2e-out/settings-dark.png`;
 *   (h) Plugins lists the machine's genuinely installed Claude plugins —
 *       read-only, against the real config dir.
 *
 * Cost: (b2) is one short Claude turn (a few cents). Everything else is
 * offline: no model, no network.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const appDir = path.join(repoRoot, "apps", "desktop");
const outDir = path.join(repoRoot, "e2e-out");
/** The stdio MCP server the UI registers — `tests/fixtures/mcp-apps-server`. */
const FIXTURE_SERVER = path.join(repoRoot, "tests", "fixtures", "mcp-apps-server", "server.mjs");
/** The name it is registered under, and the MCP prefix Claude then gives its tools. */
const FIXTURE_NAME = "capyfixture";

/** A live turn is a real model call. */
const LIVE_TIMEOUT_MS = 150_000;
/** Claude's cheap model, as in `skeleton.spec.ts`. */
const CLAUDE_E2E_MODEL = "claude-sonnet-5";
/** R29's own promise for an outside edit: the watcher debounce plus slack. */
const OUTSIDE_EDIT_TIMEOUT_MS = 3_000;

/**
 * Every id in `apps/renderer/src/shell/settingsNav.tsx`, restated here on
 * purpose: a nav test that imported the array it is checking would pass no
 * matter what the array said. R19's own list is the first thirteen; the rest
 * are the additions R19's acceptance line names.
 */
const EXPECTED_SECTION_IDS = [
  "general",
  "appearance",
  "git",
  "shortcuts",
  "import",
  "integrations",
  "account",
  "harnesses",
  "mcp",
  "skills",
  "plugins",
  "tools",
  "api-keys",
  "dev-servers",
  "prereqs",
  "diagnostics",
  "cli",
  "updates",
  "members",
  "policies",
  "sharing",
  "archived",
];

interface Launched {
  app: ElectronApplication;
  page: Page;
  errors: string[];
}

interface Homes {
  userDataDir: string;
  claudeHome: string;
  codexHome: string;
  projectDir: string;
}

const created: string[] = [];

function tempDir(tag: string, real = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${tag}-`));
  created.push(dir);
  // `realpathSync.native` because `os.tmpdir()` here is the 8.3 short form,
  // which the Codex sandbox refuses and which makes a path comparison lie.
  return real ? fs.realpathSync.native(dir) : dir;
}

/**
 * A fresh, genuinely isolated pair of backend homes.
 *
 * Nothing is copied out of the real home — in particular **not**
 * `.credentials.json`. `CLAUDE_CONFIG_DIR` relocates the credentials along
 * with everything else, so a copy would have the SDK refresh the user's own
 * OAuth session from a temp directory; a successful refresh rotates the token
 * server-side and writes the new one *here*, which logs the real Claude Code
 * out. That is why (b2) runs against the real config home with a
 * **project-scope** server instead (see its own describe block) — every byte
 * it writes lands in a temp project directory.
 */
function makeHomes(tag: string): Homes {
  const userDataDir = tempDir(`${tag}-profile`);
  const claudeHome = tempDir(`${tag}-claude`);
  const codexHome = tempDir(`${tag}-codex`);
  const projectDir = tempDir(`${tag}-proj`, true);
  fs.writeFileSync(path.join(projectDir, "README.md"), "# capygen settings e2e\n", "utf8");

  // A Claude home the CLI will treat as set up rather than onboarding into.
  fs.writeFileSync(path.join(claudeHome, "settings.json"), "{}\n", "utf8");
  fs.writeFileSync(
    path.join(claudeHome, ".claude.json"),
    `${JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5 }, null, 2)}\n`,
    "utf8",
  );
  // A Codex config with a comment and a key already in it, so (d) can prove
  // the TOML patcher preserves what it did not write.
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    "# capygen e2e fixture — this comment must survive every write\n" +
      'model = "gpt-5.5"\n\n' +
      "# a second comment, after the model key\n",
    "utf8",
  );
  return { userDataDir, claudeHome, codexHome, projectDir };
}

async function launch(
  homes: Homes,
  extraEnv: Record<string, string> = {},
): Promise<Launched> {
  const errors: string[] = [];
  // `CAPYGEN_ENGINE` is dropped so that what runs is the shipping harness
  // registry rather than the stub; none of the tests using this helper starts
  // a turn, so no model is reached either way.
  const { CAPYGEN_ENGINE: _drop, ...inherited } = process.env;
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${homes.userDataDir}`],
    cwd: repoRoot,
    env: {
      ...inherited,
      CAPYGEN_USER_DATA_DIR: homes.userDataDir,
      CAPYGEN_PROJECT_DIR: homes.projectDir,
      CAPYGEN_CLAUDE_CONFIG_DIR: homes.claudeHome,
      CAPYGEN_CODEX_HOME: homes.codexHome,
      ELECTRON_ENABLE_LOGGING: "0",
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1400, 950);
  });
  return { app, page, errors };
}

/** Call one of the app's own IPC channels from inside the renderer. */
async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  return page.evaluate(
    async ([ch, args]) => {
      const bridge = (
        window as unknown as {
          capygen?: { invoke(channel: string, payload: unknown): Promise<unknown> };
        }
      ).capygen;
      if (!bridge) throw new Error("preload bridge missing");
      return bridge.invoke(ch as string, args);
    },
    [channel, payload] as const,
  ) as Promise<T>;
}

async function openSettings(page: Page, section: string): Promise<void> {
  await page.evaluate((s) => {
    window.location.hash = `#/settings/${s}`;
  }, section);
  await expect(page.getByTestId("settings-page")).toBeVisible();
}

/**
 * When the machine's Claude OAuth session expires, in epoch ms — `null` when
 * there is no credentials file or it has no expiry.
 *
 * Only `claudeAiOauth.expiresAt` is read; the tokens themselves are never
 * touched, copied or logged.
 */
function claudeSessionExpiry(): number | null {
  const file = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      claudeAiOauth?: { expiresAt?: number };
    };
    const at = parsed.claudeAiOauth?.expiresAt;
    return typeof at === "number" ? at : null;
  } catch {
    return null;
  }
}

/** The app's own log file, for the assertions that can only be made there. */
function readLog(userDataDir: string): string {
  const dir = path.join(userDataDir, "logs");
  if (!fs.existsSync(dir)) return "";
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("capygen-desktop"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

/** Every file under a directory, for the plaintext-key sweep in (e). */
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

test.afterAll(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (a)-(e), (g): one app, one pair of isolated homes, in order
// ---------------------------------------------------------------------------

test.describe("settings hub on isolated backend homes", () => {
  test.describe.configure({ mode: "serial" });
  test.slow();

  let homes: Homes;
  let launched: Launched;
  let page: Page;

  test.beforeAll(async () => {
    fs.mkdirSync(outDir, { recursive: true });
    homes = makeHomes("settings");
    launched = await launch(homes);
    page = launched.page;
  });

  test.afterAll(async () => {
    await launched?.app.close().catch(() => undefined);
  });

  test("(a) the nav lists every settings section id", async () => {
    await openSettings(page, "general");
    const ids = await page
      .getByTestId("settings-nav")
      .locator("[data-section-id]")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-section-id") ?? ""));
    expect(ids).toEqual(EXPECTED_SECTION_IDS);

    // Every one of them routes to a body rather than a blank pane (R19's
    // "nav test lists all ids" is only half the promise).
    for (const id of EXPECTED_SECTION_IDS) {
      await openSettings(page, id);
      await expect(page.getByTestId("settings-body")).toBeVisible();
      await expect(page.getByTestId("settings-body")).not.toBeEmpty();
    }

    // The isolation itself, asserted rather than assumed: the app logged the
    // two homes it was pointed at, and they are the temp ones.
    const log = readLog(homes.userDataDir);
    expect(log).toContain(`CLAUDE_CONFIG_DIR=${path.resolve(homes.claudeHome)}`);
    expect(log).toContain(`CODEX_HOME=${path.resolve(homes.codexHome)}`);
  });

  test("(b) adding a Claude MCP server in the UI writes .claude.json, and `claude mcp list` agrees", async () => {
    await openSettings(page, "mcp");
    await page.getByTestId("mcp-tab-claude").click();
    await expect(page.getByTestId("mcp-panel-claude")).toBeVisible();

    await page.getByTestId("mcp-add-button").click();
    await expect(page.getByTestId("mcp-dialog")).toBeVisible();
    await page.getByTestId("mcp-input-name").fill(FIXTURE_NAME);
    await page.getByTestId("mcp-select-transport").selectOption("stdio");
    await page.getByTestId("mcp-select-scope").selectOption("user");
    await page.getByTestId("mcp-input-command").fill("node");
    await page.getByTestId("mcp-input-args").fill(FIXTURE_SERVER);
    await page.getByTestId("mcp-dialog-save").click();

    await expect(page.getByTestId(`mcp-row-${FIXTURE_NAME}`)).toBeVisible();
    await page.screenshot({ path: path.join(outDir, "settings-mcp-added.png") });

    // 1. Claude's own file, in the isolated home. `.claude.json` moves inside
    //    CLAUDE_CONFIG_DIR when that is set (see `config/paths.ts`).
    const globalConfig = path.join(homes.claudeHome, ".claude.json");
    expect(fs.existsSync(globalConfig)).toBe(true);
    const written = JSON.parse(fs.readFileSync(globalConfig, "utf8")) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    expect(Object.keys(written.mcpServers ?? {})).toContain(FIXTURE_NAME);
    expect(written.mcpServers?.[FIXTURE_NAME]?.command).toBe("node");
    expect(written.mcpServers?.[FIXTURE_NAME]?.args?.join(" ")).toContain("server.mjs");

    // 2. The CLI, run against the same isolated home, lists it too — A14's
    //    "the backend's files are the source of truth", proved from the
    //    backend's side rather than capygen's.
    let cliOutput = "";
    try {
      cliOutput = execFileSync("claude", ["mcp", "list"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
        env: { ...process.env, CLAUDE_CONFIG_DIR: homes.claudeHome },
      });
    } catch (err) {
      // `claude mcp list` exits non-zero when a listed server fails to
      // connect; its stdout is still the answer.
      cliOutput = String((err as { stdout?: string }).stdout ?? "");
    }
    expect(cliOutput, `claude mcp list said:\n${cliOutput}`).toContain(FIXTURE_NAME);
    // And it never touched the machine's own home.
    expect(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8")).not.toContain(
      FIXTURE_NAME,
    );
  });


  test("(b3) the registered server really connects: `integrations.mcp.test` lists its tools", async () => {
    // The live half of (b) that needs no model and no sign-in: capygen's own
    // MCP client spawns `node <fixture>/server.mjs` from the row it just
    // wrote, completes the handshake and reads the server's tool list. It is
    // the proof that the entry capygen wrote is a *working* server definition
    // rather than a well-shaped JSON object — which is the part a file
    // assertion alone cannot tell you.
    const result = await invoke<{ ok: boolean; status?: string; tools?: string[]; error?: string }>(
      page,
      "integrations.mcp.test",
      { backend: "claude", name: FIXTURE_NAME, scope: "user" },
    );
    expect(result.error ?? "", `integrations.mcp.test failed: ${result.error ?? ""}`).toBe("");
    expect(result.ok).toBe(true);
    expect(result.status).toBe("connected");
    // `tests/fixtures/mcp-apps-server/server.mjs` declares exactly these two.
    expect([...(result.tools ?? [])].sort()).toEqual(["echo", "show_card"]);
  });

  test("(c) an outside edit to settings.json reaches the Tools table within 3 s", async () => {
    await openSettings(page, "tools");
    await page.getByTestId("tools-tab-claude").click();
    await expect(page.getByTestId("tools-panel-claude")).toBeVisible();

    const pattern = "Bash(echo capygen-outside:*)";
    // Written by "something that is not capygen" — exactly R29's trigger.
    fs.writeFileSync(
      path.join(homes.claudeHome, "settings.json"),
      `${JSON.stringify({ permissions: { allow: [pattern] } }, null, 2)}\n`,
      "utf8",
    );

    await expect(page.getByTestId(`tool-policy-row-${pattern}`)).toBeVisible({
      timeout: OUTSIDE_EDIT_TIMEOUT_MS,
    });
    // The decision is a <select>; its *value* is the assertion, not the
    // capitalised option labels the row's text content is made of.
    await expect(page.getByTestId(`tool-policy-decision-${pattern}`)).toHaveValue("allow");
    await expect(page.getByTestId(`tool-policy-row-${pattern}`)).toContainText("global");
    await page.screenshot({ path: path.join(outDir, "settings-tools-outside-edit.png") });
  });

  test("(d) Codex: a UI write keeps config.toml's comments; an outside edit comes back", async () => {
    const configToml = path.join(homes.codexHome, "config.toml");
    const before = fs.readFileSync(configToml, "utf8");
    expect(before).toContain("this comment must survive");

    await openSettings(page, "mcp");
    await page.getByTestId("mcp-tab-codex").click();
    await expect(page.getByTestId("mcp-panel-codex")).toBeVisible();

    await page.getByTestId("mcp-add-button").click();
    await expect(page.getByTestId("mcp-dialog")).toBeVisible();
    await page.getByTestId("mcp-input-name").fill("codexfixture");
    await page.getByTestId("mcp-select-transport").selectOption("stdio");
    await page.getByTestId("mcp-input-command").fill("node");
    await page.getByTestId("mcp-input-args").fill(FIXTURE_SERVER);
    await page.getByTestId("mcp-dialog-save").click();
    await expect(page.getByTestId("mcp-row-codexfixture")).toBeVisible();

    const after = fs.readFileSync(configToml, "utf8");
    expect(after).toContain("[mcp_servers.codexfixture]");
    expect(after).toContain('command = "node"');
    // The two things a naive "parse, re-serialise" write would have destroyed.
    expect(after).toContain("# capygen e2e fixture — this comment must survive every write");
    expect(after).toContain("# a second comment, after the model key");
    expect(after).toContain('model = "gpt-5.5"');

    // …and the other direction (R29): an edit capygen did not make.
    fs.writeFileSync(
      configToml,
      `${after}\n[mcp_servers.outside_codex]\ncommand = "node"\nargs = ["--version"]\n`,
      "utf8",
    );
    await expect(page.getByTestId("mcp-row-outside_codex")).toBeVisible({
      timeout: OUTSIDE_EDIT_TIMEOUT_MS,
    });
    await page.screenshot({ path: path.join(outDir, "settings-codex-mcp.png") });
  });

  test("(e) an API key stored via Providers is nowhere on disk in plaintext", async () => {
    const secret = `sk-ant-capygen-e2e-${Date.now()}-DO-NOT-LOG`;
    await openSettings(page, "api-keys");
    await expect(page.getByTestId("providers-section")).toBeVisible();

    await page.getByTestId("provider-anthropic-set").click();
    await page.getByTestId("provider-anthropic-input").fill(secret);
    await page.getByTestId("provider-anthropic-save").click();
    await expect(page.getByTestId("provider-anthropic-remove")).toBeVisible();

    // The app agrees the key is there…
    const has = await invoke<{ has: boolean; source: string }>(page, "secrets.has", {
      provider: "anthropic",
    });
    expect(has).toEqual({ has: true, source: "stored" });

    // …and nothing on disk contains it. The profile (database, secrets file,
    // logs) and both isolated backend homes, every file, byte-for-byte.
    const files = [
      ...walk(homes.userDataDir),
      ...walk(homes.claudeHome),
      ...walk(homes.codexHome),
    ];
    expect(files.length).toBeGreaterThan(3);
    const offenders = files.filter((file) => {
      try {
        return fs.readFileSync(file).includes(secret);
      } catch {
        return false;
      }
    });
    expect(offenders, `plaintext key found in:\n${offenders.join("\n")}`).toEqual([]);

    // The log specifically, since redaction is its own mechanism (R21).
    expect(readLog(homes.userDataDir)).not.toContain(secret);

    await page.getByTestId("provider-anthropic-remove").click();
    await expect(page.getByTestId("provider-anthropic-set")).toBeVisible();
  });

  test("(g) dark theme applies and is screenshotted", async () => {
    await openSettings(page, "appearance");
    await page.getByTestId("select-theme").selectOption("dark");
    await expect(page.locator("html")).toHaveClass(/dark/);
    // The main process took it too — `nativeTheme.themeSource` is what makes
    // Chromium's own widgets and the caption buttons follow.
    const source = await launched.app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
    expect(source).toBe("dark");

    await openSettings(page, "mcp");
    await page.screenshot({ path: path.join(outDir, "settings-dark.png") });

    // Back to system, so the profile is not left in a state (e) or (h) would
    // have to reason about.
    await openSettings(page, "appearance");
    await page.getByTestId("select-theme").selectOption("system");
  });
});

// ---------------------------------------------------------------------------
// (f): its own launch — PATH is a process-wide fact
// ---------------------------------------------------------------------------

test.describe("prerequisites gate", () => {
  test.slow();

  test("(f) a missing codex shows a step; Run… asks first and spawns nothing", async () => {
    fs.mkdirSync(outDir, { recursive: true });
    const homes = makeHomes("prereq");

    // Take every directory that actually holds a `codex` executable off PATH,
    // rather than blanking PATH wholesale — Electron and the other probes
    // (node, git, rg) must still work, so that the step this asserts on is
    // missing for the reason the test intends.
    const sep = path.delimiter;
    const prunedPath = (process.env.PATH ?? "")
      .split(sep)
      .filter((dir) => {
        if (dir.trim() === "") return false;
        return !["codex.exe", "codex.cmd", "codex.bat", "codex"].some((name) => {
          try {
            return fs.existsSync(path.join(dir, name));
          } catch {
            return false;
          }
        });
      })
      .join(sep);
    expect(prunedPath.length).toBeGreaterThan(0);

    let launched: Launched | null = null;
    try {
      launched = await launch(homes, {
        PATH: prunedPath,
        Path: prunedPath,
        // The one seam: the confirm dialog answers Cancel without drawing.
        // Everything else about the gate — the refusal rules, the console
        // launcher — is the shipping code.
        CAPYGEN_PREREQ_CONFIRM: "cancel",
      });
      const page = launched.page;
      await openSettings(page, "prereqs");
      await expect(page.getByTestId("prereq-panel")).toBeVisible({ timeout: 60_000 });

      const codexStep = page.locator('[data-testid="prereq-step-row"][data-step-id="codex-cli"]');
      await expect(codexStep).toBeVisible({ timeout: 60_000 });
      await expect(codexStep).toHaveAttribute("data-detected", "false", { timeout: 60_000 });
      await expect(codexStep).toContainText("npm install -g @openai/codex");
      await page.screenshot({ path: path.join(outDir, "settings-prereqs.png") });

      // R3/R27: the button asks, and a Cancel runs nothing.
      await codexStep.getByTestId("prereq-step-run").click();

      await expect
        .poll(() => readLog(homes.userDataDir), { timeout: 20_000 })
        .toContain("CAPYGEN_PREREQ_CONFIRM=cancel");
      const log = readLog(homes.userDataDir);
      // The dialog it built was for this step's exact command…
      expect(log).toContain("npm install -g @openai/codex");
      // …and the console launcher was never reached.
      expect(log).not.toContain("in a visible console");

      // The channel says the same thing, from the other side.
      const result = await invoke<{ ok: boolean; started: boolean }>(page, "prereqs.run", {
        stepId: "codex-cli",
      });
      expect(result).toEqual({ ok: false, started: false });

      // A step whose dependency is unmet is refused *before* the dialog: the
      // gate's first rule, and the one a UI change could silently drop.
      const blocked = await invoke<{ ok: boolean; started: boolean }>(page, "prereqs.run", {
        stepId: "codex-login",
      });
      expect(blocked).toEqual({ ok: false, started: false });
      expect(readLog(homes.userDataDir)).toContain('refusing to run "codex-login"');

      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// (h): the real config dir, read-only
// ---------------------------------------------------------------------------

test.describe("plugins, read from the real Claude config", () => {
  test.slow();

  test("(h) Plugins lists the machine's installed Claude plugins", async () => {
    fs.mkdirSync(outDir, { recursive: true });
    const homes = makeHomes("plugins");

    // What the real home actually has, read here so the assertion is against
    // the machine and not against a number this file made up.
    const installedFile = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
    test.skip(
      !fs.existsSync(installedFile),
      `no installed_plugins.json at ${installedFile} — nothing to list`,
    );
    // `installed_plugins.json` v2: `{plugins: {"<name>@<marketplace>": [...]}}`,
    // and `PluginEntry.name` is that whole key (`ClaudeConfigStore.readPlugins`).
    const installed = JSON.parse(fs.readFileSync(installedFile, "utf8")) as {
      plugins?: Record<string, unknown>;
    };
    const expectedNames = Object.keys(installed.plugins ?? {});
    test.skip(expectedNames.length === 0, "no Claude plugins are installed on this machine");

    let launched: Launched | null = null;
    try {
      // Deliberately **no** `CAPYGEN_CLAUDE_CONFIG_DIR`: this test reads the
      // real home. It only ever opens the Plugins list, which is
      // `ClaudeConfigStore.read()` — file reads and `claude plugin list
      // --json`. Nothing here writes Claude configuration.
      const { CAPYGEN_ENGINE: _drop, ...inherited } = process.env;
      const app = await electron.launch({
        args: [appDir, `--user-data-dir=${homes.userDataDir}`],
        cwd: repoRoot,
        env: {
          ...inherited,
          CAPYGEN_USER_DATA_DIR: homes.userDataDir,
          CAPYGEN_PROJECT_DIR: homes.projectDir,
          CAPYGEN_CODEX_HOME: homes.codexHome,
          ELECTRON_ENABLE_LOGGING: "0",
        },
      });
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      launched = { app, page, errors };
      await page.waitForLoadState("domcontentloaded");
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1400, 950);
      });

      await openSettings(page, "plugins");
      await page.getByTestId("plugins-tab-claude").click();
      await expect(page.getByTestId("plugins-panel-claude")).toBeVisible({ timeout: 60_000 });

      const listed = await invoke<{ plugins: { name: string }[] }>(page, "integrations.list", {
        backend: "claude",
      });
      const listedNames = listed.plugins.map((p) => p.name);
      expect(listedNames, `capygen listed: ${listedNames.join(", ")}`).toEqual(
        expect.arrayContaining(expectedNames),
      );
      // And at least one of them is on screen, not only in the channel.
      await expect(page.getByTestId("plugins-panel-claude")).toContainText(expectedNames[0]!);
      await page.screenshot({ path: path.join(outDir, "settings-plugins-real.png") });
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// (b2): the live half of R20/R29 — its own launch, against the REAL Claude home
// ---------------------------------------------------------------------------

/**
 * Why this one is not in the serial block above.
 *
 * A live Claude turn needs a signed-in Claude, and the sign-in lives in
 * `~/.claude/.credentials.json` — which `CLAUDE_CONFIG_DIR` relocates along
 * with everything else. There are only two ways to have both a live model and
 * an isolated home, and both are refused here:
 *
 *  - copy the credentials into the temp home: the SDK refreshes them from
 *    there, the refresh **rotates** the token server-side and writes the new
 *    one into a directory this file then deletes — logging the user's real
 *    Claude Code out. Not a config write, but worse than one. (It is also what
 *    the first draft of this file did, and what it cost: the turn came back
 *    `Failed to authenticate: OAuth session expired and could not be
 *    refreshed`.)
 *  - point at an API key: this machine has none (`harness.list` says so).
 *
 * So the isolation moves from the *home* to the *scope*. The server is added
 * at `project` scope, which is `<project>/.mcp.json` — a file inside a temp
 * project directory (`ClaudeConfigStore.writeProjectMcpJson`). The approval
 * `.mcp.json` servers need (`enableAllProjectMcpServers`) is seeded into that
 * same temp project's `.claude/settings.json`. `~/.claude`, `~/.claude.json`
 * and `~/.codex` are read and never written, and the test asserts that at the
 * end by comparing their mtimes with what they were before the app started.
 */
test.describe("a live Claude session sees a project-scope server", () => {
  test.slow();

  test("(b2) tools from the fixture server appear in the agent's live tool list", async () => {
    test.setTimeout(3 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const homes = makeHomes("live");

    // The approval flag, written before the app starts: it is a project
    // setting (`ClaudeConfigStore.settingsChain`) and the CLI's own gate on
    // whether it will connect to a `.mcp.json` server at all.
    fs.mkdirSync(path.join(homes.projectDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(homes.projectDir, ".claude", "settings.json"),
      `${JSON.stringify({ enableAllProjectMcpServers: true }, null, 2)}\n`,
      "utf8",
    );

    /** The real home's files, so "read-only" can be asserted rather than claimed. */
    const untouched = [
      path.join(os.homedir(), ".claude.json"),
      path.join(os.homedir(), ".claude", "settings.json"),
      path.join(os.homedir(), ".claude", ".credentials.json"),
    ].filter((file) => fs.existsSync(file));
    const before = untouched.map((file) => fs.statSync(file).mtimeMs);

    let launched: Launched | null = null;
    try {
      // No `CAPYGEN_CLAUDE_CONFIG_DIR`: the real home, for its sign-in.
      // `CAPYGEN_CODEX_HOME` stays isolated — nothing here needs Codex, and a
      // stray write would still be a write.
      const { CAPYGEN_ENGINE: _drop, ...inherited } = process.env;
      const app = await electron.launch({
        args: [appDir, `--user-data-dir=${homes.userDataDir}`],
        cwd: repoRoot,
        env: {
          ...inherited,
          CAPYGEN_USER_DATA_DIR: homes.userDataDir,
          CAPYGEN_PROJECT_DIR: homes.projectDir,
          CAPYGEN_CODEX_HOME: homes.codexHome,
          ELECTRON_ENABLE_LOGGING: "0",
        },
      });
      const page = await app.firstWindow();
      const errors: string[] = [];
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      launched = { app, page, errors };
      await page.waitForLoadState("domcontentloaded");
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1400, 950);
      });

      const rows = await invoke<{ backend: string; available: boolean; reason?: string }[]>(
        page,
        "harness.list",
        {},
      );
      const claude = rows.find((r) => r.backend === "claude");
      test.skip(!claude?.available, `Claude is unavailable: ${claude?.reason ?? "no row"}`);
      // `harness.list` answers "is Claude installed and is there a login on
      // disk", which is the right question for the New Session picker and the
      // wrong one here: an *expired* on-disk OAuth session still looks like a
      // login. The only way past an expired one is a token refresh, and that
      // rewrites the machine's real `~/.claude/.credentials.json` — a real
      // config write this suite is not allowed to cause. So the expiry is
      // read directly and the test skips rather than either failing or
      // rotating the user's own token.
      const expiry = claudeSessionExpiry();
      test.skip(
        expiry !== null && expiry <= Date.now(),
        `the machine's Claude OAuth session expired at ${
          expiry === null ? "?" : new Date(expiry).toISOString()
        }; refreshing it would rewrite the real ~/.claude/.credentials.json` +
          " — sign in with `claude` and re-run",
      );

      // 1. Add it in the UI, at project scope.
      await openSettings(page, "mcp");
      await page.getByTestId("mcp-tab-claude").click();
      await expect(page.getByTestId("mcp-panel-claude")).toBeVisible();
      await page.getByTestId("mcp-add-button").click();
      await expect(page.getByTestId("mcp-dialog")).toBeVisible();
      await page.getByTestId("mcp-input-name").fill(FIXTURE_NAME);
      await page.getByTestId("mcp-select-transport").selectOption("stdio");
      await page.getByTestId("mcp-select-scope").selectOption("project");
      await page.getByTestId("mcp-input-command").fill("node");
      await page.getByTestId("mcp-input-args").fill(FIXTURE_SERVER);
      await page.getByTestId("mcp-dialog-save").click();
      await expect(page.getByTestId(`mcp-row-${FIXTURE_NAME}`)).toBeVisible();

      // 2. Claude's own project file has it — the `.mcp.json` the CLI reads.
      const mcpJson = path.join(homes.projectDir, ".mcp.json");
      expect(fs.existsSync(mcpJson)).toBe(true);
      const written = JSON.parse(fs.readFileSync(mcpJson, "utf8")) as {
        mcpServers?: Record<string, { command?: string; args?: string[] }>;
      };
      expect(Object.keys(written.mcpServers ?? {})).toContain(FIXTURE_NAME);

      // 3. A real turn, in that project — the only moment Claude reports its
      //    tool list (`system/init`).
      await invoke(page, "settings.set", { defaultModel: CLAUDE_E2E_MODEL });
      const projects = await invoke<{ id: string; path: string }[]>(page, "projects.list", {});
      const project =
        projects.find((p) => path.resolve(p.path) === path.resolve(homes.projectDir)) ??
        projects[0]!;
      const session = await invoke<{ session: { id: string }; agents: { id: string }[] }>(
        page,
        "sessions.create",
        {
          projectId: project.id,
          mode: "solo",
          agents: [{ name: "claude", backend: "claude", model: CLAUDE_E2E_MODEL, role: "lead" }],
        },
      );
      await page.evaluate((id) => {
        window.location.hash = `#/c/${id}`;
      }, session.session.id);
      await expect(page.getByTestId("chat-page")).toBeVisible();

      const composer = page.getByTestId("chat-composer-input");
      await composer.click();
      await composer.fill("Reply with exactly the word ok.");
      await composer.press("Enter");
      await expect(page.getByTestId("turn").nth(1)).toHaveAttribute("data-status", "done", {
        timeout: LIVE_TIMEOUT_MS,
      });

      const described = await invoke<{ tools: string[] }>(page, "agents.describe", {
        agentId: session.agents[0]!.id,
      });
      const mcpTools = described.tools.filter((t) => t.startsWith(`mcp__${FIXTURE_NAME}__`));
      expect(
        mcpTools,
        `the agent reported ${described.tools.length} tools, none of them from ${FIXTURE_NAME}`,
      ).not.toEqual([]);
      await page.screenshot({ path: path.join(outDir, "settings-mcp-live-tools.png") });

      // 4. And the real home is exactly as it was.
      expect(untouched.map((file) => fs.statSync(file).mtimeMs)).toEqual(before);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });
});
