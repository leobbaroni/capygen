/**
 * Phase 6 end to end: the Settings hub, two-way config sync and the
 * prerequisites gate (SPEC R3, R19-R21, R27-R30; PLAN A9, A14).
 *
 * **Isolation first.** Every test that can write a backend's configuration
 * runs against a temp `CLAUDE_CONFIG_DIR` and a temp `CODEX_HOME`, handed to
 * the app as `CAPYGEN_CLAUDE_CONFIG_DIR` / `CAPYGEN_CODEX_HOME`
 * (`apps/desktop/src/win/configHomes.ts` maps them onto the CLIs' own
 * variables for the app, for every child it spawns and for the config stores).
 * The machine's real `~/.claude` and `~/.codex` are never read or written by
 * this file — not for a fixture, not for a baseline, and not to check an
 * OAuth expiry. The one test that spends a live turn (b2) runs only against a
 * **dedicated, separately authenticated** identity and skips before it
 * launches anything when there is none (`tests/e2e/testPolicy.ts`).
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
 *       the same add, done at **project** scope in a temp project directory.
 *       Runs only against a dedicated test identity, on the pinned model at
 *       low effort; skips before launching when there is none;
 *   (c) an edit made **outside** the app (a `permissions.allow` entry appended
 *       to the isolated `settings.json`) reaches the Tools table within 3 s —
 *       the watcher half of R29;
 *   (d) Codex: adding a server in the UI patches `config.toml` **without
 *       losing the comments that were already in it**, and an external edit to
 *       the same file comes back into the UI;
 *   (e) an API key stored through Providers is absent, as plaintext, from the
 *       settings database, the log file and every config file — while
 *       `secrets.has` is true (R21);
 *   (f) with an isolated signed-out Codex home the setup panel offers login, and Run…
 *       reaches the confirm dialog and spawns **nothing** when it is cancelled
 *       (R3, R27);
 *   (g) the dark-theme screenshot, `e2e-out/settings-dark.png`;
 *   (h) Plugins lists the installed Claude plugins of the config home the app
 *       was given — a synthetic registry written into the isolated home, so
 *       the reader is asserted against known bytes.
 *
 * Cost: (b2) is one short Claude turn (a few cents) and only with a dedicated
 * identity. Everything else is offline: no model, no network, no personal
 * configuration.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  applyPinnedDefaults,
  assertSessionPinned,
  backendHomes,
  launchEnv,
  pinnedConfigFor,
  usingDedicatedIdentity,
  E2E_CLAUDE_MODEL,
} from "./testPolicy.js";
import { nativeClaudePath } from "./nativeClaude.js";

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
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${homes.userDataDir}`],
    cwd: repoRoot,
    // Both CAPYGEN_* mappings and the CLIs' own CLAUDE_CONFIG_DIR/CODEX_HOME
    // come from `homes`; `extra` cannot overwrite either (testPolicy.ts).
    env: launchEnv({
      userDataDir: homes.userDataDir,
      projectDir: homes.projectDir,
      homes: { claudeHome: homes.claudeHome, codexHome: homes.codexHome },
      extra: extraEnv,
    }),
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
 * A synthetic installed-plugin registry inside an isolated Claude home.
 *
 * (h) used to read the machine's own
 * `~/.claude/plugins/installed_plugins.json` and assert capygen listed what it
 * found there. That made the assertion depend on the developer's personal
 * configuration — it skipped on a machine with no plugins, changed meaning
 * when they installed one, and read a personal file for no benefit the fixture
 * cannot give. The *reader* is what is under test (`ClaudeConfigStore
 * .readPlugins`: v2 `{plugins: {"<name>@<marketplace>": [{installPath, …}]}}`,
 * `enabledPlugins` merged along the settings chain, `commands/` and `skills/`
 * enumerated under `installPath`), and a fixture exercises every one of those
 * branches deterministically.
 */
interface PluginFixture {
  names: string[];
  disabledName: string;
  skillName: string;
}

