/**
 * The Phase 3 harness layer, end to end and **live**: the built app, the real
 * backends, real model calls.
 *
 * `skeleton.spec.ts` proves the Claude path (Phase 2). This file proves the
 * three things that only exist once the harness *registry* is wired:
 *
 *   (a) picking Codex in the composer creates a Codex agent, and it answers
 *       with a usage/cost line (R8, R23);
 *   (b) a Codex shell approval renders as a permission card, Allow reaches the
 *       backend, and the command's output lands in the transcript (R27, R32);
 *   (c) `/` lists the built-ins *and* what Claude itself reports — the user's
 *       skills and plugin commands, e.g. `/cockpit:…` (R14);
 *   (d) an `api` agent runs capygen's own loop against a raw provider API (R9)
 *       — skipped, loudly and with a reason, when no key is stored.
 *
 * Cost: (a) and (b) are two short Codex turns; (c) is one cheap Claude turn;
 * (d) is one cheap API turn and only runs with a key. Every test needs the
 * backend it names to be signed in — `harness.list` is asked first and the test
 * skips with the backend's own reason rather than failing on a 401.
 */
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
import {
  applyPinnedDefaults,
  assertPinnedModel,
  assertSessionPinned,
  backendHomes,
  launchEnv,
  pinnedConfigFor,
  skipUntilP1,
  E2E_CLAUDE_MODEL,
  E2E_CODEX_MODEL,
  E2E_API_PROVIDER,
  E2E_EFFORT,
  type BackendHomes,
} from "./testPolicy.js";

/** One set of disposable backend homes for this spec file; a relaunch in the
 *  same test must see the same (still empty) homes. */
const homes = backendHomes("harness");
test.afterAll(() => homes.cleanup());

const repoRoot = path.resolve(__dirname, "..", "..");
const appDir = path.join(repoRoot, "apps", "desktop");
const outDir = path.join(repoRoot, "e2e-out");

/** A live turn is a real model call; Codex's first turn also spawns a child. */
const LIVE_TIMEOUT_MS = 150_000;


interface Launched {
  app: ElectronApplication;
  page: Page;
  errors: string[];
}

interface HarnessRow {
  backend: "claude" | "codex" | "api";
  label: string;
  available: boolean;
  reason?: string;
  models: { id: string; label: string }[];
  defaultModel: string;
}

async function launch(userDataDir: string, projectDir: string): Promise<Launched> {
  const errors: string[] = [];
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: launchEnv({ userDataDir, projectDir, homes }),
  });
  const page = await app.firstWindow();
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  return { app, page, errors };
}

/** Call one of the app's own IPC channels from inside the renderer. */
async function invoke<T>(page: Page, channel: string, payload: unknown): Promise<T> {
  return page.evaluate(
    async ([ch, args]) => {
      const bridge = (window as unknown as {
        capygen?: { invoke(channel: string, payload: unknown): Promise<unknown> };
      }).capygen;
      if (!bridge) throw new Error("preload bridge missing");
      return bridge.invoke(ch as string, args);
    },
    [channel, payload] as const,
  ) as Promise<T>;
}

async function harnesses(page: Page): Promise<Record<string, HarnessRow>> {
  const rows = await invoke<HarnessRow[]>(page, "harness.list", {});
  return Object.fromEntries(rows.map((r) => [r.backend, r]));
}

function tempDirs(tag: string): { userDataDir: string; projectDir: string } {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${tag}-`));
  // `realpathSync.native`, not the raw mkdtemp path: `os.tmpdir()` on this
  // machine is the 8.3 short form (`C:\Users\TUGAPL~1\…`), and Codex's Windows
  // sandbox denies an *approved* command whose cwd looks like that. The app
  // normalises `--project`/`CAPYGEN_PROJECT_DIR` the same way (`longPath` in
  // apps/desktop/src/win/projectArg.ts); this keeps the assertion below —
  // "the chip shows the folder we asked for" — comparing like with like.
  const projectDir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${tag}-proj-`)),
  );
  fs.writeFileSync(path.join(projectDir, "README.md"), "# capygen e2e fixture\n", "utf8");
  return { userDataDir, projectDir };
}

