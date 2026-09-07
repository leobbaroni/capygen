import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { backendHomes, launchEnv } from "./testPolicy.js";

const repoRoot = path.resolve(__dirname, "..", "..");

test("local Hosts reports harness status and links to configuration", async () => {
  const homes = backendHomes("hosts");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-hosts-"));
  const userDataDir = path.join(root, "profile");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [path.join(repoRoot, "apps", "desktop"), `--user-data-dir=${userDataDir}`],
      cwd: repoRoot,
      env: launchEnv({ userDataDir, projectDir, homes, engine: "stub" }),
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("link", { name: "Hosts", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Hosts", exact: true })).toBeVisible();
    await expect(page.getByText("Local machine", { exact: true })).toBeVisible();
    for (const backend of ["claude", "codex", "api"]) {
      await expect(page.getByTestId(`host-row-${backend}`)).toBeVisible();
      await expect(page.getByTestId(`host-status-${backend}`)).not.toHaveText("Not checked");
    }
    // Change the isolated main-process fixture so completion is observable,
    // even when the disabled state is shorter than a Playwright polling tick.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("harness.list");
      ipcMain.handle("harness.list", () => [
        { backend: "claude", label: "Claude Code", available: false,
          reason: "Hosts refresh fixture completed", models: [], defaultModel: "" },
        { backend: "codex", label: "Codex", available: false,
          reason: "Isolated test", models: [], defaultModel: "" },
        { backend: "api", label: "API models", available: false,
          reason: "Isolated test", models: [], defaultModel: "" },
      ]);
    });
    const refresh = page.getByRole("button", { name: "Refresh host status" });
    await refresh.click();
    await expect(page.getByTestId("host-status-claude")).toHaveText("Hosts refresh fixture completed");
    await expect(page.getByTestId("host-model-count-claude")).toHaveText("0 models");
    await expect(refresh).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const evidence = path.join(repoRoot, "e2e-out", "hosts");
    fs.mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, "desktop.png") });
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.setMinimumSize(0, 0);
      win?.setSize(380, 800);
    });
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(380);
    await expect(page.getByRole("heading", { name: "Hosts", exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(evidence, "narrow.png") });
    await page.getByRole("link", { name: "Harnesses", exact: true }).click();
    await expect(page).toHaveURL(/settings\/harnesses/);
    expect(errors).toEqual([]);
  } finally {
    try { await app?.close(); }
    finally {
      try { fs.rmSync(root, { recursive: true, force: true }); }
      finally { homes.cleanup(); }
    }
  }
});
