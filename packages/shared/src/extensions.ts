import { z } from "zod";

export const EXTENSION_API_VERSION = 1;
export const EXTENSION_CAPABILITIES = ["theme", "navigation", "storage.user", "sessions.read", "sessions.pullRequest", "projects.read", "projects.create"] as const;
export const ExtensionCapabilitySchema = z.enum(EXTENSION_CAPABILITIES);
export type ExtensionCapability = z.infer<typeof ExtensionCapabilitySchema>;
export const ExtensionIdSchema = z.string().max(120).regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/);
const assetPath = z.string().min(1).max(240).refine((value) => !value.includes("\\") && !value.includes(":") && !value.includes("%") && !value.includes("\0") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Asset must be a relative package path");
export const ExtensionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: ExtensionIdSchema,
  version: z.string().max(80).regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/),
  name: z.string().trim().min(1).max(100),
  capabilities: z.array(ExtensionCapabilitySchema).max(7).default([]),
  assets: z.array(assetPath).max(256).default([]),
  pages: z.array(z.object({ id: ExtensionIdSchema, route: z.string().max(80).regex(/^[a-z][a-z0-9-]*$/), title: z.string().trim().min(1).max(100), entry: assetPath }).strict()).max(32).default([]),
  navigation: z.array(z.object({ id: ExtensionIdSchema, pageId: ExtensionIdSchema, label: z.string().trim().min(1).max(100) }).strict()).max(32).default([]),
}).strict().superRefine((manifest, context) => {
  const ids = new Set([manifest.id]);
  const routes = new Set<string>();
  for (const entry of [...manifest.pages, ...manifest.navigation]) {
    if (!entry.id.startsWith(`${manifest.id}.`) || ids.has(entry.id)) context.addIssue({ code: "custom", message: "Contribution IDs must be unique and inside the extension namespace" });
    ids.add(entry.id);
  }
  for (const page of manifest.pages) {
    if (routes.has(page.route)) context.addIssue({ code: "custom", message: "Page routes must be unique" });
    routes.add(page.route);
    if (!page.entry.endsWith(".html")) context.addIssue({ code: "custom", message: "Page entry must be HTML" });
  }
  for (const item of manifest.navigation) if (!manifest.pages.some((page) => page.id === item.pageId)) context.addIssue({ code: "custom", message: "Navigation references an unknown page" });
  if (new Set(manifest.capabilities).size !== manifest.capabilities.length) context.addIssue({ code: "custom", message: "Duplicate capabilities" });
});
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
export const ExtensionRegistrationSchema = z.object({
  root: z.string().min(1).max(4096), expectedId: ExtensionIdSchema, expectedVersion: z.string().min(1).max(80),
  localDevelopment: z.boolean().default(false), grants: z.array(ExtensionCapabilitySchema).max(7).default([]),
}).strict();
export type ExtensionRegistration = z.infer<typeof ExtensionRegistrationSchema>;
export const ExtensionRequestSchema = z.object({
  version: z.literal(1), instanceId: z.string().uuid(), nonce: z.string().min(32).max(128),
  requestId: z.string().min(1).max(100), method: z.string().min(1).max(80), params: z.unknown().optional(),
}).strict();
export type ExtensionRequest = z.infer<typeof ExtensionRequestSchema>;
export type ExtensionResponse = { requestId: string; ok: true; result: unknown } | { requestId: string; ok: false; error: { code: string; message: string } };
export interface ExtensionSessionSummary {
  id: string; title: string; status: string; unread: boolean | null; titleProvisional: boolean | null;
  workingDirectory: string | null; worktreeBranch: string | null; projectId: string; createdAt: number; updatedAt: number;
}
export interface ExtensionSessionCursor { createdAt: number; id: string }
export interface ExtensionProjectSummary { id: string; name: string; icon: string | null }

/** Finite SDK helper: canonical pages replace previews rather than treating previews as pagination state. */
export async function listAllExtensionSessions(
  fetchPage: (input: { cursor: string | null; limit: number }) => Promise<{ items: ExtensionSessionSummary[]; nextCursor: string | null; truncated: boolean }>,
  options: { signal?: AbortSignal } = {},
): Promise<{ items: ExtensionSessionSummary[]; truncated: boolean; pages: number }> {
  const canonical = new Map<string, ExtensionSessionSummary>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  for (; pages < 200; pages++) {
    if (options.signal?.aborted) return { items: [...canonical.values()], truncated: true, pages };
    const page = await fetchPage({ cursor, limit: Math.min(1000, 5000 - canonical.size) });
    if (options.signal?.aborted) return { items: [...canonical.values()], truncated: true, pages: pages + 1 };
    if (!Array.isArray(page.items) || page.items.length > 1000) throw new Error("Invalid extension session page");
    for (const row of page.items) {
      if (!canonical.has(row.id) && canonical.size >= 5000) return { items: [...canonical.values()], truncated: true, pages: pages + 1 };
      canonical.set(row.id, row);
    }
    if (!page.nextCursor) return { items: [...canonical.values()], truncated: page.truncated, pages: pages + 1 };
    if (canonical.size >= 5000 || cursors.has(page.nextCursor)) return { items: [...canonical.values()], truncated: true, pages: pages + 1 };
    cursors.add(page.nextCursor); cursor = page.nextCursor;
  }
  return { items: [...canonical.values()], truncated: true, pages };
}
