import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { UpdateCheckResult } from "electron-updater";
import { UpdateService, type UpdateServiceDeps } from "../src/updates/UpdateService.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0)) await fn(); });
const bytes = Buffer.from("owned fixture installer");
const digest = createHash("sha512").update(bytes).digest("base64");
async function fixture(retain = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capygen-update-fixture-"));
  const priorFile = path.join(root, "retained", "prior.exe");
  if (retain) { await fs.mkdir(path.dirname(priorFile)); await fs.writeFile(priorFile, bytes); await fs.writeFile(path.join(root, "pending.json"), JSON.stringify({ version: "0.2.0", file: priorFile, size: bytes.length, sha512: digest, portable: false })); }
  const driver = { checkForUpdates: vi.fn(async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.3.0", files: [{ url: "capygen-0.3.0-setup.exe", size: bytes.length, sha512: digest }] } }) as unknown as UpdateCheckResult),
    downloadUpdate: vi.fn(async () => { const file = path.join(root, "cache", "download.exe"); await fs.writeFile(file, bytes); return [file]; }), dispose: vi.fn() };
  const secrets = { hasUpdaterToken: vi.fn(() => true), getUpdaterToken: vi.fn(() => "fixture-only"), setUpdaterToken: vi.fn(), deleteUpdaterToken: vi.fn() };
  const deps = { root, currentVersion: "0.1.0", packaged: true, portable: false, secrets, driver: () => driver, changed: vi.fn(), idle: vi.fn(() => true), confirmInstall: vi.fn(async () => true), launchInstall: vi.fn(async () => {}), quit: vi.fn(), savePortable: vi.fn(async () => true), processId: 123 };
  const service = new UpdateService(deps as unknown as UpdateServiceDeps);
  cleanup.push(async () => { service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, priorFile, driver, deps, service };
}

it("rejects a checksum mismatch and removes partial download data", async () => {
  const f = await fixture(); await f.service.check();
  f.driver.downloadUpdate.mockImplementationOnce(async () => { const file = path.join(f.root, "cache", "bad.exe"); await fs.writeFile(file, Buffer.alloc(bytes.length)); return [file]; });
  expect((await f.service.download()).phase).toBe("error");
  await expect(fs.stat(path.join(f.root, "cache"))).rejects.toThrow();
  await expect(fs.stat(path.join(f.root, "pending.json"))).rejects.toThrow();
});

it("cancel retains the previous ready version and journal", async () => {
  const f = await fixture(true); await f.service.check();
  f.driver.downloadUpdate.mockImplementationOnce(async () => { f.service.cancel(); return []; });
  expect(await f.service.download()).toMatchObject({ phase: "ready", version: "0.2.0", progress: 100 });
  expect(JSON.parse(await fs.readFile(path.join(f.root, "pending.json"), "utf8")).version).toBe("0.2.0");
  expect(await fs.readFile(f.priorFile)).toEqual(bytes);
});

it("failed journal commit removes its retained copy and temp journal without replacing the previous download", async () => {
  const f = await fixture(true); await f.service.check();
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("fixture rename failed"));
  expect((await f.service.download()).version).toBe("0.2.0");
  expect(await fs.readdir(path.join(f.root, "retained"))).toEqual(["prior.exe"]);
  expect((await fs.readdir(f.root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("keeps the operation lock until asynchronous cache cleanup finishes", async () => {
  const f = await fixture(); await f.service.check();
  const original = fs.rm.bind(fs); let release!: () => void; let entered!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
    if (file === path.join(f.root, "cache")) { entered(); await new Promise<void>((resolve) => { release = resolve; }); }
    return original(file, options);
  });
  const download = f.service.download(); await reached;
  await expect(f.service.download()).rejects.toThrow("already running");
  await expect(f.service.clear()).rejects.toThrow("already running");
  release(); expect((await download).phase).toBe("ready");
});

it("requires explicit confirmation and rechecks active work before launching", async () => {
  const f = await fixture(true);
  f.deps.confirmInstall.mockResolvedValueOnce(false); await f.service.install();
  expect(f.deps.launchInstall).not.toHaveBeenCalled();
  f.deps.confirmInstall.mockImplementationOnce(async () => { f.deps.idle.mockReturnValue(false); return true; });
  await f.service.install(); expect(f.deps.launchInstall).not.toHaveBeenCalled();
  f.deps.idle.mockReturnValue(true); await f.service.install();
  expect(f.deps.launchInstall).toHaveBeenCalledOnce(); expect(f.deps.quit).toHaveBeenCalledOnce();
  expect(f.deps.confirmInstall.mock.calls[2]).toEqual(f.deps.launchInstall.mock.calls[0]);
});

it("credential changes wait for restore and cannot overwrite retained download state", async () => {
  const f = await fixture(true);
  expect(await f.service.deleteCredential()).toMatchObject({ phase: "ready", version: "0.2.0" });
  expect(f.deps.secrets.deleteUpdaterToken).toHaveBeenCalledOnce();
});


it("refuses cleanup through a replaced update-root junction", async () => {
  const f = await fixture(); await f.service.check();
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "capygen-update-external-"));
  const sentinel = path.join(external, "pending.json");
  await fs.writeFile(sentinel, "untouched external metadata");
  await fs.rm(f.root, { recursive: true });
  await fs.symlink(external, f.root, "junction");
  try {
    await expect(f.service.clear()).rejects.toThrow("Linked update root refused");
    expect(await fs.readFile(sentinel, "utf8")).toBe("untouched external metadata");
    expect((await f.service.download()).phase).toBe("error");
    expect(f.driver.downloadUpdate).not.toHaveBeenCalled();
  } finally { await fs.unlink(f.root); await fs.rm(external, { recursive: true }); }
});
