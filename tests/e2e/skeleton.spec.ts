/**
 * The Phase 2 walking skeleton, end to end and **live**: the built app, the
 * real Claude harness, a real model call.
 *
 * `launch.spec.ts` is the fast offline sibling (CAPYGEN_ENGINE=stub) that
 * guards the shell and the IPC path on every run. This file is the one PLAN
 * Phase 2 asks for by name — "sends 'reply with the word pong', and the
 * transcript shows the Claude reply; relaunch restores the session" — so it
 * costs tokens and needs the machine's Claude login. It proves what a double
 * cannot:
 *
 *   1. landing → composer → Claude Agent SDK → text block + usage/cost (R5,
 *      R6, R23), then app close → relaunch → same transcript from SQLite (R15);
 *   2. an `AskUserQuestion` tool call surfaced as a card, answered in the UI,
 *      and the answer reaching the model, which echoes it back (R32).
 *
 * Cost control: the session's model is set to Sonnet through the real
 * `settings.set` channel before the first turn, instead of the shipping
 * default (Opus). Two short turns per test.
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

const repoRoot = path.resolve(__dirname, "..", "..");
const appDir = path.join(repoRoot, "apps", "desktop");
const outDir = path.join(repoRoot, "e2e-out");

/** A live turn is a real model call: the 60s default is not enough. */
const LIVE_TIMEOUT_MS = 120_000;

/** Cheap and fast; the shipping default (Opus) would work but costs more. */
const E2E_MODEL = "claude-sonnet-5";

interface Launched {
  app: ElectronApplication;
  page: Page;
  errors: string[];
}

/**
 * Launch the built app into the given profile. `CAPYGEN_ENGINE` is deliberately
 * *unset* — this suite runs the real harness. `CAPYGEN_PROJECT_DIR` pre-selects
 * the working directory so the landing never opens the native folder picker
 * (apps/desktop/src/win/projectArg.ts); it is also honoured as
 * `--project=<dir>`.
 */
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

/** Point new sessions at the cheap model, through the app's own IPC. */
async function useCheapModel(page: Page): Promise<void> {
  const model = await page.evaluate(async (defaultModel) => {
    const bridge = (window as unknown as {
      capygen?: { invoke(channel: string, payload: unknown): Promise<unknown> };
    }).capygen;
    if (!bridge) throw new Error("preload bridge missing");
    const next = (await bridge.invoke("settings.set", { defaultModel })) as {
      defaultModel: string;
    };
    return next.defaultModel;
  }, E2E_MODEL);
  expect(model).toBe(E2E_MODEL);
}

