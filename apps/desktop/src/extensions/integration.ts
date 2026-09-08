import { execFile } from "node:child_process";
import { BrowserWindow, dialog, shell } from "electron";
import type { CapygenStore } from "@capygen/db";
import { cleanEnv } from "@capygen/engine";
import type { ExtensionDescriptor, ExtensionRegistration, ExtensionSessionSummary } from "@capygen/shared";
import type { ExtensionHandlers } from "../ipc/extensions.js";
import { createExtensionRegistry } from "./registry.js";
import { createExtensionStorage } from "./storage.js";
import { createExtensionCapabilityService } from "./service.js";
import { createExtensionHost, type ExtensionViewHandle } from "./host.js";
import { createExtensionPullRequestAdapter } from "./pullRequest.js";

export function createExtensionIntegration(deps: { store: CapygenStore; profileDirectory: string; window(): BrowserWindow | null }) {
  const registry = createExtensionRegistry(deps.profileDirectory);
  const storage = createExtensionStorage(deps.profileDirectory);
  const windows = new Map<number, { host: ReturnType<typeof createExtensionHost>; service: ReturnType<typeof createExtensionCapabilityService>; views: Map<string, ExtensionViewHandle>; tokens: Record<string, string>; listeners: Set<(theme: Record<string, string>) => void> }>();
  let disposed = false;
  const owner = () => { const win = deps.window(); if (disposed || !win || win.isDestroyed()) throw new Error("Extension window is unavailable"); return win; };
  const changed = () => { for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send("extensions.changed", {}); };
  const stopRegistry = registry.subscribe(changed);
  const pullRequest = createExtensionPullRequestAdapter({ context: async (sessionId) => {
    const session = deps.store.sessions.get(sessionId);
    const project = session && deps.store.projects.get(session.projectId);
    if (!project || session?.archived) return null;
    const branch = await new Promise<string>((resolve) => execFile("git", ["branch", "--show-current"], { cwd: project.path, timeout: 3000, maxBuffer: 4096, windowsHide: true, env: cleanEnv() }, (error, stdout) => resolve(error ? "" : stdout.trim())));
    return branch ? { workingDirectory: project.path, branch } : null;
  } });
  function state(win: BrowserWindow) {
    const existing = windows.get(win.id); if (existing) return existing;
    const tokens: Record<string, string> = {};
    const listeners = new Set<(theme: Record<string, string>) => void>();
    const navigate = (route: string, signal: AbortSignal) => { if (signal.aborted || win.isDestroyed()) throw new Error("Navigation cancelled"); win.webContents.send("extensions.navigate", { route }); };
    const service = createExtensionCapabilityService({ registry, storage, adapters: {
      theme: { current: () => ({ ...tokens }), subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } },
      navigation: {
        openPage: (pageId, params, signal) => {
          const record = registry.snapshot().find((entry) => entry.available && entry.manifest?.pages.some((page) => page.id === pageId));
          if (!record?.manifest) throw new Error("Page unavailable");
          navigate(`/extensions/page/${encodeURIComponent(record.manifest.id)}/${encodeURIComponent(pageId)}?${new URLSearchParams(params)}`, signal);
        },
        openSession: (id, signal) => { if (!deps.store.sessions.get(id)) return false; navigate(`/c/${encodeURIComponent(id)}`, signal); return true; },
        openNewSession: (projectId, signal) => { if (projectId && !deps.store.projects.get(projectId)) return false; navigate(projectId ? `/?projectId=${encodeURIComponent(projectId)}` : "/", signal); return true; },
        openExternal: async (url, signal) => { if (signal.aborted || win.isDestroyed()) throw new Error("Navigation cancelled"); await shell.openExternal(url); },
      },
      sessions: {
        listPage: ({ after, limit }, signal) => {
          if (signal.aborted) return [];
          const rows = deps.store.db.all<{ id: string; title: string; status: string; project_id: string; created_at: number; updated_at: number; path: string | null }>(
            `SELECT s.id,s.title,s.status,s.project_id,s.created_at,s.updated_at,p.path FROM sessions s LEFT JOIN projects p ON p.id=s.project_id WHERE s.archived=0 ${after ? "AND (s.created_at < ? OR (s.created_at = ? AND s.id < ?))" : ""} ORDER BY s.created_at DESC,s.id DESC LIMIT ?`,
            ...(after ? [after.createdAt, after.createdAt, after.id, limit] : [limit]));
          return rows.map((row): ExtensionSessionSummary => ({ id: row.id, title: row.title ?? "", status: row.status, projectId: row.project_id, createdAt: row.created_at, updatedAt: row.updated_at, unread: null, titleProvisional: null, workingDirectory: row.path, worktreeBranch: null }));
        }, pullRequest,
      },
      projects: {
        list: () => deps.store.projects.list().map((project) => ({ id: project.id, name: project.name, icon: null })),
        create: async (name, signal) => {
          if (signal.aborted || win.isDestroyed()) return null;
          const selected = await dialog.showOpenDialog(win, { title: "Choose a folder for the extension's project", properties: ["openDirectory"] });
          if (signal.aborted || win.isDestroyed() || selected.canceled || !selected.filePaths[0]) return null;
          const project = deps.store.projects.upsertByPath({ path: selected.filePaths[0], name });
          changed(); return { id: project.id, name: project.name, icon: null };
        },
      },
    } });
    const entry = { host: createExtensionHost({ registry, service }), service, views: new Map<string, ExtensionViewHandle>(), tokens, listeners };
    windows.set(win.id, entry);
    win.once("closed", () => { entry.host.dispose(); service.dispose(); windows.delete(win.id); });
    return entry;
  }
  const handlers: ExtensionHandlers = {
    "extensions.list": async ({ offset }) => {
      await registry.initialize(); const all = registry.snapshot();
      const items = all.slice(offset, offset + 8).map((record): ExtensionDescriptor => ({ ...record.registration, registrationId: record.registrationId, available: record.available, reason: record.reason ?? null, name: record.manifest?.name ?? record.registration.expectedId,
        pages: record.available ? (record.manifest?.pages ?? []).map(({ id, title }) => ({ id, title })) : [], navigation: record.available ? record.manifest?.navigation ?? [] : [] }));
      return { items, nextOffset: offset + items.length < all.length ? offset + items.length : null };
    },
    "extensions.pick": async () => { const result = await dialog.showOpenDialog(owner(), { title: "Choose a local extension package", properties: ["openDirectory"] }); return result.canceled ? null : result.filePaths[0] ?? null; },
    "extensions.register": async (input: ExtensionRegistration) => {
      const win = owner();
      const answer = await dialog.showMessageBox(win, { type: "question", buttons: ["Cancel", "Register package"], defaultId: 0, cancelId: 0, title: "Register local extension", message: `${input.expectedId} · ${input.expectedVersion}`, detail: `${input.root}\n\nCapabilities: ${input.grants.join(", ") || "none"}\n${input.grants.includes("sessions.read") ? "Session access exposes titles and local working-directory paths, never messages or credentials.\n" : ""}${input.localDevelopment ? "Local development: version mismatch is explicitly allowed.\n" : "Package identity and version must match.\n"}This loads local executable page code in an isolated view.` });
      if (answer.response !== 1 || win.isDestroyed()) return { ok: false };
      await registry.register(input); return { ok: true };
    },
    "extensions.unregister": async ({ registrationId }) => { owner(); await registry.unregister(registrationId); return { ok: true }; },
    "extensions.refresh": async () => { owner(); await registry.refresh(); return { ok: true }; },
    "extensions.open": async (input) => { const win = owner(); await registry.initialize(); const entry = state(win); for (const view of entry.views.values()) view.dispose(); entry.views.clear(); const view = await entry.host.open({ window: win, ...input }); entry.views.set(view.instanceId, view); return { instanceId: view.instanceId }; },
    "extensions.bounds": ({ instanceId, bounds }) => { const view = state(owner()).views.get(instanceId); if (!view) return { ok: false }; view.setBounds(bounds); return { ok: true }; },
    "extensions.close": ({ instanceId }) => { const entry = state(owner()); const view = entry.views.get(instanceId); view?.dispose(); entry.views.delete(instanceId); return { ok: !!view }; },
    "extensions.theme": ({ tokens }) => { const entry = state(owner()); for (const key of Object.keys(entry.tokens)) delete entry.tokens[key]; Object.assign(entry.tokens, tokens); for (const listener of entry.listeners) listener({ ...tokens }); return { ok: true }; },
  };
  return { handlers, registry, dispose() { disposed = true; stopRegistry(); for (const entry of windows.values()) { entry.host.dispose(); entry.service.dispose(); } windows.clear(); } };
}
