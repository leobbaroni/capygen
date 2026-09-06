/**
 * MCP Apps widgets, end to end and **live** (SPEC R31, PLAN A13).
 *
 * The one thing no unit test can prove: that a real Claude turn calling a real
 * MCP Apps server ends with the server's own HTML *running* inside capygen and
 * able to call back into that server.
 *
 * The route under test is the one the spike settled on
 * (docs/spikes/mcp-apps.md):
 *
 *   1. the fixture server is registered the way a user would register one — a
 *      `.mcp.json` in the project directory, which Claude Code reads on its
 *      own (`settingSources: ['project']`);
 *   2. Claude calls `show_card`; the SDK stream carries the call but **not**
 *      the tool's `_meta`, so the widget host asks the same server for its
 *      tool listing and its `ui://` document over capygen's own MCP client;
 *   3. the document is served from `capygen-widget://<block>/index.html` into
 *      a sandboxed frame, which completes the ext-apps handshake, receives the
 *      tool input, and calls `echo` back through the host bridge.
 *
 * Cost: one short Sonnet turn.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type FrameLocator,
  type Page,
} from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const appDir = path.join(repoRoot, "apps", "desktop");
const outDir = path.join(repoRoot, "e2e-out");
const fixtureServer = path.join(repoRoot, "tests", "fixtures", "mcp-apps-server", "server.mjs");

const LIVE_TIMEOUT_MS = 120_000;
const E2E_MODEL = "claude-sonnet-5";

interface Launched {
  app: ElectronApplication;
  page: Page;
  errors: string[];
}

async function launch(userDataDir: string, projectDir: string): Promise<Launched> {
  const errors: string[] = [];
  const { CAPYGEN_ENGINE: _drop, ...inherited } = process.env;
  const app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: {
      ...inherited,
      CAPYGEN_USER_DATA_DIR: userDataDir,
      CAPYGEN_PROJECT_DIR: projectDir,
      ELECTRON_ENABLE_LOGGING: "0",
    },
  });
  const page = await app.firstWindow();
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
  return { app, page, errors };
}

/**
 * Cheap model, and no permission card in the way.
 *
 * `bypassPermissions` is not the widget host's own posture — it is how this
 * test stays about widgets. A `default`-mode run stops on a permission card for
 * `mcp__capyfixture__show_card` before any widget exists; that path has its own
 * coverage (`skeleton.spec.ts`, R27/R32), and re-testing it here would only
 * make this run slower and flakier.
 */
async function useCheapModel(page: Page): Promise<void> {
  const settings = await page.evaluate(async (defaultModel) => {
    const bridge = (window as unknown as {
      capygen?: { invoke(channel: string, payload: unknown): Promise<unknown> };
    }).capygen;
    if (!bridge) throw new Error("preload bridge missing");
    return (await bridge.invoke("settings.set", {
      defaultModel,
      permissionMode: "bypassPermissions",
    })) as { defaultModel: string; permissionMode: string };
  }, E2E_MODEL);
  expect(settings.defaultModel).toBe(E2E_MODEL);
  expect(settings.permissionMode).toBe("bypassPermissions");
}

/**
 * A project whose `.mcp.json` registers the fixture server — the same file
 * Claude Code reads, and the same file capygen's own MCP client reads to find
 * the server again (`loadMcpServers`, source `project-mcp-json`). Registering
 * it once, in the project, is what makes both sides agree without any
 * capygen-specific configuration.
 */
function fixtureProject(tag: string): { userDataDir: string; projectDir: string } {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${tag}-`));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${tag}-proj-`));
  fs.writeFileSync(path.join(projectDir, "README.md"), "# capygen widget e2e\n", "utf8");
  fs.writeFileSync(
    path.join(projectDir, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          capyfixture: {
            type: "stdio",
            command: process.execPath,
            args: [fixtureServer],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  // Claude Code asks before trusting a project's .mcp.json; approving it up
  // front in the isolated profile keeps the run non-interactive.
  fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".claude", "settings.local.json"),
    JSON.stringify({ enableAllProjectMcpServers: true }, null, 2),
    "utf8",
  );
  return { userDataDir, projectDir };
}

test.describe("MCP Apps widget host", () => {
  test.slow();

  test("renders a fixture server's widget and round-trips a tool call from it", async () => {
    test.setTimeout(4 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = fixtureProject("widget");

    let launched: Launched | null = null;
    try {
      launched = await launch(userDataDir, projectDir);
      const page = launched.page;
      await expect(page.getByTestId("landing")).toBeVisible();
      await useCheapModel(page);

      const composer = page.getByTestId("landing-composer-input");
      await composer.click();
      await composer.fill(
        'Call the capyfixture MCP tool "show_card" with title "Hello from capygen" and ' +
          'note "widget e2e". Then reply with exactly the word done.',
      );
      await composer.press("Enter");

      // --- the widget card ---------------------------------------------
      const card = page.getByTestId("block-widget").first();
      await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(card).toHaveAttribute("data-tool", "show_card");
      await expect(card).toHaveAttribute("data-server", "capyfixture");
      // The `ui://` document was found and read (R31): the card is not the
      // fallback, and not still pending.
      await expect(card).toHaveAttribute("data-state", "ready", { timeout: LIVE_TIMEOUT_MS });

      const iframe = card.getByTestId("widget-frame");
      await expect(iframe).toBeVisible();
      // The security posture is part of the contract, not an implementation
      // detail: no same-origin, so the widget has no storage and no access to
      // the app's DOM.
      const sandbox = await iframe.getAttribute("sandbox");
      expect(sandbox).toBe("allow-scripts allow-forms");
      expect(await iframe.getAttribute("src")).toMatch(/^capygen-widget:\/\/blk[0-9a-f]+\/index\.html$/);

      // --- the widget is alive and got its tool input ------------------
      const widget: FrameLocator = card.frameLocator("iframe[data-testid='widget-frame']");
      // Set by the view once `ui/initialize` was answered by our AppBridge.
      await expect(widget.locator("body[data-initialized='1']")).toBeAttached({
        timeout: LIVE_TIMEOUT_MS,
      });
      await expect(widget.locator("#title")).toHaveText("Hello from capygen");
      await expect(widget.locator("#note")).toHaveText("widget e2e");

      // --- the widget calls a tool through the host --------------------
      await widget.locator("#ping").click();
      await expect(widget.locator("[data-testid='echo-result']")).toHaveText(
        "echo: from the widget",
        { timeout: LIVE_TIMEOUT_MS },
      );

      await page.screenshot({ path: path.join(outDir, "widget.png") });
      expect(fs.existsSync(path.join(outDir, "widget.png"))).toBe(true);
      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });
});
