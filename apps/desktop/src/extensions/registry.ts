import { createHash, randomUUID } from "node:crypto";
import { join, extname, resolve } from "node:path";
import { z } from "zod";
import { ExtensionManifestSchema, ExtensionRegistrationSchema, type ExtensionManifest, type ExtensionRegistration } from "@capygen/shared";
import { atomicJson, boundedRead, confinedRead, verifyRoot, type VerifiedRoot } from "./files.js";

export interface ExtensionRecord {
  registrationId: string; registration: ExtensionRegistration; manifest: ExtensionManifest | null;
  available: boolean; reason?: string; revision: string;
}
interface Loaded { record: ExtensionRecord; root?: VerifiedRoot; assets: Map<string, string> }
const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const packageSchema = z.object({ id: z.string(), version: z.string() }).strict();
const persistedSchema = z.array(z.object({ registrationId: z.string().uuid(), registration: ExtensionRegistrationSchema }).strict()).max(64);
const mimeTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json" };

export function createExtensionRegistry(profileDirectory: string, reservedIds: readonly string[] = ["capygen", "app", "home", "sessions", "projects", "settings"]) {
  const file = join(profileDirectory, "capygen-extension-registry.json");
  let registrations: z.infer<typeof persistedSchema> = [];
  let loaded: Loaded[] = [];
  let initialized = false;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  function serialized<T>(operation: () => Promise<T>): Promise<T> { const result = queue.then(operation); queue = result.catch(() => {}); return result; }
  async function inspect(entry: z.infer<typeof persistedSchema>[number]): Promise<Loaded> {
    const record: ExtensionRecord = { ...entry, manifest: null, available: false, revision: "" };
    const assets = new Map<string, string>();
    try {
      const root = await verifyRoot(entry.registration.root);
      const manifest = ExtensionManifestSchema.parse(JSON.parse((await confinedRead(root, "capygen-extension.json", 65536)).toString("utf8")));
      record.manifest = manifest;
      const metadata = packageSchema.parse(JSON.parse((await confinedRead(root, "capygen-package.json", 4096)).toString("utf8")));
      if (manifest.id !== entry.registration.expectedId || metadata.id !== manifest.id) throw new Error("Package identity does not match registration");
      if (!entry.registration.localDevelopment && (metadata.version !== manifest.version || manifest.version !== entry.registration.expectedVersion)) throw new Error("Package version changed; review and register the update explicitly");
      if (entry.registration.grants.some((grant) => !manifest.capabilities.includes(grant))) throw new Error("Registration grants an undeclared capability");
      let total = 0;
      for (const asset of new Set([...manifest.assets, ...manifest.pages.map((page) => page.entry)])) {
        if (!mimeTypes[extname(asset).toLowerCase()]) throw new Error("Unsupported extension asset type");
        const bytes = await confinedRead(root, asset, MAX_ASSET_BYTES);
        total += bytes.length;
        if (total > 16 * 1024 * 1024) throw new Error("Extension assets exceed 16 MiB");
        assets.set(asset, digest(bytes));
      }
      record.revision = digest(Buffer.from(JSON.stringify([manifest, [...assets]])));
      record.available = true;
      return { record, root, assets };
    } catch (error) {
      // Filesystem errors include paths and internals; keep the operator-facing reason bounded.
      record.reason = error instanceof Error && !('code' in error) && !(error instanceof z.ZodError) ? error.message.slice(0, 200) : "Extension manifest or assets could not be verified";
      return { record, assets };
    }
  }
  async function reload(): Promise<void> {
    loaded = await Promise.all(registrations.map(inspect));
    const owners = new Map<string, Set<Loaded>>();
    for (const item of loaded) {
      const manifest = item.record.manifest;
      const ids = [item.record.registration.expectedId, ...(manifest ? [manifest.id, ...manifest.pages.map((page) => page.id), ...manifest.navigation.map((nav) => nav.id)] : [])];
      for (const id of ids) {
        const group = owners.get(id) ?? new Set<Loaded>(); group.add(item); owners.set(id, group);
        if (reservedIds.some((reserved) => id === reserved || id.startsWith(`${reserved}.`))) { item.record.available = false; item.record.reason = "Extension ID is reserved by the host"; }
      }
    }
    for (const group of owners.values()) if (group.size > 1) for (const item of group) { item.record.available = false; item.record.reason = "Extension or contribution ID collision; all participants are disabled"; }
    for (const listener of listeners) listener();
  }
  async function initialize(): Promise<void> {
    if (initialized) return;
    try { registrations = persistedSchema.parse(JSON.parse((await boundedRead(file, 512 * 1024)).toString("utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Extension registration file could not be read"); }
    await reload(); initialized = true;
  }
  return {
    initialize: () => serialized(initialize),
    refresh: () => serialized(async () => { await initialize(); await reload(); }),
    register: (input: unknown) => serialized(async (): Promise<ExtensionRecord[]> => {
      await initialize(); const registration = ExtensionRegistrationSchema.parse(input);
      if (registrations.length >= 64) throw new Error("Extension registry is limited to 64 packages");
      if (registrations.some((entry) => resolve(entry.registration.root) === resolve(registration.root))) throw new Error("This root is already registered; remove it before registering an explicit update");
      const next = [...registrations, { registrationId: randomUUID(), registration }];
      if (Buffer.byteLength(JSON.stringify(next)) > 512 * 1024) throw new Error("Extension registration metadata exceeds 512 KiB");
      await atomicJson(file, next); registrations = next; await reload();
      return structuredClone(loaded.map((item) => item.record));
    }),
    unregister: (registrationId: string) => serialized(async () => {
      await initialize(); const next = registrations.filter((entry) => entry.registrationId !== registrationId);
      if (Buffer.byteLength(JSON.stringify(next)) > 512 * 1024) throw new Error("Extension registration metadata exceeds 512 KiB");
      await atomicJson(file, next); registrations = next; await reload();
      // Deliberately retain namespaced storage across uninstall/reinstall.
    }),
    snapshot(): ExtensionRecord[] { return structuredClone(loaded.map((item) => item.record)); },
    get(extensionId: string): ExtensionRecord | null { const value = loaded.find((item) => item.record.available && item.record.manifest?.id === extensionId); return value ? structuredClone(value.record) : null; },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); },
    async readAsset(extensionId: string, asset: string): Promise<{ bytes: Buffer; contentType: string; hash: string; revision: string }> {
      const item = loaded.find((candidate) => candidate.record.available && candidate.record.manifest?.id === extensionId);
      if (!item?.root || !item.assets.has(asset)) throw new Error("Extension asset is unavailable");
      try {
        const bytes = await confinedRead(item.root, asset, MAX_ASSET_BYTES);
        const hash = digest(bytes);
        if (hash !== item.assets.get(asset)) throw new Error("Extension asset changed; reload and review the package");
        return { bytes, contentType: mimeTypes[extname(asset).toLowerCase()]!, hash, revision: item.record.revision };
      } catch {
        item.record.available = false; item.record.reason = "Extension assets changed or became unavailable";
        for (const listener of listeners) listener();
        throw new Error("Extension asset is unavailable");
      }
    },
  };
}
export type ExtensionRegistry = ReturnType<typeof createExtensionRegistry>;
