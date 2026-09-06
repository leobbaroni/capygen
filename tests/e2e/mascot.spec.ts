/** Pixel frames in the shipping file:// renderer, offline and fully isolated. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { launchEnv } from "./testPolicy.js";

const root = path.resolve(__dirname, "../..");

test("pixel mascot draws a sharp static state and has no animation", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-pixel-"));
  const dirs = Object.fromEntries(["profile", "project", "claude", "codex"].map(name => {
    const dir = path.join(temp, name);
    fs.mkdirSync(dir);
    return [name, dir];
  }));
  const app = await electron.launch({
    args: [path.join(root, "apps/desktop"), `--user-data-dir=${dirs.profile}`],
    cwd: root,
    env: launchEnv({
      userDataDir: dirs.profile!,
      projectDir: dirs.project!,
      homes: { claudeHome: dirs.claude!, codexHome: dirs.codex! },
      engine: "stub",
    }),
  });
  try {
    const page = await app.firstWindow();
    const mascot = page.getByTestId("mascot");
    await expect(mascot).toHaveAccessibleName("capygen mascot, idle");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(() => mascot.evaluate(el => getComputedStyle(el).animationName)).toBe("none");
    await mascot.evaluate(async el => {
      const url = getComputedStyle(el).backgroundImage.slice(5, -2);
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!url.endsWith("/mascot/idle.png") && !url.endsWith("./mascot/idle.png")) {
        throw new Error(`unexpected mascot asset: ${url}`);
      }
    });
    expect(await mascot.evaluate(el => ({
      width: el.getBoundingClientRect().width,
      rendering: getComputedStyle(el).imageRendering,
      animation: getComputedStyle(el).animationName,
      animations: el.getAnimations().length,
    }))).toEqual({ width: 144, rendering: "pixelated", animation: "none", animations: 0 });
    fs.mkdirSync(path.join(root, "e2e-out"), { recursive: true });
    await page.screenshot({ path: path.join(root, "e2e-out/mascot-desktop.png") });

    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await mascot.evaluate(el => ({
      animation: getComputedStyle(el).animationName,
      animations: el.getAnimations().length,
    }))).toEqual({ animation: "none", animations: 0 });
    await expect(mascot).toHaveAttribute("data-state", "idle");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(async () => {
      const bridge = (window as unknown as {
        capygen: { invoke(channel: string, payload: unknown): Promise<unknown> };
      }).capygen;
      await bridge.invoke("settings.patch", { patch: { appearance: { reducedMotion: true } } });
    });
    await expect.poll(() => mascot.evaluate(el => getComputedStyle(el).animationName)).toBe("none");

    await page.setViewportSize({ width: 860, height: 560 });
    const bounds = await mascot.boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(560);
    await expect(page.getByTestId("landing-composer-input")).toBeVisible();
    await page.screenshot({ path: path.join(root, "e2e-out/mascot-minimum.png") });

    // Exercise the renderer's compact layout even though the desktop window has a minimum width.
    await page.setViewportSize({ width: 380, height: 780 });
    await expect(page.getByTestId("landing-composer-input")).toBeVisible();
    await expect(mascot).toBeVisible();
    await page.screenshot({ path: path.join(root, "e2e-out/mascot-compact.png") });
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
