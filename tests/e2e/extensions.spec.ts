import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { backendHomes, launchEnv } from "./testPolicy.js";

const repo = path.resolve(__dirname, "../..");
test("extension sample uses a confined port, persists storage and refuses ambient network", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-extension-native-"));
  const profile = path.join(root, "profile"); const project = path.join(root, "project"); const bundle = path.join(root, "sample");
  fs.mkdirSync(profile); fs.mkdirSync(project); fs.cpSync(path.join(repo, "assets/extensions/sample"), bundle, { recursive: true });
  fs.writeFileSync(path.join(profile, "capygen-extension-registry.json"), JSON.stringify([{ registrationId: randomUUID(), registration: {
    root: bundle, expectedId: "example.welcome", expectedVersion: "1.0.0", localDevelopment: false,
    grants: ["theme", "navigation", "storage.user", "projects.read", "sessions.read"],
  } }]));
  let network = 0; const server = createServer((_request, response) => { network++; response.end("Unexpected"); });
  let app: ElectronApplication | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env = launchEnv({ userDataDir: profile, projectDir: project, homes: backendHomes("extensions"), engine: "stub" });
    const launch = () => electron.launch({ args: [path.join(repo, "apps/desktop"), `--user-data-dir=${profile}`], cwd: repo, env });
    app = await launch(); let page = await app.firstWindow();
    const open = async (): Promise<Page> => {
      await page.getByRole("link", { name: "Extension sample", exact: true }).click();
      await expect.poll(() => app!.context().pages().some((candidate) => candidate.url().startsWith("capygen-extension:"))).toBe(true);
      const extension = app!.context().pages().find((candidate) => candidate.url().startsWith("capygen-extension:"))!;
      await expect(extension.locator("#status")).toContainText("Connected"); return extension;
    };
    let extension = await open();
    await extension.getByRole("button", { name: "Follow appearance" }).click();
    await expect(extension.locator("#result")).toContainText("background");
    await extension.getByRole("button", { name: "Save a preference" }).click();
    await expect(extension.locator("#result")).toHaveText("null");
    await extension.getByRole("button", { name: "Read the preference" }).click();
    await expect(extension.locator("#result")).toContainText("Saved locally");
    await extension.getByRole("button", { name: "List projects" }).click();
    await expect(extension.locator("#result")).toContainText('"items"');
    const isolation = await extension.evaluate(async (endpoint) => {
      const exposed = typeof (window as any).capygen !== "undefined" || typeof (window as any).require !== "undefined";
      const fetched = await fetch(endpoint).then(() => true, () => false);
      const image = await new Promise<boolean>((resolve) => { const img = new Image(); img.onload = () => resolve(true); img.onerror = () => resolve(false); img.src = `${endpoint}/image.png`; });
      const popup = window.open(endpoint) !== null;
      return { exposed, fetched, image, popup };
    }, url);
    expect(isolation).toEqual({ exposed: false, fetched: false, image: false, popup: false });
    expect(network).toBe(0);
    const oldUrl = extension.url();
    await extension.getByRole("button", { name: "New conversation", exact: true }).click();
    await expect.poll(() => extension.isClosed()).toBe(true);
    extension = await open(); expect(extension.url()).not.toBe(oldUrl);
    await app.close(); app = undefined;
    app = await launch(); page = await app.firstWindow(); extension = await open();
    await extension.getByRole("button", { name: "Read the preference" }).click();
    await expect(extension.locator("#result")).toContainText("Saved locally");
    expect(network).toBe(0);
  } finally {
    await app?.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