function writePluginFixture(claudeHome: string): PluginFixture {
  const cacheRoot = path.join(claudeHome, "plugins", "cache");
  const entries = [
    { name: "alpha-tools@capygen-fixtures", version: "1.2.3", enabled: true },
    { name: "beta-tools@capygen-fixtures", version: "0.9.0", enabled: false },
  ];
  const table: Record<string, unknown[]> = {};
  for (const entry of entries) {
    const installPath = path.join(cacheRoot, entry.name.replace("@", "__"));
    fs.mkdirSync(path.join(installPath, "commands"), { recursive: true });
    fs.mkdirSync(path.join(installPath, "skills", "fixture-skill"), { recursive: true });
    fs.writeFileSync(
      path.join(installPath, "skills", "fixture-skill", "SKILL.md"),
      "---\nname: fixture-skill\ndescription: a fixture\n---\n",
      "utf8",
    );
    table[entry.name] = [{ installPath, version: entry.version }];
  }
  fs.mkdirSync(path.join(claudeHome, "plugins"), { recursive: true });
  fs.writeFileSync(
    path.join(claudeHome, "plugins", "installed_plugins.json"),
    `${JSON.stringify({ plugins: table }, null, 2)}\n`,
    "utf8",
  );
  // `enabledPlugins` lives in the settings chain, not in the registry, so the
  // disabled one proves the merge rather than the registry parse.
  fs.writeFileSync(
    path.join(claudeHome, "settings.json"),
    `${JSON.stringify(
      {
        enabledPlugins: Object.fromEntries(entries.map((e) => [e.name, e.enabled])),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    names: entries.map((e) => e.name),
    disabledName: entries[1]!.name,
    skillName: "fixture-skill",
  };
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

/** Case- and separator-insensitive path equality (Windows). */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** True when `file` is inside one of `roots` (or is one of them). */
function isInsideAny(file: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(path.resolve(root), path.resolve(file));
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

/**
 * Every file under `roots` whose text contains `needle`. Used to prove a UI
 * write landed inside the directories the test owns — without opening a single
 * file outside them, which is what makes it a safe replacement for reading the
 * developer's own `~/.claude.json`.
 */
function filesContaining(roots: string[], needle: string): string[] {
  const out: string[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue; // binary or locked: cannot carry the name as text anyway
      }
      if (text.includes(needle)) out.push(file);
    }
  }
  return out;
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
    // R29 writes through the real CLI; use the pinned dependency on clean CI.
    const fixturePath = [path.dirname(nativeClaudePath(repoRoot)), path.dirname(process.execPath), path.join(process.env.SystemRoot!, "System32"),
      process.env.SystemRoot!].join(path.delimiter);
    launched = await launch(homes, { PATH: fixturePath, Path: fixturePath });
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

    try {
      await expect(page.getByTestId(`mcp-row-${FIXTURE_NAME}`)).toBeVisible({ timeout: 15_000 });
    } catch (error) {
      const submitError = await page.getByTestId("mcp-submit-error").allTextContents().catch(() => []);
      const panel = await page.getByTestId("mcp-panel-claude").innerText().catch(() => "");
      throw new Error(`MCP add did not appear: ${submitError.join(" | ") || "no submit error"}\n${panel}`, { cause: error });
    }
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
      cliOutput = execFileSync(nativeClaudePath(repoRoot), ["mcp", "list"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 60_000,
        cwd: homes.projectDir,
        env: launchEnv({ userDataDir: homes.userDataDir, projectDir: homes.projectDir,
          homes: { claudeHome: homes.claudeHome, codexHome: homes.codexHome } }),
      });
    } catch (err) {
      // `claude mcp list` exits non-zero when a listed server fails to
      // connect; its stdout is still the answer.
      cliOutput = String((err as { stdout?: string }).stdout ?? "");
    }
    expect(cliOutput, `claude mcp list said:\n${cliOutput}`).toContain(FIXTURE_NAME);

    // 3. Containment, proved without opening a personal file.
    //
    //    The old assertion here read `~/.claude.json` and checked the fixture
    //    name was absent. That reads the developer's own configuration to
    //    prove a negative about it — and it only ever covered *one* personal
    //    file. Two stronger, fully-local proofs replace it:
    //
    //    (i) the app says which home it resolved. `diagnostics.get` reports
    //        the `claudeHome`/`codexHome` the running app is actually using,
    //        so an app that had fallen back to the real home fails here,
    //        before any file is inspected.
    const diagnostics = await invoke<{ paths: Record<string, string> }>(
      page,
      "diagnostics.get",
      {},
    );
    expect(
      samePath(diagnostics.paths.claudeHome ?? "", homes.claudeHome),
      `the app resolved claudeHome=${diagnostics.paths.claudeHome}, not the isolated ${homes.claudeHome}`,
    ).toBe(true);
    expect(samePath(diagnostics.paths.codexHome ?? "", homes.codexHome)).toBe(true);

    //    (ii) every byte carrying the fixture name lives inside a directory
    //         this test created. `filesContaining` walks the isolated homes and
    //         the temp project and returns the files that mention it; the
    //         write must have landed in at least one of them, and the CLI
    //         agreeing above is independent evidence that it landed where the
    //         backend looks. Nothing outside those roots is opened at all.
    const carriers = filesContaining(
      [homes.claudeHome, homes.codexHome, homes.projectDir],
      FIXTURE_NAME,
    );
    expect(
      carriers.map((f) => path.relative(homes.claudeHome, f)),
      "the UI write did not land inside the isolated Claude home",
    ).toContain(".claude.json");
    for (const file of carriers) {
      expect(
        isInsideAny(file, [homes.claudeHome, homes.codexHome, homes.projectDir]),
        `${file} is outside every directory this test owns`,
      ).toBe(true);
    }
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

  test("(f) a signed-out Codex offers login; Run… asks first and spawns nothing", async () => {
    fs.mkdirSync(outDir, { recursive: true });
    const homes = makeHomes("prereq");
    const sdkPackage = fs.realpathSync(path.join(repoRoot, "apps/desktop/node_modules/@openai/codex-sdk/package.json"));
    const codexPackage = createRequire(sdkPackage).resolve("@openai/codex/package.json");
    const platformPackage = createRequire(codexPackage).resolve("@openai/codex-win32-x64/package.json");
    const cliDirectory = path.join(path.dirname(platformPackage), "vendor/x86_64-pc-windows-msvc/bin");
    expect(fs.existsSync(path.join(cliDirectory, "codex.exe"))).toBe(true);
    const cliPath = [cliDirectory, process.env.PATH ?? ""].join(path.delimiter);

    let launched: Launched | null = null;
    try {
      launched = await launch(homes, {
        // Use the pinned CLI even on clean CI with no global Codex installation.
        PATH: cliPath,
        Path: cliPath,
        // The one seam: the confirm dialog answers Cancel without drawing.
        // Everything else about the gate — the refusal rules, the console
        // launcher — is the shipping code.
        CAPYGEN_PREREQ_CONFIRM: "cancel",
      });
      const page = launched.page;
      await openSettings(page, "prereqs");
      await expect(page.getByTestId("prereq-panel")).toBeVisible({ timeout: 60_000 });
      // Mount already runs detection. Do not launch a second set of cold
      // PowerShell probes concurrently on the hosted Windows runner.
      await expect(page.getByTestId("prereq-redetect")).toBeEnabled({ timeout: 60_000 });

      const status = await invoke<{ steps: { id: string; detected: boolean; command?: string }[] }>(page, "prereqs.status", {});
      const codexCli = status.steps.find((step) => step.id === "codex-cli")!;
      const codexLogin = status.steps.find((step) => step.id === "codex-login")!;
      expect(codexCli.detected).toBe(true);
      expect(codexLogin.detected).toBe(false);
      await page.getByTestId("prereq-redetect").click();
      const codexStep = page.locator('[data-testid="prereq-step-row"][data-step-id="codex-login"]');
      await expect(codexStep).toBeVisible({ timeout: 60_000 });
      await expect(codexStep).toHaveAttribute("data-detected", "false", { timeout: 60_000 });
      await expect(codexStep.getByTestId("prereq-step-run")).toBeEnabled({ timeout: 60_000 });
      expect(codexLogin.command).toBeTruthy();
      await expect(codexStep).toContainText(codexLogin.command!);
      await page.screenshot({ path: path.join(outDir, "settings-prereqs.png") });

      // R3/R27: the button asks, and a Cancel runs nothing.
      await codexStep.getByTestId("prereq-step-run").click();

      await expect
        .poll(() => readLog(homes.userDataDir), { timeout: 20_000 })
        .toContain("CAPYGEN_PREREQ_CONFIRM=cancel");
      const log = readLog(homes.userDataDir);
      // The dialog it built was for this step's exact command…
      expect(log).toContain(codexLogin.command!);
      // …and the console launcher was never reached.
      expect(log).not.toContain("in a visible console");

      // The channel says the same thing, from the other side.
      const result = await invoke<{ ok: boolean; started: boolean }>(page, "prereqs.run", {
        stepId: "codex-login",
      });
      expect(result).toEqual({ ok: false, started: false });

      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// (h): the real config dir, read-only
// ---------------------------------------------------------------------------

test.describe("plugins, read from an isolated Claude config", () => {
  test.slow();

  test("(h) Plugins lists the installed Claude plugins of the config home it was given", async () => {
    fs.mkdirSync(outDir, { recursive: true });
    const homes = makeHomes("plugins");
    // The registry is written into the *isolated* home, so this asserts the
    // real reader against known bytes and never opens the developer's own
    // `~/.claude`. See `writePluginFixture` for why.
    const fixture = writePluginFixture(homes.claudeHome);

    let launched: Launched | null = null;
    try {
      launched = await launch(homes);
      const page = launched.page;

      await openSettings(page, "plugins");
      await page.getByTestId("plugins-tab-claude").click();
      await expect(page.getByTestId("plugins-panel-claude")).toBeVisible({ timeout: 60_000 });

      const listed = await invoke<{
        plugins: { name: string; version?: string; marketplace?: string; enabled: boolean; installed: boolean; skills: string[] }[];
      }>(page, "integrations.list", { backend: "claude" });
      const listedNames = listed.plugins.map((p) => p.name);
      expect(listedNames, `capygen listed: ${listedNames.join(", ")}`).toEqual(
        expect.arrayContaining(fixture.names),
      );

      // The reader's real branches, each asserted rather than assumed:
      const alpha = listed.plugins.find((p) => p.name === fixture.names[0]);
      expect(alpha?.version).toBe("1.2.3");
      expect(alpha?.marketplace).toBe("capygen-fixtures");
      expect(alpha?.installed).toBe(true);
      expect(alpha?.enabled).toBe(true);
      // `skills` are enumerated under the install path, not declared.
      expect(alpha?.skills).toContain(fixture.skillName);
      // `enabledPlugins` is merged from the settings chain, not the registry.
      const beta = listed.plugins.find((p) => p.name === fixture.disabledName);
      expect(beta?.enabled).toBe(false);

      // And at least one of them is on screen, not only in the channel.
      await expect(page.getByTestId("plugins-panel-claude")).toContainText(fixture.names[0]!);
      await page.screenshot({ path: path.join(outDir, "settings-plugins-isolated.png") });
      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// (b2): the live half of R20/R29 — its own launch, against a DEDICATED test
//       identity (never the personal home); skips before launching without one
// ---------------------------------------------------------------------------

/**
 * Why this one is not in the serial block above, and why it needs a dedicated
 * identity.
 *
 * A live Claude turn needs a signed-in Claude, and the sign-in lives in
 * `.credentials.json` inside whatever `CLAUDE_CONFIG_DIR` points at. The
 * earlier version of this test solved that by pointing the app at the
 * developer's **real** home and asserting afterwards, from file mtimes, that
 * nothing had been written. Three things were wrong with that:
 *
 *  - it read personal files (`~/.claude.json`, `~/.claude/settings.json` and
 *    `~/.claude/.credentials.json`) to build the mtime baseline, and parsed
 *    the credentials file to check the OAuth expiry;
 *  - an mtime comparison is an after-the-fact check: by the time it fails the
 *    write has already happened;
 *  - a token refresh rewrites the real credentials file as a *side effect* of
 *    the turn, which is exactly the write it was trying to rule out.
 *
 * So the rule is now the plan's rule: a live turn runs only against a
 * persistent, separately authenticated test identity
 * (`CAPYGEN_TEST_CLAUDE_HOME` / `CAPYGEN_TEST_CODEX_HOME`, validated against
 * the personal roots in both directions by `tests/e2e/testPolicy.ts`), and the
 * decision is made **before** the app is launched or any probe runs. With no
 * dedicated identity the test skips having touched nothing at all. Nothing
 * here copies credentials anywhere; sign in inside that home, by hand, once.
 *
 * The server is still added at `project` scope — `<project>/.mcp.json` in a
 * temp directory — so even the dedicated home is not written by the test.
 */
test.describe("a live Claude session sees a project-scope server", () => {
  test.slow();

  test("(b2) tools from the fixture server appear in the agent's live tool list", async () => {
    // Decided before anything is launched, spawned or read.
    test.skip(
      !usingDedicatedIdentity(),
      "(b2) spends a real Claude turn and so runs only against a dedicated test identity: " +
        "set CAPYGEN_TEST_CLAUDE_HOME and CAPYGEN_TEST_CODEX_HOME to persistent directories " +
        "that have their own `claude` sign-in. Personal config is never used and credentials " +
        "are never copied (tests/e2e/testPolicy.ts).",
    );
    test.setTimeout(3 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });

    // The dedicated homes, validated; `makeHomes` still supplies the temp
    // profile and the temp project the server is actually written into.
    const dedicated = backendHomes("settings-live");
    const homes: Homes = { ...makeHomes("live"), claudeHome: dedicated.claudeHome, codexHome: dedicated.codexHome };

    // The approval flag, written before the app starts: it is a project
    // setting (`ClaudeConfigStore.settingsChain`) and the CLI's own gate on
    // whether it will connect to a `.mcp.json` server at all.
    fs.mkdirSync(path.join(homes.projectDir, ".claude"), { recursive: true });
    fs.writeFileSync(
      path.join(homes.projectDir, ".claude", "settings.json"),
      `${JSON.stringify({ enableAllProjectMcpServers: true }, null, 2)}\n`,
      "utf8",
    );

    let launched: Launched | null = null;
    try {
      // Both homes explicit, both dedicated: no implicit fallback to the real
      // home for either backend.
      launched = await launch(homes);
      const page = launched.page;

      // The app's own answer about the identity it is using, before the turn.
      const diagnostics = await invoke<{ paths: Record<string, string> }>(
        page,
        "diagnostics.get",
        {},
      );
      expect(
        samePath(diagnostics.paths.claudeHome ?? "", homes.claudeHome),
        `the app resolved claudeHome=${diagnostics.paths.claudeHome}, not the dedicated ${homes.claudeHome}`,
      ).toBe(true);

      const rows = await invoke<{ backend: string; available: boolean; reason?: string }[]>(
        page,
        "harness.list",
        {},
      );
      const claude = rows.find((r) => r.backend === "claude");
      // The backend's own reason. An expired session inside the dedicated home
      // surfaces here; capygen reports it rather than this test parsing a
      // credentials file to find out.
      test.skip(
        !claude?.available,
        `Claude cannot take a turn in the dedicated test home: ${claude?.reason ?? "no row"}` +
          " — run `claude` with CLAUDE_CONFIG_DIR set to that home and sign in, then re-run.",
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
      //    tool list (`system/init`). Pinned model and pinned effort: the e2e
      //    policy allows exactly one Claude model, at low effort.
      await applyPinnedDefaults(page);
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
          agents: [
            {
              name: "claude",
              backend: "claude",
              model: E2E_CLAUDE_MODEL,
              role: "lead",
              config: pinnedConfigFor("claude"),
            },
          ],
        },
      );
      // Refuses to spend a turn on anything but the pinned model/effort.
      await assertSessionPinned(page, session.session.id);
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

      // 4. The server was written into the temp project, not into the
      //    dedicated home — asserted from the files this test owns.
      expect(
        filesContaining([homes.projectDir], FIXTURE_NAME).map((f) =>
          path.relative(homes.projectDir, f),
        ),
      ).toContain(".mcp.json");
    } finally {
      await launched?.app.close().catch(() => undefined);
      // Never removes a dedicated home: `backendHomes` returns a no-op cleanup
      // for one, and the temp project/profile are handled by `created`.
      dedicated.cleanup();
    }
  });
});
