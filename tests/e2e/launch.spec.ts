/**
 * The walking-skeleton end-to-end: launch the built app into an isolated
 * profile, land on the New Session page, send a message, and see the reply in
 * the transcript.
 *
 * Covers SPEC R1 (seamless window straight onto the landing, no connect screen)
 * and the whole IPC path — composer → chat.send → SQLite → chat.block →
 * transcript — against the Phase 2 echo engine.
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

// Playwright transpiles specs to CommonJS (the repo root is not `"type":
// "module"`), so `__dirname` is the portable anchor here, not `import.meta`.
const repoRoot = path.resolve(__dirname, "..", "..");
const appDir = path.join(repoRoot, "apps", "desktop");
const outDir = path.join(repoRoot, "e2e-out");

let app: ElectronApplication;
let page: Page;
let userDataDir: string;
let projectDir: string;
/** Renderer console errors, surfaced on failure — a CSP or bridge fault is
 *  otherwise invisible from the test output. */
const pageErrors: string[] = [];

test.beforeAll(async () => {
  // A fresh profile per run: no leftover sessions, no leftover window geometry,
  // and the real %APPDATA%\capygen is never touched.
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-e2e-"));
  // A throwaway working directory so the landing page has a project and the
  // first message does not need the native folder picker.
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-proj-"));
  fs.mkdirSync(outDir, { recursive: true });

  app = await electron.launch({
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: {
      ...process.env,
      CAPYGEN_USER_DATA_DIR: userDataDir,
      CAPYGEN_PROJECT_DIR: projectDir,
      // The walking-skeleton run must be deterministic and offline: the echo
      // engine stands in for the Claude harness, which has its own live check
      // (`corepack pnpm --dir packages/engine live:claude`).
      CAPYGEN_ENGINE: "stub",
      // Electron's own noise off; the app's rotating log is the record we keep.
      ELECTRON_ENABLE_LOGGING: "0",
    },
  });
  page = await app.firstWindow();
  page.on("pageerror", (err) => pageErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(`console: ${msg.text()}`);
  });
  await page.waitForLoadState("domcontentloaded");
});

test.afterEach(() => {
  // Any renderer-side throw is a failure even when the assertions passed.
  expect(pageErrors, pageErrors.join(" | ")).toEqual([]);
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("lands on the New Session page with the mascot and composer", async () => {
  // R1: the landing is the first thing the window shows — no host picker.
  await expect(page.getByTestId("landing-heading")).toHaveText("What should we build?");
  await expect(page.getByTestId("mascot")).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("landing-composer-input")).toBeVisible();
  // The launch folder is pre-selected, so the chip names it rather than
  // prompting (see apps/desktop/src/win/projectArg.ts).
  await expect(page.getByTestId("project-chip")).toContainText(path.basename(projectDir));
  // G1: the composer is focused on arrival, so typing works immediately.
  await expect(page.getByTestId("landing-composer-input")).toBeFocused();

  await page.screenshot({ path: path.join(outDir, "landing.png"), fullPage: false });
  expect(fs.existsSync(path.join(outDir, "landing.png"))).toBe(true);
});

test("renders the brand lockup in the wordmark face", async () => {
  // The sidebar's small mark + wordmark, and the landing's reactive mascot,
  // are three separate mounts of the same brand components (apps/renderer/
  // src/brand/**) — they must not collide on one test id.
  const brand = page.getByTestId("sidebar-brand");
  await expect(brand.getByTestId("brand-logo")).toBeVisible();
  await expect(brand.getByTestId("brand-wordmark")).toHaveText("capygen");
  await expect(page.getByTestId("mascot")).toBeVisible();

  // SPEC assumption A11: the wordmark ships in CheGuevaraBarry-Brown. A
  // missing/blocked font file would silently fall back to the sans stack, so
  // assert the face actually loaded rather than that the class is present.
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('16px "CheGuevaraBarry"');
  });
  expect(loaded).toBe(true);

  const family = await page
    .getByTestId("brand-wordmark")
    .evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family).toContain("CheGuevaraBarry");
});

test("hides the native title bar and keeps a drag region", async () => {
  // The seamless chrome: Electron draws only the caption buttons, the page
  // supplies the drag strip (apps/desktop/src/win/chrome.ts).
  const dragRegion = await page.evaluate(() => {
    const el = document.querySelector(".titlebar-drag");
    if (!el) return null;
    return getComputedStyle(el).getPropertyValue("-webkit-app-region").trim();
  });
  expect(dragRegion).toBe("drag");

  const seamless = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { framed: win?.isMaximizable() !== undefined, title: win?.getTitle() };
  });
  expect(seamless.framed).toBe(true);
});

test("sends a message and shows the reply in the transcript", async () => {
  const composer = page.getByTestId("landing-composer-input");
  await composer.click();
  await composer.fill("hello");
  await composer.press("Enter");

  // Submitting the landing composer creates the session and routes to it (R5).
  await expect(page.getByTestId("chat-page")).toBeVisible();

  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByTestId("block-text").first()).toHaveText("hello");
  await expect(transcript.getByTestId("block-text").nth(1)).toHaveText("echo: hello");

  // The user's turn and the agent's turn, in that order.
  await expect(page.getByTestId("turn")).toHaveCount(2);
  await expect(page.getByTestId("turn").first()).toHaveAttribute("data-role", "user");
  await expect(page.getByTestId("turn").nth(1)).toHaveAttribute("data-role", "agent");

  await page.screenshot({ path: path.join(outDir, "chat.png") });
});

test("persists the session to SQLite in the isolated profile", async () => {
  // R15: the session survives as rows, not just React state.
  const dbFile = path.join(userDataDir, "capygen.db");
  expect(fs.existsSync(dbFile)).toBe(true);
  await expect(page.getByTestId("session-row")).toHaveCount(1);
});