test.describe("live harness layer", () => {
  test.slow();

  test("Codex: picking it in the composer creates a Codex agent that answers", async () => {
    test.setTimeout(3 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = tempDirs("codex");

    let launched: Launched | null = null;
    try {
      launched = await launch(userDataDir, projectDir);
      const page = launched.page;
      await expect(page.getByTestId("landing")).toBeVisible();

      const codex = (await harnesses(page)).codex;
      test.skip(!codex?.available, `Codex is unavailable: ${codex?.reason ?? "no row"}`);

      // --- the picker is what chooses the backend (R8) -------------------
      await page.getByTestId("landing-composer-agent-picker").click();
      const option = page
        .getByTestId("landing-composer-agent-option")
        .filter({ hasText: /^Codex —/ })
        .first();
      await expect(option).toBeVisible();
      const optionLabel = (await option.textContent()) ?? "";
      await option.click();
      await expect(page.getByTestId("landing-composer-agent-picker")).toContainText("Codex");
      // Everything above is offline. The turn below is created by the landing
      // composer, so its effort cannot be pinned before dispatch.
      skipUntilP1("harnesses: landing picker → live Codex turn");

      const composer = page.getByTestId("landing-composer-input");
      await composer.click();
      await composer.fill("Reply with exactly the word pong.");
      await composer.press("Enter");

      await expect(page.getByTestId("chat-page")).toBeVisible();

      // The session's lead agent really is a Codex agent — not Claude with a
      // Codex label, which is exactly what happened before the registry.
      const sessionId = await page.evaluate(() => window.location.hash.split("/").pop() ?? "");
      const loaded = await invoke<{ agents: { backend: string; model: string }[] } | null>(
        page,
        "sessions.get",
        { sessionId },
      );
      expect(loaded?.agents[0]?.backend).toBe("codex");
      // The row shows Codex's own `displayName`; the agent stores the id it
      // will send on the wire. Both must be the pinned test model — asserting
      // only that the label echoes the id would pass on any model at all.
      const pickedModel = loaded?.agents[0]?.model ?? "no-model";
      expect(optionLabel.toLowerCase()).toContain(pickedModel.toLowerCase());
      assertPinnedModel("codex", pickedModel, "landing agent picker");

      const agentTurn = page.getByTestId("turn").nth(1);
      await expect(agentTurn).toHaveAttribute("data-role", "agent", {
        timeout: LIVE_TIMEOUT_MS,
      });
      await expect(
        agentTurn.getByTestId("block-text").filter({ hasText: /pong/i }).first(),
      ).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

      // R23: the meter is live for Codex too (its tokens come from
      // `thread/tokenUsage/updated`, its price from capygen's own table).
      const usage = page.getByTestId("transcript").getByTestId("block-usage").first();
      await expect(usage).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(usage).toContainText(/token|\$/i);
      await expect(agentTurn).toHaveAttribute("data-status", "done", {
        timeout: LIVE_TIMEOUT_MS,
      });

      await page.screenshot({ path: path.join(outDir, "codex-pong.png") });
      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });

  test("Codex: a shell command raises a permission card, Allow runs it", async () => {
    test.setTimeout(3 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = tempDirs("codex-approve");

    let launched: Launched | null = null;
    try {
      launched = await launch(userDataDir, projectDir);
      const page = launched.page;
      await expect(page.getByTestId("landing")).toBeVisible();

      const codex = (await harnesses(page)).codex;
      test.skip(!codex?.available, `Codex is unavailable: ${codex?.reason ?? "no row"}`);

      // `approvalPolicy: "untrusted"` through the agent's own config, because
      // the shipping default (`on-request`) lets Codex run a plain `echo` in
      // its sandbox without asking — and this test is about the card.
      const projects = await invoke<{ id: string; path: string }[]>(page, "projects.list", {});
      const project = projects.find((p) => p.path === projectDir) ?? projects[0]!;
      const created = await invoke<{ session: { id: string } }>(page, "sessions.create", {
        projectId: project.id,
        mode: "solo",
        agents: [
          {
            name: "codex",
            backend: "codex",
            model: E2E_CODEX_MODEL,
            role: "lead",
            config: {
              codex: {
                approvalPolicy: "untrusted",
                sandbox: "workspace-write",
                ...pinnedConfigFor("codex").codex as Record<string, unknown>,
              },
            },
          },
        ],
      });
      // Before the turn is sent, not after: an unpinned model or a default
      // effort has already been paid for once `press("Enter")` lands.
      await assertSessionPinned(page, created.session.id);
      await page.evaluate((id) => {
        window.location.hash = `#/c/${id}`;
      }, created.session.id);
      await expect(page.getByTestId("chat-page")).toBeVisible();

      const composer = page.getByTestId("chat-composer-input");
      await composer.click();
      await composer.fill(
        "Run the shell command `echo capybara` and then reply with its output and nothing else.",
      );
      await composer.press("Enter");

      // --- the card (R32) ------------------------------------------------
      const card = page.getByTestId("block-permission").first();
      await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(card).toHaveAttribute("data-state", "pending");
      await expect(card).toContainText(/echo/i);
      // The session is waiting on the user, and the mascot says so.
      await expect(page.getByTestId("mascot")).toHaveAttribute("data-state", "waiting");
      await page.screenshot({ path: path.join(outDir, "codex-permission.png") });

      await card.getByTestId("block-permission-allow").click();

      // --- the answer reached Codex, and the command ran -----------------
      await expect(card).not.toHaveAttribute("data-state", "pending", {
        timeout: LIVE_TIMEOUT_MS,
      });
      const shellCall = page
        .getByTestId("block-tool-call")
        .filter({ hasText: /echo capybara/ })
        .first();
      await expect(shellCall).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

      // The turn has to *finish*: "capybara" appears in the prompt and in the
      // command line, so only the agent's own closing text proves the command
      // actually ran with our approval.
      const agentTurn = page.getByTestId("turn").nth(1);
      await expect(agentTurn).toHaveAttribute("data-status", "done", {
        timeout: LIVE_TIMEOUT_MS,
      });
      await expect(
        agentTurn.getByTestId("block-text").filter({ hasText: /capybara/ }).last(),
      ).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(shellCall).toHaveAttribute("data-status", "success");

      await page.screenshot({ path: path.join(outDir, "codex-allowed.png") });
      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });

  test("Claude: `/` lists the built-ins and the backend's own skills/plugins", async () => {
    test.setTimeout(3 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = tempDirs("slash");

    let launched: Launched | null = null;
    try {
      launched = await launch(userDataDir, projectDir);
      const page = launched.page;
      await expect(page.getByTestId("landing")).toBeVisible();

      const claude = (await harnesses(page)).claude;
      test.skip(!claude?.available, `Claude is unavailable: ${claude?.reason ?? "no row"}`);
      await applyPinnedDefaults(page);
      skipUntilP1("harnesses: landing composer → live Claude turn for the slash menu");

      // One cheap turn first: Claude only reports its command list in
      // `system/init`, which arrives when the first turn starts. Before that
      // the menu is honestly built-ins-only.
      const composer = page.getByTestId("landing-composer-input");
      await composer.click();
      await composer.fill("Reply with exactly the word ok.");
      await composer.press("Enter");
      await expect(page.getByTestId("chat-page")).toBeVisible();
      await expect(page.getByTestId("turn").nth(1)).toHaveAttribute("data-status", "done", {
        timeout: LIVE_TIMEOUT_MS,
      });

      const chat = page.getByTestId("chat-composer-input");
      await chat.click();
      await chat.fill("/");
      const menu = page.getByTestId("slash-menu");
      await expect(menu).toBeVisible();

      // Built-ins are capygen's own (R14); everything else came from the
      // backend, which is the half a stub engine cannot produce.
      await expect(menu).toContainText("Built-ins");
      const sections = await menu.getByTestId("slash-menu-section").allTextContents();
      expect(
        sections.some((s) => s.startsWith("Skills") || s.startsWith("Plugins")),
        `only these sections were listed: ${JSON.stringify(sections)}`,
      ).toBe(true);

      // …including this machine's `cockpit` plugin commands.
      await chat.fill("/cockpit");
      const cockpit = menu.getByTestId("slash-menu-item").first();
      await expect(cockpit).toBeVisible();
      await expect(cockpit).toContainText(/^\/cockpit:/);

      await page.screenshot({ path: path.join(outDir, "slash-menu.png") });
      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });

  test("API model: capygen's own loop answers when a key is stored", async () => {
    test.setTimeout(3 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = tempDirs("api");

    let launched: Launched | null = null;
    try {
      launched = await launch(userDataDir, projectDir);
      const page = launched.page;
      await expect(page.getByTestId("landing")).toBeVisible();

      const api = (await harnesses(page)).api;
      // Never invents a key and never quietly passes: the reason names what is
      // missing and where to put it.
      test.skip(
        !api?.available,
        `no API key on this machine — ${api?.reason ?? "harness.list reported no api row"}. ` +
          "Add one in Settings ▸ API keys, or run with a dedicated test identity " +
          "(CAPYGEN_TEST_CLAUDE_HOME / CAPYGEN_TEST_CODEX_HOME); an ordinary offline run " +
          "strips personal provider keys on purpose (tests/e2e/testPolicy.ts).",
      );
      // Pre-flight, before a single token is spent: the policy allows exactly
      // one API pair. A machine whose API default is another provider or model
      // skips with that named — it never silently falls back onto a model the
      // policy does not allow.
      test.skip(
        api?.defaultModel !== E2E_CLAUDE_MODEL,
        `the API backend defaults to "${api?.defaultModel ?? "no model"}"; this spec may only ` +
          `spend a turn on ${E2E_API_PROVIDER}/${E2E_CLAUDE_MODEL} at ${E2E_EFFORT} effort.`,
      );
      await applyPinnedDefaults(page);
      skipUntilP1("harnesses: landing picker → live API-model turn");

      await page.getByTestId("landing-composer-agent-picker").click();
      const option = page
        .getByTestId("landing-composer-agent-option")
        .filter({ hasText: /^API model —/ })
        .first();
      await expect(option).toBeVisible();
      await option.click();

      const composer = page.getByTestId("landing-composer-input");
      await composer.click();
      await composer.fill("Reply with exactly the word pong.");
      await composer.press("Enter");

      await expect(page.getByTestId("chat-page")).toBeVisible();
      const sessionId = await page.evaluate(() => window.location.hash.split("/").pop() ?? "");
      await assertSessionPinned(page, sessionId);
      const loaded = await invoke<{ agents: { backend: string }[] } | null>(page, "sessions.get", {
        sessionId,
      });
      expect(loaded?.agents[0]?.backend).toBe("api");

      const agentTurn = page.getByTestId("turn").nth(1);
      await expect(
        agentTurn.getByTestId("block-text").filter({ hasText: /pong/i }).first(),
      ).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(
        page.getByTestId("transcript").getByTestId("block-usage").first(),
      ).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

      await page.screenshot({ path: path.join(outDir, "api-pong.png") });
      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });
});
