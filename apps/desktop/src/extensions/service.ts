import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ExtensionRequestSchema, type ExtensionCapability, type ExtensionResponse, type ExtensionSessionCursor, type ExtensionSessionSummary, type ExtensionProjectSummary } from "@capygen/shared";
import type { ExtensionRegistry } from "./registry.js";
import { ExtensionStorageError, type ExtensionStorage } from "./storage.js";

export interface ExtensionAdapters {
  theme: { current(): Record<string, string>; subscribe(listener: (theme: Record<string, string>) => void): () => void };
  navigation: {
    openPage(pageId: string, params: Record<string, string>, signal: AbortSignal): Promise<void> | void;
    openSession(sessionId: string, signal: AbortSignal): Promise<boolean> | boolean;
    openNewSession(projectId: string | undefined, signal: AbortSignal): Promise<boolean> | boolean;
    openExternal(url: string, signal: AbortSignal): Promise<void> | void;
  };
  sessions: {
    /** Canonical non-archived top-level rows, descending createdAt/id, strictly after the cursor. */
    listPage(input: { after: ExtensionSessionCursor | null; limit: number }, signal: AbortSignal): Promise<ExtensionSessionSummary[]> | ExtensionSessionSummary[];
    pullRequest(sessionId: string, signal: AbortSignal): Promise<{ available: boolean; url?: string; title?: string; reason?: string }>;
  };
  projects: {
    list(signal: AbortSignal): Promise<ExtensionProjectSummary[]> | ExtensionProjectSummary[];
    /** Native chooser; cancellation returns null, and aborted requests must create nothing. */
    create(name: string, signal: AbortSignal): Promise<ExtensionProjectSummary | null>;
  };
}
interface Instance { id: string; extensionId: string; nonce: string; revision: string; grants: ReadonlySet<ExtensionCapability>; active: Map<string, AbortController>; seen: Set<string>; urls: Set<string>; themeStop?: () => void; notify?: (event: unknown) => void }
const empty = z.object({}).strict();
const id = z.string().min(1).max(200);
const methodParams: Record<string, z.ZodType> = {
  "theme.getCurrent": empty, "theme.subscribe": empty, "theme.unsubscribe": empty,
  "navigation.openPage": z.object({ pageId: id, params: z.record(z.string().max(80), z.string().max(512)).refine((value) => Object.keys(value).length <= 16).default({}) }).strict(),
  "navigation.openSession": z.object({ sessionId: id }).strict(),
  "navigation.openNewSession": z.object({ projectId: id.optional() }).strict(),
  "navigation.openExternal": z.object({ url: z.string().url().max(2048) }).strict(),
  "storage.user.get": z.object({ key: z.string().min(1).max(128) }).strict(),
  "storage.user.set": z.object({ key: z.string().min(1).max(128), value: z.json() }).strict(),
  "storage.user.delete": z.object({ key: z.string().min(1).max(128) }).strict(),
  "sessions.getCached": empty,
  "sessions.listPage": z.object({ cursor: z.string().max(1024).nullable().optional(), limit: z.number().int().min(1).max(1000).default(25) }).strict(),
  "sessions.pullRequest": z.object({ sessionId: id }).strict(),
  "projects.list": empty, "projects.create": z.object({ name: z.string().trim().min(1).max(100) }).strict(),
};
function required(method: string): ExtensionCapability {
  if (method.startsWith("theme.")) return "theme";
  if (method.startsWith("navigation.")) return "navigation";
  if (method.startsWith("storage.user.")) return "storage.user";
  if (method === "sessions.pullRequest") return "sessions.pullRequest";
  if (method.startsWith("sessions.")) return "sessions.read";
  return method === "projects.create" ? "projects.create" : "projects.read";
}
function jsonSize(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function themeData(value: Record<string, string>): Record<string, string> {
  const entries = Object.entries(value);
  if (entries.length > 128 || entries.some(([key, token]) => key.length > 100 || typeof token !== "string" || token.length > 256) || jsonSize(value) > 16384) throw new Error("Invalid theme data");
  return Object.fromEntries(entries);
}
function summary(row: ExtensionSessionSummary): ExtensionSessionSummary {
  if (!row.id || row.id.length > 200 || !Number.isFinite(row.createdAt) || !Number.isFinite(row.updatedAt)) throw new Error("Invalid session metadata");
  return { id: row.id, title: row.title.slice(0, 512), status: row.status.slice(0, 80), unread: typeof row.unread === "boolean" ? row.unread : null,
    titleProvisional: typeof row.titleProvisional === "boolean" ? row.titleProvisional : null, workingDirectory: row.workingDirectory?.slice(0, 4096) ?? null,
    worktreeBranch: row.worktreeBranch?.slice(0, 512) ?? null, projectId: row.projectId.slice(0, 200), createdAt: row.createdAt, updatedAt: row.updatedAt };
}
function project(row: ExtensionProjectSummary): ExtensionProjectSummary { return { id: row.id.slice(0, 200), name: row.name.slice(0, 100), icon: row.icon?.slice(0, 100) ?? null }; }
const cursorSchema = z.object({ createdAt: z.number().finite(), id }).strict();
function decodeCursor(value?: string | null): ExtensionSessionCursor | null { if (!value) return null; return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8"))); }
function encodeCursor(row: ExtensionSessionSummary): string { return Buffer.from(JSON.stringify({ createdAt: row.createdAt, id: row.id })).toString("base64url"); }
function isAfter(row: ExtensionSessionSummary, after: ExtensionSessionCursor | null): boolean { return !after || row.createdAt < after.createdAt || row.createdAt === after.createdAt && row.id < after.id; }

export function createExtensionCapabilityService(deps: { registry: ExtensionRegistry; storage: ExtensionStorage; adapters: ExtensionAdapters; deadlineMs?: number }) {
  const instances = new Map<string, Instance>();
  let disposed = false;
  let concurrent = 0;
  function close(instance: Instance): void { instances.delete(instance.id); instance.themeStop?.(); for (const abort of instance.active.values()) abort.abort(); instance.urls.clear(); }
  const stopRegistry = deps.registry.subscribe(() => { for (const instance of instances.values()) { const record = deps.registry.get(instance.extensionId); if (!record || record.revision !== instance.revision || instance.grants.size !== [...instance.grants].filter((grant) => record.registration.grants.includes(grant) && record.manifest!.capabilities.includes(grant)).length) close(instance); } });
  async function execute(instance: Instance, method: string, params: Record<string, any>, signal: AbortSignal): Promise<unknown> {
    const adapter = deps.adapters;
    switch (method) {
      case "theme.getCurrent": return themeData(adapter.theme.current());
      case "theme.subscribe": {
        instance.themeStop?.();
        instance.themeStop = adapter.theme.subscribe((theme) => { if (instances.get(instance.id) !== instance) return; try { instance.notify?.({ version: 1, instanceId: instance.id, type: "theme.changed", theme: themeData(theme) }); } catch { /* malformed theme updates are not delivered */ } });
        return themeData(adapter.theme.current());
      }
      case "theme.unsubscribe": instance.themeStop?.(); instance.themeStop = undefined; return null;
      case "navigation.openPage": {
        const record = deps.registry.snapshot().find((entry) => entry.available && entry.manifest?.pages.some((page) => page.id === params.pageId));
        if (!record) throw new Error("Page is unavailable");
        await adapter.navigation.openPage(params.pageId, params.params, signal); return null;
      }
      case "navigation.openSession": if (!await adapter.navigation.openSession(params.sessionId, signal)) throw new Error("Session is unavailable"); return null;
      case "navigation.openNewSession": if (!await adapter.navigation.openNewSession(params.projectId, signal)) throw new Error("Project is unavailable"); return null;
      case "navigation.openExternal": if (!instance.urls.has(params.url)) throw new Error("External URL was not issued to this instance"); await adapter.navigation.openExternal(params.url, signal); return null;
      case "storage.user.get": return deps.storage.get(instance.extensionId, params.key);
      case "storage.user.set": await deps.storage.set(instance.extensionId, params.key, params.value, signal); return null;
      case "storage.user.delete": await deps.storage.delete(instance.extensionId, params.key, signal); return null;
      case "sessions.getCached": return null;
      case "sessions.listPage": {
        const after = decodeCursor(params.cursor);
        const raw = await adapter.sessions.listPage({ after, limit: params.limit + 1 }, signal);
        if (raw.length > 1001) throw new Error("Session adapter exceeded its bounded page");
        const rows = [...new Map(raw.map((row) => [row.id, summary(row)] as const)).values()].filter((row) => isAfter(row, after)).sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        const items: ExtensionSessionSummary[] = [];
        for (const row of rows.slice(0, params.limit)) { if (jsonSize([...items, row]) > 56 * 1024) break; items.push(row); }
        const more = rows.length > items.length;
        return { items, nextCursor: more && items.length ? encodeCursor(items.at(-1)!) : null, truncated: more };
      }
      case "sessions.pullRequest": {
        const result = await adapter.sessions.pullRequest(params.sessionId, signal);
        if (!result.available || !result.url) return { available: false, reason: "Pull request lookup is unavailable" };
        const url = new URL(result.url);
        if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || !/^\/[^/]+\/[^/]+\/pull\/\d+$/.test(url.pathname) || url.search || url.hash || result.url.length > 2048) throw new Error("Invalid pull request URL");
        if (signal.aborted || instances.get(instance.id) !== instance) throw new Error("Instance disposed");
        if (instance.urls.size >= 128) throw new Error("External URL allowance is full");
        instance.urls.add(result.url); return { available: true, url: result.url, title: result.title?.slice(0, 512) ?? "Pull request" };
      }
      case "projects.list": { const projects = await adapter.projects.list(signal); if (projects.length > 1000) throw new Error("Project list is too large"); const result: ExtensionProjectSummary[] = []; for (const row of projects) { if (jsonSize([...result, project(row)]) > 56 * 1024) break; result.push(project(row)); } return { items: result, truncated: result.length < projects.length }; }
      case "projects.create": { const result = await adapter.projects.create(params.name, signal); return result ? project(result) : null; }
      default: throw new Error("Unknown method");
    }
  }
  return {
    openInstance(extensionId: string, requestedGrants: readonly ExtensionCapability[], notify?: (event: unknown) => void) {
      if (disposed || instances.size >= 64) throw new Error("Extension instances are unavailable");
      const record = deps.registry.get(extensionId);
      if (!record?.manifest) throw new Error("Extension is unavailable");
      const grants = new Set(requestedGrants.filter((grant) => record.registration.grants.includes(grant) && record.manifest!.capabilities.includes(grant)));
      const instance: Instance = { id: randomUUID(), extensionId, nonce: randomBytes(32).toString("hex"), revision: record.revision, grants, active: new Map(), seen: new Set(), urls: new Set(), notify };
      instances.set(instance.id, instance);
      return { instanceId: instance.id, nonce: instance.nonce, extensionId, version: 1 as const, grants: [...grants] };
    },
    closeInstance(instanceId: string): void { const instance = instances.get(instanceId); if (instance) close(instance); },
    cancel(instanceId: string, requestId: string): boolean { const abort = instances.get(instanceId)?.active.get(requestId); if (!abort || abort.signal.aborted) return false; abort.abort(); return true; },
    async dispatch(boundInstanceId: string, input: unknown): Promise<ExtensionResponse> {
      let requestId = "invalid";
      let instance: Instance | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (jsonSize(input) > 65536) throw new Error("Request exceeds 64 KiB");
        const request = ExtensionRequestSchema.parse(input); requestId = request.requestId;
        instance = instances.get(boundInstanceId);
        if (!instance || request.instanceId !== boundInstanceId || request.nonce.length !== instance.nonce.length || !timingSafeEqual(Buffer.from(request.nonce), Buffer.from(instance.nonce))) throw new Error("Invalid extension authority");
        if (!Object.hasOwn(methodParams, request.method) || !instance.grants.has(required(request.method))) throw new Error("Capability is not granted");
        if (instance.seen.has(requestId) || instance.seen.size >= 4096) throw new Error("Duplicate request or instance request limit reached");
        if (instance.active.size >= 8 || concurrent >= 64) throw new Error("Extension concurrency limit reached");
        const params = methodParams[request.method]!.parse(request.params ?? {}) as Record<string, unknown>;
        const abort = new AbortController(); instance.active.set(requestId, abort); instance.seen.add(requestId); concurrent++;
        const cancelled = new Promise<never>((_, reject) => { abort.signal.addEventListener("abort", () => reject(new Error("Extension request cancelled or timed out")), { once: true }); });
        timer = setTimeout(() => abort.abort(), Math.min(10_000, Math.max(1, deps.deadlineMs ?? 10_000)));
        const work = execute(instance, request.method, params, abort.signal);
        const ownedInstance = instance;
        // A timed-out adapter still occupies its slot until it actually settles.
        // Otherwise repeated deadlines would turn a bounded bridge into unbounded background work.
        const release = () => { ownedInstance.active.delete(requestId); concurrent--; };
        void work.then(release, release);
        const result = await Promise.race([work, cancelled]);
        if (instances.get(boundInstanceId) !== instance || abort.signal.aborted) throw new Error("Extension instance is closed");
        const response: ExtensionResponse = { requestId, ok: true, result };
        if (jsonSize(response) > 65536) throw new Error("Response exceeds 64 KiB");
        return response;
      } catch (error) {
        return { requestId, ok: false, error: { code: error instanceof ExtensionStorageError ? error.code : "refused", message: error instanceof ExtensionStorageError ? error.message : "Extension request was refused or became unavailable" } };
      } finally { if (timer) clearTimeout(timer);  }
    },
    dispose(): void { disposed = true; stopRegistry(); for (const instance of instances.values()) close(instance); },
  };
}
export type ExtensionCapabilityService = ReturnType<typeof createExtensionCapabilityService>;
