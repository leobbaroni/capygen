import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CancellationToken, type UpdateCheckResult } from "electron-updater";
import type { UpdateStatus } from "@capygen/shared";
import type { UpdaterSecretsStore } from "../ipc/secrets.js";

// Initial measured Windows artifacts are ~181 MiB each. Reserve room for growth,
// one retained verified artifact and one in-flight download/copy, never unlimited history.
export const MAX_UPDATE_BYTES = 512 * 1024 ** 2;
export const MAX_UPDATE_CACHE_BYTES = 1536 * 1024 ** 2;
export interface UpdateDriver {
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(cancel: CancellationToken): Promise<string[]>;
  dispose(): void;
}
interface Pending { version: string; file: string; size: number; sha512: string; portable: boolean }
export interface UpdateServiceDeps {
  root: string; currentVersion: string; packaged: boolean; portable: boolean;
  secrets: UpdaterSecretsStore;
  driver(token: string, progress: (transferred: number, percent: number) => void): UpdateDriver;
  changed(status: UpdateStatus): void;
  idle(): boolean;
  confirmInstall(command: string): Promise<boolean>;
  launchInstall(command: string): Promise<void>;
  quit(): void;
  savePortable(source: string, name: string, expected: { size: number; sha512: string }): Promise<boolean>;
  processId: number;
}
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** All state is main-owned; downloads never install themselves or export credentials. */
export class UpdateService {
  private value: UpdateStatus;
  private driver: UpdateDriver | null = null;
  private candidate: Pending | null = null;
  private pending: Pending | null = null;
  private cancellation: CancellationToken | null = null;
  private busy = false;
  private disposed = false;
  private initialized: Promise<void>;
  constructor(private readonly deps: UpdateServiceDeps) {
    this.value = { phase: deps.packaged ? "idle" : "unavailable", currentVersion: deps.currentVersion, version: null,
      progress: 0, message: deps.packaged ? "Check for a private GitHub release." : "Updates are available in packaged Windows builds.",
      hasCredential: deps.secrets.hasUpdaterToken(), portable: deps.portable };
    this.initialized = this.restore();
  }
  status(): UpdateStatus { return { ...this.value, hasCredential: this.deps.secrets.hasUpdaterToken() }; }
  private emit(patch: Partial<UpdateStatus>) { if (this.disposed) return; Object.assign(this.value, patch); this.deps.changed(this.status()); }
  private requireIdle() { if (this.disposed || this.busy) throw new Error("An update operation is already running or unavailable."); }
  private async contained(file: string): Promise<string> {
    const root = await fs.realpath(this.deps.root); const actual = await fs.realpath(file);
    const relative = path.relative(root, actual);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Update file is outside its owned cache.");
    return actual;
  }
  private async verify(pending: Pending): Promise<string> {
    if (!VERSION.test(pending.version) || !SHA512.test(pending.sha512) || !Number.isSafeInteger(pending.size) || pending.size <= 0 || pending.size > MAX_UPDATE_BYTES) throw new Error("Invalid update metadata.");
    const file = await this.contained(pending.file); const before = await fs.stat(file);
    if (!before.isFile() || before.size !== pending.size) throw new Error("Update size changed.");
    let bytes = 0; const hash = createHash("sha512");
    for await (const chunk of createReadStream(file)) { bytes += chunk.length; if (bytes > pending.size) throw new Error("Update grew while being checked."); hash.update(chunk); }
    const after = await fs.stat(file);
    if (bytes !== pending.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || hash.digest("base64") !== pending.sha512) throw new Error("Update checksum mismatch.");
    return file;
  }
  private async restore() {
    try {
      const file = path.join(this.deps.root, "pending.json");
      if ((await fs.stat(file)).size > 4096) throw new Error("Invalid pending metadata");
      const pending: Pending = JSON.parse(await fs.readFile(file, "utf8"));
      if (pending.portable !== this.deps.portable) return;
      await this.verify(pending); this.pending = pending;
      this.emit({ phase: "ready", version: pending.version, progress: 100, message: "Verified download is ready. Installation requires confirmation." });
    } catch { /* No usable cached installer. Checking again is explicit. */ }
  }
  async setCredential(value: string) { await this.initialized; this.requireIdle(); this.deps.secrets.setUpdaterToken(value); this.driver?.dispose(); this.driver = null; this.candidate = null; this.emit({ phase: this.pending ? "ready" : "idle", version: this.pending?.version ?? null, progress: this.pending ? 100 : 0, hasCredential: true, message: "Private release credential saved securely." }); return this.status(); }
  async deleteCredential() { await this.initialized; this.requireIdle(); this.deps.secrets.deleteUpdaterToken(); this.driver?.dispose(); this.driver = null; this.candidate = null; this.emit({ phase: this.pending ? "ready" : "idle", version: this.pending?.version ?? null, progress: this.pending ? 100 : 0, hasCredential: false, message: "Private release credential removed." }); return this.status(); }
  async check() {
    await this.initialized; this.requireIdle();
    if (!this.deps.packaged) return this.status();
    const token = this.deps.secrets.getUpdaterToken();
    if (!token) { this.emit({ phase: this.pending ? "ready" : "unavailable", version: this.pending?.version ?? null, progress: this.pending ? 100 : 0, message: "Add your own GitHub credential with read access to the private capygen repository." }); return this.status(); }
    this.busy = true; this.candidate = null; this.driver?.dispose();
    try {
      this.driver = this.deps.driver(token, (transferred, percent) => {
        if (transferred > MAX_UPDATE_BYTES) this.cancellation?.cancel();
        this.emit({ progress: Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0)) });
      });
      this.emit({ phase: "checking", message: "Checking the private GitHub release…", progress: 0 });
      const result = await this.driver.checkForUpdates();
      if (this.disposed) return this.status();
      if (!result) throw new Error("No result");
      if (!result.isUpdateAvailable) { this.emit({ phase: this.pending ? "ready" : "idle", version: this.pending?.version ?? null, progress: this.pending ? 100 : 0, message: this.pending ? "The previous verified download is retained. No newer release was found." : "This build is up to date." }); return this.status(); }
      const info = result.updateInfo;
      if (!VERSION.test(info.version)) throw new Error("Invalid version");
      const name = `capygen-${info.version}-${this.deps.portable ? "portable" : "setup"}.exe`;
      const files = info.files.filter((file) => path.posix.basename(file.url) === name);
      if (files.length !== 1 || !SHA512.test(files[0]!.sha512) || !Number.isSafeInteger(files[0]!.size) || files[0]!.size! <= 0 || files[0]!.size! > MAX_UPDATE_BYTES) throw new Error("Invalid artifact");
      this.candidate = { file: name, version: info.version, size: files[0]!.size!, sha512: files[0]!.sha512, portable: this.deps.portable };
      this.emit({ phase: "available", version: info.version, message: "An update is available. Download when ready." });
    } catch { this.emit({ phase: this.pending ? "ready" : "error", version: this.pending?.version ?? null, progress: this.pending ? 100 : 0, message: "Could not access a valid private release. Check connectivity, repository access and your credential." }); }
    finally { this.busy = false; }
    return this.status();
  }
  async download() {
    await this.initialized; this.requireIdle();
    if (!this.candidate || !this.driver) throw new Error("Check for an update first.");
    this.busy = true; const candidate = { ...this.candidate }; const cancellation = new CancellationToken(); this.cancellation = cancellation;
    let retainedFile: string | null = null; let temporaryJournal: string | null = null;
    this.emit({ phase: "downloading", progress: 0, message: "Downloading and verifying the update…" });
    try {
      await fs.mkdir(this.deps.root, { recursive: true });
      const cache = path.join(this.deps.root, "cache"); await fs.mkdir(cache, { recursive: true });
      if ((await fs.lstat(cache)).isSymbolicLink()) throw new Error("Linked update cache refused");
      await this.contained(cache);
      await this.cacheBudget(candidate.size * 2);
      const files = await this.driver.downloadUpdate(cancellation);
      if (cancellation.cancelled || this.disposed || files.length !== 1) throw new Error("Cancelled");
      const verified = { ...candidate, file: files[0]! }; await this.verify(verified);
      const retained = path.join(this.deps.root, "retained"); await fs.mkdir(retained, { recursive: true });
      if ((await fs.lstat(retained)).isSymbolicLink()) throw new Error("Linked retained cache refused");
      await this.contained(retained);
      const file = path.join(retained, `${randomUUID()}.exe`); retainedFile = file;
      await fs.copyFile(verified.file, file); const ready = { ...verified, file }; await this.verify(ready);
      if (cancellation.cancelled || this.disposed) { await fs.unlink(file); throw new Error("Cancelled"); }
      const journal = path.join(this.deps.root, `pending.${randomUUID()}.tmp`); temporaryJournal = journal; await fs.writeFile(journal, JSON.stringify(ready), { mode: 0o600, flag: "wx" });
      if (cancellation.cancelled || this.disposed) throw new Error("Cancelled");
      await fs.rename(journal, path.join(this.deps.root, "pending.json"));
      temporaryJournal = null;
      const old = this.pending; this.pending = ready;
      if (old && old.file !== file) await fs.unlink(await this.contained(old.file)).catch(() => {});
      this.emit({ phase: "ready", version: ready.version, progress: 100, message: this.deps.portable ? "Verified portable replacement is ready to save." : "Verified installer is ready. It will not run until you confirm." });
    } catch { this.emit({ phase: this.pending ? "ready" : "error", version: this.pending?.version ?? null, progress: this.pending ? 100 : 0, message: cancellation.cancelled ? "Download cancelled. Any previous verified update is retained." : "Download or checksum verification failed. Try checking again." }); }
    finally {
      try {
        if (temporaryJournal) await fs.unlink(temporaryJournal).catch(() => {});
        if (retainedFile && retainedFile !== this.pending?.file) await fs.unlink(retainedFile).catch(() => {});
        await this.clearDownloadCache();
      } finally { this.cancellation = null; this.busy = false; }
    }
    return this.status();
  }
  cancel() { const ok = !!this.cancellation; this.cancellation?.cancel(); return { ok }; }
  private async clearDownloadCache() {
    const cache = path.join(this.deps.root, "cache");
    try { const info = await fs.lstat(cache); if (info.isSymbolicLink()) return; await this.contained(cache); await fs.rm(cache, { recursive: true, force: true }); } catch { /* bounded owned cleanup is retried on clear */ }
  }
  private async cacheBudget(reserve: number) {
    let bytes = 0; let artifacts = 0;
    const walk = async (directory: string) => { for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name); if (item.isSymbolicLink()) throw new Error("Linked cache entry refused");
      if (item.isDirectory()) await walk(file); else { const size = (await fs.stat(file)).size; bytes += size; if (item.name.endsWith(".exe")) artifacts++; }
      if (bytes + reserve > MAX_UPDATE_CACHE_BYTES || artifacts + 2 > 4) throw new Error("Update cache limit reached; clear downloads first");
    } }; await walk(this.deps.root);
  }
  async clear() {
    await this.initialized; this.requireIdle(); this.busy = true;
    try {
      this.pending = null; this.candidate = null; this.driver?.dispose(); this.driver = null;
      await this.clearDownloadCache();
      const retained = path.join(this.deps.root, "retained");
      try { if (!(await fs.lstat(retained)).isSymbolicLink()) { await this.contained(retained); await fs.rm(retained, { recursive: true, force: true }); } } catch { }
      await fs.unlink(path.join(this.deps.root, "pending.json")).catch(() => {});
      this.emit({ phase: "idle", version: null, progress: 0, message: "App-owned downloads cleared." }); return this.status();
    } finally { this.busy = false; }
  }
  async install() {
    await this.initialized; this.requireIdle();
    if (!this.pending || this.deps.portable || !this.deps.packaged) throw new Error("No installable update is ready.");
    if (!this.deps.idle()) throw new Error("Finish or interrupt active work before updating.");
    this.busy = true;
    try {
      const file = await this.verify(this.pending);
      const command = `$capygenUpdatingProcess = Get-Process -Id ${this.deps.processId} -ErrorAction SilentlyContinue; try { if ($capygenUpdatingProcess) { $capygenUpdatingProcess | Wait-Process -Timeout 60 -ErrorAction Stop } } catch { Write-Error 'capygen did not close; update cancelled'; exit 1 }; & ${quote(file)} '--updated'`;
      if (!await this.deps.confirmInstall(command)) return this.status();
      if (!this.deps.idle() || this.disposed) throw new Error("Work became active");
      await this.verify(this.pending);
      if (!this.deps.idle() || this.disposed) throw new Error("Work became active");
      await this.deps.launchInstall(command);
      this.emit({ phase: "installing", message: "The visible installer console is waiting for capygen to close." }); this.deps.quit();
    } catch { this.emit({ phase: "error", message: "The installer could not start safely. Finish active work or download the update again." }); }
    finally { this.busy = false; }
    return this.status();
  }
  async savePortable() { await this.initialized; this.requireIdle(); if (!this.pending || !this.deps.portable) throw new Error("No portable replacement is ready.");
    this.busy = true; try { return { ok: await this.deps.savePortable(await this.verify(this.pending), `capygen-${this.pending.version}-portable.exe`, this.pending) }; } finally { this.busy = false; } }
  dispose() { this.disposed = true; this.cancellation?.cancel(); this.driver?.dispose(); }
}
