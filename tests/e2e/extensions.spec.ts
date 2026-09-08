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
  fs.copyFileSync(path.join(repo, "assets/icons/icon.png"), path.join(bundle, "control.png"));
  fs.writeFileSync(path.join(root, "secret.png"), fs.readFileSync(path.join(repo, "assets/icons/icon.png")));
  const sampleManifest = JSON.parse(fs.readFileSync(path.join(bundle, "capygen-extension.json"), "utf8"));
  sampleManifest.assets.push("control.png");
  fs.writeFileSync(path.join(bundle, "capygen-extension.json"), JSON.stringify(sampleManifest));
  // Capture the legitimate bootstrap port before the sample listener claims it, then
  // exercise the main-process authority checks with bounded forged requests.
  fs.writeFileSync(path.join(bundle, "sample.js"), `(() => {
    window.__securityReplies = [];
    window.addEventListener("message", (event) => {
      if (event.data?.type !== "capygen-extension-ready" || event.ports.length !== 1) return;
      const port = event.ports[0]; const base = { version: 1, instanceId: event.data.instanceId, requestId: "security-" + Date.now() };
      port.addEventListener("message", (reply) => window.__securityReplies.push(reply.data)); port.start();
      port.postMessage({ ...base, nonce: "x".repeat(32), method: "theme.getCurrent", params: {}, requestId: "security-nonce" });
      port.postMessage({ ...base, nonce: event.data.nonce, method: "extension.unknown", params: {}, requestId: "security-method" });
    });
  })();\n` + fs.readFileSync(path.join(bundle, "sample.js"), "utf8"));
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
      await page.getByRole("link", { name: "Tools", exact: true }).click();
      await page.getByRole("link", { name: "App pages", exact: true }).click();
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
    const permissions = await extension.evaluate(async () => {
      const geolocation = await new Promise<number>((resolve) => navigator.geolocation.getCurrentPosition(
        () => resolve(0), (error) => resolve(error.code), { timeout: 1000 }));
      const state = await navigator.permissions.query({ name: "geolocation" as PermissionName }).then((permission) => permission.state, () => "unavailable");
      return { geolocation, state };
    });
    expect(permissions).toEqual({ geolocation: 1, state: "denied" });
    const traversal = await extension.evaluate(async () => {
      const load = (src: string) => new Promise<boolean>((resolve) => { const image = new Image(); image.onload = () => resolve(true); image.onerror = () => resolve(false); image.src = src; });
      return { control: await load(`${location.origin}/control.png`), escaped: await load(`${location.origin}/%2e%2e%2fsecret.png`) };
    });
    expect(traversal).toEqual({ control: true, escaped: false });
    await expect.poll(() => extension.evaluate(() => (window as any).__securityReplies)).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: "security-nonce", ok: false }),
      expect.objectContaining({ requestId: "security-method", ok: false }),
    ]));
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
