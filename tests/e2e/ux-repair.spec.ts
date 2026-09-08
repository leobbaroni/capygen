/** Native, offline UX repair proof. Every writable path belongs to this fixture. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { launchEnv } from "./testPolicy.js";

const repoRoot = path.resolve(__dirname, "..", "..");

test("dark landing, custom setup, compact settings and attachments remain usable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-ux-repair-"));
  const userDataDir = path.join(root, "profile");
  const projectDir = path.join(root, "project");
  const homes = { claudeHome: path.join(root, "claude"), codexHome: path.join(root, "codex"), dedicated: false, cleanup() {} };
  for (const dir of [userDataDir, projectDir, homes.claudeHome, homes.codexHome]) fs.mkdirSync(dir, { recursive: true });
  const outDir = path.join(repoRoot, "e2e-out");
  fs.mkdirSync(outDir, { recursive: true });
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [path.join(repoRoot, "apps", "desktop"), `--user-data-dir=${userDataDir}`], cwd: repoRoot, env: launchEnv({ userDataDir, projectDir, homes, engine: "stub" }) });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, dialog }) => {
      BrowserWindow.getAllWindows()[0]!.setSize(900, 600);
      // Any unexpected native folder prompt fails immediately rather than hanging.
      dialog.showOpenDialog = async () => { throw new Error("Unexpected folder picker in preselected-project flow"); };
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.getByTestId("landing-heading")).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await expect(page.getByTestId("project-chip")).toContainText("project");
    const activity = page.getByRole("navigation", { name: "Activity" });
    await expect(activity.getByRole("link", { name: "Tools", exact: true })).toBeVisible();
    await expect(activity.getByRole("link", { name: /Extensions|Integrations/ })).toHaveCount(0);
    await expect(page.getByTestId("landing-composer-attach")).toBeEnabled();
    await page.screenshot({ path: path.join(outDir, "ux-repair-landing.png") });

    await page.getByTestId("landing-mode-picker-custom").click();
    const custom = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Custom mode", exact: true }) });
    await expect(custom).toBeVisible();
    await expect(custom.getByRole("button", { name: "JSON", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(outDir, "ux-repair-custom.png") });
    await custom.getByRole("button", { name: "Close custom mode" }).click();
    await page.getByTestId("landing-mode-picker-solo").click();
    await page.getByTestId("landing-composer-input").fill("UX fixture hello");
    await page.getByTestId("landing-composer-input").press("Enter");
    await expect(page.getByTestId("chat-page")).toBeVisible();
    await expect(page.getByTestId("transcript")).toContainText("echo: UX fixture hello");
    await expect(page.getByTestId("chat-composer-attach")).toBeEnabled();
    await page.getByTestId("chat-composer-file-input").setInputFiles({ name: "fixture.txt", mimeType: "text/plain", buffer: Buffer.from("Isolated attachment content") });
    await expect(page.getByText("fixture.txt", { exact: true })).toBeVisible();
    await page.getByTestId("chat-composer-file-input").setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQ6lb6DwADcQHP47g9YAAAAABJRU5ErkJggg==", "base64") });
    const preview = page.getByTestId("chat-composer-images").getByRole("img", { name: "fixture.png" });
    await expect(preview).toHaveAttribute("src", /^blob:/);
    await expect.poll(() => preview.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await page.getByTestId("chat-composer-input").fill("Read these fixture attachments");
    await page.getByTestId("chat-composer-send").click();
    const transcript = page.getByTestId("transcript");
    await expect(transcript).toContainText("Isolated attachment content");
    await expect(transcript).toContainText("Read these fixture attachments");
    const storedImage = page.getByTestId("block-image").getByRole("img", { name: "fixture.png" });
    await expect(storedImage).toHaveAttribute("src", /^capygen-attachment:/);
    await expect.poll(() => storedImage.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(outDir, "ux-repair-attachments.png") });
    await page.reload();
    await expect(page.getByTestId("chat-page")).toBeVisible();
    await expect(transcript).toContainText("Isolated attachment content");
    await expect.poll(() => storedImage.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await page.getByTestId("session-settings-button").click();
    const sheet = page.getByTestId("session-settings-sheet");
    await expect(sheet).toBeVisible();
    expect(await sheet.evaluate(el => { const box = el.getBoundingClientRect(); return box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth; })).toBe(true);
    await expect(page.getByTestId("session-settings-parallel")).toBeInViewport();
    await page.screenshot({ path: path.join(outDir, "ux-repair-session-settings.png") });
    await page.getByTestId("session-settings-close").click();

    await page.getByTestId("open-settings").click();
    await expect(page.getByTestId("settings-general")).toBeVisible();
    await expect(page.getByTestId("settings-nav-integrations")).toHaveCount(0);
    const body = page.getByTestId("settings-body");
    expect(await body.evaluate(el => getComputedStyle(el).getPropertyValue("-webkit-app-region").trim())).not.toBe("drag");
    expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.getByTestId("toggle-start-with-windows").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("toggle-start-with-windows")).toBeInViewport();
    expect(await body.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    const widths = await page.getByTestId("row-start-with-windows").evaluate(el => Array.from(el.children).map(child => child.getBoundingClientRect().width));
    expect(widths[0]).toBeGreaterThanOrEqual(120);
    expect(widths[1]).toBeGreaterThanOrEqual(120);
    await page.screenshot({ path: path.join(outDir, "ux-repair-settings-scroll.png") });
    expect(errors).toEqual([]);
  } catch (error) {
    const windows = app?.windows() ?? [];
    if (windows[0]) await windows[0].screenshot({ path: path.join(outDir, "ux-repair-failure.png") }).catch(() => {});
    throw error;
  } finally {
    await app?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