function tempDirs(tag: string): { userDataDir: string; projectDir: string } {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${tag}-`));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `capygen-${tag}-proj-`));
  // Something for the agent to look at if it ever decides to; an empty folder
  // is a legitimate project too, but a README keeps `cwd` from looking broken.
  fs.writeFileSync(path.join(projectDir, "README.md"), "# capygen e2e fixture\n", "utf8");
  return { userDataDir, projectDir };
}

test.describe("live Claude walking skeleton", () => {
  test.slow();

  test("landing → Claude reply → persisted across a relaunch", async () => {
    test.setTimeout(4 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = tempDirs("live");

    let first: Launched | null = null;
    let second: Launched | null = null;
    try {
      first = await launch(userDataDir, projectDir);
      const page = first.page;

      // --- the landing (R1) --------------------------------------------
      await expect(page.getByTestId("landing")).toBeVisible();
      await expect(page.getByTestId("landing-heading")).toHaveText("What should we build?");
      const mascot = page.getByTestId("mascot");
      await expect(mascot).toHaveAttribute("data-state", "idle");
      // The mascot is a real image, not a placeholder box.
      const mascotImg = mascot.locator("img").first();
      await expect(mascotImg).toHaveAttribute("src", /mascot\/idle\.png$/);
      expect(
        await mascotImg.evaluate((el) => (el as HTMLImageElement).naturalWidth),
      ).toBeGreaterThan(0);
      await expect(page.getByTestId("project-chip")).toContainText(path.basename(projectDir));

      await useCheapModel(page);

      // --- one live turn (R5, R6, R23) ---------------------------------
      const composer = page.getByTestId("landing-composer-input");
      await composer.click();
      await composer.fill("Reply with exactly the word pong.");
      await composer.press("Enter");

      await expect(page.getByTestId("chat-page")).toBeVisible();
      const transcript = page.getByTestId("transcript");

      // The agent's answer: a text block containing "pong", in the agent turn
      // (the first text block is the user's own message).
      const agentTurn = page.getByTestId("turn").nth(1);
      await expect(agentTurn).toHaveAttribute("data-role", "agent", {
        timeout: LIVE_TIMEOUT_MS,
      });
      await expect(
        agentTurn.getByTestId("block-text").filter({ hasText: /pong/i }).first(),
      ).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

      // The usage meter for that turn, with a real cost (R23).
      const usage = transcript.getByTestId("block-usage").first();
      await expect(usage).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(usage).toContainText("$");
      const usageText = (await usage.textContent()) ?? "";
      expect(usageText, `usage line was ${JSON.stringify(usageText)}`).toMatch(
        /\$\s?\d/,
      );

      // The turn actually closed, so the composer is usable again.
      await expect(agentTurn).toHaveAttribute("data-status", "done", {
        timeout: LIVE_TIMEOUT_MS,
      });

      await page.screenshot({ path: path.join(outDir, "chat-pong.png") });
      expect(fs.existsSync(path.join(outDir, "chat-pong.png"))).toBe(true);

      const transcriptBefore = (await transcript.textContent()) ?? "";
      expect(transcriptBefore).toMatch(/pong/i);
      expect(first.errors, first.errors.join(" | ")).toEqual([]);

      // --- relaunch on the same profile (R15) --------------------------
      await first.app.close();
      first = null;

      second = await launch(userDataDir, projectDir);
      const restored = second.page;

      // The session survived as rows, not React state.
      expect(fs.existsSync(path.join(userDataDir, "capygen.db"))).toBe(true);
      const row = restored.getByTestId("session-row").first();
      await expect(row).toBeVisible();
      await expect(row).toContainText("Reply with exactly");

      await row.click();
      await expect(restored.getByTestId("chat-page")).toBeVisible();
      const restoredTranscript = restored.getByTestId("transcript");
      await expect(
        restoredTranscript.getByTestId("block-text").filter({ hasText: /pong/i }).first(),
      ).toBeVisible();
      await expect(restoredTranscript.getByTestId("block-usage").first()).toBeVisible();
      // Same turns, same order — nothing invented on the way back from SQLite.
      await expect(restored.getByTestId("turn")).toHaveCount(2);
      await expect(restored.getByTestId("turn").first()).toHaveAttribute("data-role", "user");

      await restored.screenshot({ path: path.join(outDir, "restored.png") });
      expect(fs.existsSync(path.join(outDir, "restored.png"))).toBe(true);
      expect(second.errors, second.errors.join(" | ")).toEqual([]);
    } finally {
      await first?.app.close().catch(() => undefined);
      await second?.app.close().catch(() => undefined);
    }
  });

  test("answers an AskUserQuestion card and the answer reaches the model", async () => {
    test.setTimeout(4 * LIVE_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    const { userDataDir, projectDir } = tempDirs("ask");

    let launched: Launched | null = null;
    try {
      launched = await launch(userDataDir, projectDir);
      const page = launched.page;
      await expect(page.getByTestId("landing")).toBeVisible();
      await useCheapModel(page);

      const composer = page.getByTestId("landing-composer-input");
      await composer.click();
      await composer.fill(
        "Use the AskUserQuestion tool to ask me red or blue; then reply with just my answer.",
      );
      await composer.press("Enter");

      // The card the harness renders from `canUseTool("AskUserQuestion")`.
      const card = page.getByTestId("block-question").first();
      await expect(card).toBeVisible({ timeout: LIVE_TIMEOUT_MS });
      await expect(card).toHaveAttribute("data-state", "pending");

      // The mascot says the session is waiting on the user (CONTEXT.md §Mascot).
      await expect(page.getByTestId("mascot")).toHaveAttribute("data-state", "waiting");

      // A single-select question renders real radios now (the reference's own
      // contract), so the option is a radio, not a button.
      const blue = card.getByRole("radio", { name: /blue/i }).first();
      await expect(blue).toBeVisible();
      await blue.check();
      await card.getByTestId("block-question-submit").click();

      // The block flips to answered, and the answer is what we picked.
      await expect(card).toHaveAttribute("data-state", "responded", {
        timeout: LIVE_TIMEOUT_MS,
      });
      await expect(card).toContainText(/blue/i);

      // …and the model, unblocked, answers with it.
      await expect(
        page
          .getByTestId("turn")
          .last()
          .getByTestId("block-text")
          .filter({ hasText: /blue/i })
          .first(),
      ).toBeVisible({ timeout: LIVE_TIMEOUT_MS });

      await page.screenshot({ path: path.join(outDir, "chat-question.png") });
      expect(launched.errors, launched.errors.join(" | ")).toEqual([]);
    } finally {
      await launched?.app.close().catch(() => undefined);
    }
  });
});
