import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createExtensionRegistry } from "../src/extensions/registry.js";
import { createExtensionStorage } from "../src/extensions/storage.js";
import { createExtensionCapabilityService, type ExtensionAdapters } from "../src/extensions/service.js";
import { createExtensionPullRequestAdapter } from "../src/extensions/pullRequest.js";
import type { ExtensionCapability, ExtensionManifest } from "@capygen/shared";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temp() { const root = await mkdtemp(join(tmpdir(), "capygen-extension-test-")); roots.push(root); return root; }
async function fixture(parent: string, folder: string, id = "acme.sample", capabilities: ExtensionCapability[] = []) {
  const root = join(parent, folder); await mkdir(root);
  const manifest: ExtensionManifest = { schemaVersion: 1, id, version: "1.0.0", name: "Sample", assets: [], capabilities,
    pages: [{ id: `${id}.page`, route: "page", title: "Page", entry: "index.html" }], navigation: [{ id: `${id}.nav`, pageId: `${id}.page`, label: "Sample" }] };
  await writeFile(join(root, "capygen-extension.json"), JSON.stringify(manifest));
  await writeFile(join(root, "capygen-package.json"), JSON.stringify({ id, version: "1.0.0" }));
  await writeFile(join(root, "index.html"), "<h1>Local fixture</h1>");
  return { root, expectedId: id, expectedVersion: "1.0.0", localDevelopment: false, grants: capabilities };
}
it("disables every collision participant, preserves independent packages, and detects asset changes", async () => {
  const root = await temp(); const registry = createExtensionRegistry(join(root, "profile"));
  const one = await fixture(root, "one"); const two = await fixture(root, "two"); const other = await fixture(root, "other", "acme.other");
  await registry.register(one); await registry.register(two); await registry.register(other);
  expect(registry.snapshot().filter((record) => record.registration.expectedId === "acme.sample").every((record) => !record.available && record.reason?.includes("collision"))).toBe(true);
  expect(registry.get("acme.other")?.available).toBe(true);
  const fresh = createExtensionRegistry(join(root, "profile")); await fresh.initialize();
  expect(fresh.snapshot()).toHaveLength(3);
  const asset = await registry.readAsset("acme.other", "index.html"); expect(asset.bytes.toString()).toContain("Local fixture");
  await writeFile(join(other.root, "index.html"), "changed");
  await expect(registry.readAsset("acme.other", "index.html")).rejects.toThrow("unavailable");
  expect(registry.get("acme.other")).toBeNull();
});
it("rejects a junction escape and a missing entry without loading either page", async () => {
  const root = await temp(); const registry = createExtensionRegistry(join(root, "profile"));
  const escaped = await fixture(root, "escape", "acme.escape"); const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "index.html"), "private fixture");
  await symlink(outside, join(escaped.root, "linked"), "junction");
  const manifest = JSON.parse(await readFile(join(escaped.root, "capygen-extension.json"), "utf8")) as ExtensionManifest;
  manifest.pages[0]!.entry = "linked/index.html";
  await writeFile(join(escaped.root, "capygen-extension.json"), JSON.stringify(manifest));
  await registry.register(escaped);
  const missing = await fixture(root, "missing", "acme.missing"); await rm(join(missing.root, "index.html")); await registry.register(missing);
  expect(registry.snapshot().every((record) => !record.available)).toBe(true);
  await expect(registry.readAsset("acme.escape", "linked/index.html")).rejects.toThrow();
});
it("persists namespaced values and refuses every quota atomically", async () => {
  const root = await temp(); let tick = 0; const storage = createExtensionStorage(root, () => tick += 100);
  await storage.set("acme.one", "key", { value: "one" });
  expect(await createExtensionStorage(root).get("acme.one", "key")).toEqual({ value: "one" });
  expect(await storage.get("acme.two", "key")).toBeNull();
  await expect(storage.set("acme.one", "key", "x".repeat(32768))).rejects.toMatchObject({ code: "quota" });
  expect(await storage.get("acme.one", "key")).toEqual({ value: "one" });
  for (let i = 0; i < 8; i++) await storage.set("acme.large", `key${i}`, "x".repeat(32700));
  await expect(storage.set("acme.large", "overflow", "x".repeat(32700))).rejects.toMatchObject({ code: "quota" });
  for (let i = 0; i < 128; i++) await storage.set("acme.keys", `key${i}`, i);
  await expect(storage.set("acme.keys", "overflow", 1)).rejects.toMatchObject({ code: "quota" });
  expect(await storage.get("acme.keys", "overflow")).toBeNull();
});
it("enforces aggregate profile quota without altering prior persisted values", async () => {
  const root = await temp(); const seed: Record<string, Record<string, string>> = {};
  for (let namespace = 0; namespace < 36; namespace++) seed[`acme.n${namespace}`] = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`key${i}`, "x".repeat(32700)]));
  await writeFile(join(root, "capygen-extension-storage.json"), JSON.stringify(seed));
  let tick = 0; const storage = createExtensionStorage(root, () => tick += 100);
  for (let i = 0; i < 4; i++) await storage.set("acme.final", `key${i}`, "x".repeat(32700));
  const before = await readFile(join(root, "capygen-extension-storage.json"));
  await expect(storage.set("acme.final", "overflow", "x".repeat(32700))).rejects.toMatchObject({ code: "quota" });
  expect((await readFile(join(root, "capygen-extension-storage.json"))).equals(before)).toBe(true);
});
function adapters(): ExtensionAdapters {
  return { theme: { current: () => ({ background: "#fff" }), subscribe: () => () => {} },
    navigation: { openPage: vi.fn(), openSession: vi.fn(() => true), openNewSession: vi.fn(() => true), openExternal: vi.fn() },
    sessions: { listPage: () => [], pullRequest: async () => ({ available: true, url: "https://github.com/acme/repo/pull/1", title: "PR" }) },
    projects: { list: () => [], create: async () => null } };
}
it("binds capabilities and issued URLs to the verified lifecycle, disposes themes, and refuses stale requests", async () => {
  const root = await temp(); const registry = createExtensionRegistry(join(root, "profile"));
  await registry.register(await fixture(root, "one", "acme.one", ["theme", "navigation", "sessions.pullRequest"]));
  await registry.register(await fixture(root, "two", "acme.two", ["navigation"]));
  const adapter = adapters(); let publish!: (theme: Record<string, string>) => void; const unsub = vi.fn();
  adapter.theme.subscribe = (listener) => { publish = listener; return unsub; };
  const service = createExtensionCapabilityService({ registry, storage: createExtensionStorage(join(root, "profile")), adapters: adapter });
  const notify = vi.fn(); const one = service.openInstance("acme.one", ["theme", "navigation", "sessions.pullRequest", "storage.user"], notify);
  const two = service.openInstance("acme.two", ["navigation"]);
  let sequence = 0;
  const call = (instance: typeof one, method: string, params = {}) => service.dispatch(instance.instanceId, { version: 1, instanceId: instance.instanceId, nonce: instance.nonce, requestId: String(sequence++), method, params });
  expect((await call(one, "storage.user.get", { key: "no" })).ok).toBe(false);
  expect((await call(one, "theme.subscribe")).ok).toBe(true); publish({ background: "#000" }); expect(notify).toHaveBeenCalledOnce();
  expect((await call(one, "sessions.pullRequest", { sessionId: "session" })).ok).toBe(true);
  expect((await call(one, "navigation.openExternal", { url: "https://github.com/acme/repo/pull/1" })).ok).toBe(true);
  expect((await call(two, "navigation.openExternal", { url: "https://github.com/acme/repo/pull/1" })).ok).toBe(false);
  expect((await service.dispatch(two.instanceId, { version: 1, instanceId: one.instanceId, nonce: one.nonce, requestId: "forged", method: "theme.getCurrent" })).ok).toBe(false);
  service.closeInstance(one.instanceId); publish({ background: "#fff" }); expect(notify).toHaveBeenCalledOnce(); expect(unsub).toHaveBeenCalledOnce();
  expect((await call(one, "theme.getCurrent")).ok).toBe(false);
  service.dispose();
});
it("times out a stalled adapter and never returns its late result", async () => {
  const root = await temp(); const registry = createExtensionRegistry(join(root, "profile")); await registry.register(await fixture(root, "one", "acme.one", ["projects.read"]));
  const adapter = adapters(); let release!: (projects: []) => void; adapter.projects.list = () => new Promise((resolve) => { release = resolve; });
  const service = createExtensionCapabilityService({ registry, storage: createExtensionStorage(join(root, "profile")), adapters: adapter, deadlineMs: 10 });
  const instance = service.openInstance("acme.one", ["projects.read"]);
  const result = await service.dispatch(instance.instanceId, { version: 1, instanceId: instance.instanceId, nonce: instance.nonce, requestId: "timeout", method: "projects.list", params: {} });
  expect(result.ok).toBe(false);
  if (release) release([]);
  service.dispose();
});
it("PR lookup runs only the fixed read-only gh command with a bounded trusted session branch", async () => {
  const probe = vi.fn(async () => JSON.stringify({ url: "https://github.com/acme/repo/pull/2", title: "A fixture" }));
  const lookup = createExtensionPullRequestAdapter({ context: () => ({ workingDirectory: "C:\\isolated", branch: "feature/topic" }), probe, env: {} });
  expect(await lookup("session", new AbortController().signal)).toMatchObject({ available: true, url: "https://github.com/acme/repo/pull/2" });
  expect(probe).toHaveBeenCalledWith("gh", ["pr", "view", "feature/topic", "--json", "url,title"], expect.objectContaining({ windowsHide: true, timeout: 5000, maxBuffer: 65536 }));
  const invalid = createExtensionPullRequestAdapter({ context: () => ({ workingDirectory: "C:\\isolated", branch: "--help" }), probe, env: {} });
  expect((await invalid("session", new AbortController().signal)).available).toBe(false); expect(probe).toHaveBeenCalledTimes(1);
});
