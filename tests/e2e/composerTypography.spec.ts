import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { backendHomes, launchEnv } from "./testPolicy.js";

const repoRoot = path.resolve(__dirname, "..", "..");

test("composer draft overlay keeps textarea typography and wrapping aligned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-typography-"));
  const userDataDir = path.join(root, "profile");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(userDataDir); fs.mkdirSync(projectDir);
  const homes = backendHomes("composer-typography");
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({ args: [path.join(repoRoot, "apps/desktop"), `--user-data-dir=${userDataDir}`], cwd: repoRoot, env: launchEnv({ userDataDir, projectDir, homes, engine: "stub" }) });
    const page = await app.firstWindow();
    const input = page.getByTestId("landing-composer-input");
    await input.fill("/cockpit:pilot @capy\n" + Array.from({ length: 30 }, (_, i) => `Line ${i}: deliberately long text that must wrap inside the composer without shifting the overlay.`).join("\n"));
    const measure = () => page.evaluate(() => {
      const textarea = document.querySelector("textarea")!;
      const overlay = document.querySelector('[data-testid="composer-draft-highlight"]')!;
      const a = getComputedStyle(textarea), b = getComputedStyle(overlay);
      return { fontFamily: [a.fontFamily, b.fontFamily], fontSize: [a.fontSize, b.fontSize], fontWeight: [a.fontWeight, b.fontWeight], lineHeight: [a.lineHeight, b.lineHeight], letterSpacing: [a.letterSpacing, b.letterSpacing], padding: [a.padding, b.padding], width: [textarea.clientWidth, overlay.clientWidth], scrollHeight: [textarea.scrollHeight, overlay.scrollHeight], height: textarea.clientHeight, bodySize: getComputedStyle(document.body).fontSize, scrollTop: [textarea.scrollTop, overlay.scrollTop] } as const;
    });
    const initial = await measure();
    expect(initial.fontFamily[0]).toBe(initial.fontFamily[1]);
    expect(initial.fontSize[0]).toBe(initial.fontSize[1]);
    expect(initial.fontWeight[0]).toBe(initial.fontWeight[1]);
    expect(initial.lineHeight[0]).toBe(initial.lineHeight[1]);
    expect(initial.letterSpacing[0]).toBe(initial.letterSpacing[1]);
    expect(initial.padding[0]).toBe(initial.padding[1]);
    expect(initial.width[0]).toBe(initial.width[1]);
    expect(Math.abs(initial.scrollHeight[0] - initial.scrollHeight[1])).toBeLessThanOrEqual(2);
    expect(initial.fontSize[0]).toBe(initial.bodySize);
    expect(initial.scrollHeight[0]).toBeGreaterThan(initial.height);
    await input.evaluate((element: HTMLTextAreaElement) => { element.scrollTop = 100; element.setSelectionRange(0, 14); });
    await expect.poll(async () => (await measure()).scrollTop).toEqual([100, 100]);
    await page.screenshot({ path: path.join(repoRoot, "e2e-out/composer-typography-default.png") });
    await page.evaluate(async () => (window as any).capygen.invoke("settings.patch", { patch: { appearance: { fontScale: 1.25 } } }));
    await expect.poll(async () => (await measure()).fontSize[0]).not.toBe(initial.fontSize[0]);
    const scaled = await measure();
    expect(scaled.fontFamily[0]).toBe(scaled.fontFamily[1]);
    expect(scaled.fontSize[0]).toBe(scaled.fontSize[1]);
    expect(scaled.lineHeight[0]).toBe(scaled.lineHeight[1]);
    expect(scaled.padding[0]).toBe(scaled.padding[1]);
    expect(Math.abs(scaled.scrollHeight[0] - scaled.scrollHeight[1])).toBeLessThanOrEqual(2);
    expect(scaled.fontSize[0]).toBe(scaled.bodySize);
    expect(scaled.scrollHeight[0]).toBeGreaterThan(scaled.height);
    await page.screenshot({ path: path.join(repoRoot, "e2e-out/composer-typography-scaled.png") });
  } finally { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); homes.cleanup(); }
});
