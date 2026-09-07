import crypto from "node:crypto";
import type {
  McpServerEntry, McpServerEntryDraft, McpServerEntryPatch, McpServerScope, McpTransport,
} from "@capygen/shared";
import type { McpServerConfig } from "../mcp/client/types.js";
import type { IntegrationsSnapshot } from "./types.js";

export const API_MCP_SETTINGS_KEY = "api_mcp_servers";

export interface ApiMcpStore {
  read(): Record<string, unknown>;
  write(value: Record<string, unknown>): void;
}

export interface ApiMcpSecrets {
  newRef?(): string;
  setRef(ref: string, value: string): void;
  getRef(ref: string): string | null;
  hasRef(ref: string): boolean;
  deleteRef(ref: string): void;
}

export interface ApiConfigStoreDeps {
  own: ApiMcpStore;
  inherited: () => McpServerEntry[];
  secrets?: ApiMcpSecrets;
}

type SecretMutation = Record<string, string | null>;
const MCP_REF = /^mcp\/[0-9a-f]{32}$/;

export class ApiConfigStore {
  constructor(private readonly deps: ApiConfigStoreDeps) {}

  read(): IntegrationsSnapshot {
    return {
      mcpServers: [...this.ownServers(), ...this.inheritedServers()],
      plugins: [], skills: [], tools: [], marketplaces: [],
    };
  }

  /** Full own connection values for the main-process runtime resolver only. */
  runtimeMcpServers(): McpServerConfig[] {
    const out: McpServerConfig[] = [];
    for (const [name, raw] of Object.entries(this.deps.own.read())) {
      const record = asRecord(raw);
      if (!record) continue;
      const base = transportFields(name, record);
      const env = this.resolveSecrets(record, "env", "envRefs");
      const headers = this.resolveSecrets(record, "headers", "headerRefs");
      out.push({
        ...base,
        ...(env ? { env } : {}),
        ...(headers ? { headers } : {}),
        ...(record.enabled === false ? { disabled: true } : {}),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private ownServers(): McpServerEntry[] {
    const out: McpServerEntry[] = [];
    for (const [name, raw] of Object.entries(this.deps.own.read())) {
      const record = asRecord(raw);
      if (!record) continue;
      const base = transportFields(name, record);
      const envKeys = secretKeys(record, "env", "envRefs");
      const headerKeys = secretKeys(record, "headers", "headerRefs");
      out.push({
        backend: "api", name, transport: base.transport,
        ...(base.command ? { command: base.command } : {}),
        ...(base.args ? { args: base.args } : {}),
        ...(base.url ? { url: base.url } : {}),
        ...(base.cwd ? { cwd: base.cwd } : {}),
        ...(envKeys.length ? { envKeys } : {}),
        ...(headerKeys.length ? { headerKeys } : {}),
        scope: "user", source: `capygen settings (${API_MCP_SETTINGS_KEY})`,
        enabled: record.enabled !== false,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private inheritedServers(): McpServerEntry[] {
    const own = new Set(this.ownServers().map((entry) => entry.name));
    const seen = new Set<string>();
    const out: McpServerEntry[] = [];
    for (const entry of this.deps.inherited()) {
      if (own.has(entry.name) || seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push({ ...entry, backend: "api", scope: "plugin",
        source: `inherited from ${entry.backend}: ${entry.source}`, inherited: true } as McpServerEntry);
    }
    return out;
  }

  addMcpServer(scope: McpServerScope, draft: McpServerEntryDraft): McpServerEntry {
    this.assertOwnScope(scope, draft.name);
    const table = this.deps.own.read();
    if (table[draft.name] !== undefined) throw new Error(`the api backend already has an MCP server named "${draft.name}"`);
    const staged: string[] = [];
    try {
      table[draft.name] = this.toStored(draft, staged);
      this.deps.own.write(table);
    } catch (error) {
      this.cleanup(staged);
      throw error;
    }
    return this.requireOwn(draft.name);
  }

  updateMcpServer(scope: McpServerScope, name: string, patch: McpServerEntryPatch): McpServerEntry {
    this.assertOwnScope(scope, name);
    const table = this.deps.own.read();
    const existing = asRecord(table[name]);
    if (!existing) throw new Error(`the api backend has no MCP server named "${name}"`);
    const nextName = patch.name ?? name;
    if (nextName !== name && table[nextName] !== undefined) {
      throw new Error(`the api backend already has an MCP server named "${nextName}"`);
    }
    const staged: string[] = [];
    const retired: string[] = [];
    try {
      const next = this.patchStored(existing, nextName, patch, staged, retired);
      delete table[name];
      table[nextName] = next;
      this.deps.own.write(table);
    } catch (error) {
      this.cleanup(staged);
      throw error;
    }
    this.cleanup(retired);
    return this.requireOwn(nextName);
  }

  removeMcpServer(scope: McpServerScope, name: string): { ok: boolean } {
    this.assertOwnScope(scope, name);
    const table = this.deps.own.read();
    const existing = asRecord(table[name]);
    if (!existing) return { ok: false };
    const retired = storedRefs(existing);
    delete table[name];
    this.deps.own.write(table);
    this.cleanup(retired);
    return { ok: this.deps.own.read()[name] === undefined };
  }

  private toStored(draft: McpServerEntryDraft, staged: string[]): Record<string, unknown> {
    const value: Record<string, unknown> = {
      transport: draft.transport,
      ...(draft.command ? { command: draft.command } : {}),
      ...(draft.args?.length ? { args: [...draft.args] } : {}),
      ...(draft.url ? { url: draft.url } : {}),
      ...(draft.cwd ? { cwd: draft.cwd } : {}),
      ...(draft.enabled === false ? { enabled: false } : {}),
    };
    transportFields(draft.name, value);
    const envRefs = this.stageValues(draft.env, staged);
    const headerRefs = this.stageValues(draft.headers, staged);
    if (envRefs) value.envRefs = envRefs;
    if (headerRefs) value.headerRefs = headerRefs;
    return value;
  }

  private patchStored(existing: Record<string, unknown>, name: string, patch: McpServerEntryPatch,
    staged: string[], retired: string[]): Record<string, unknown> {
    const next: Record<string, unknown> = {
      transport: patch.transport ?? stringTransport(existing.transport),
      ...(patch.command ?? str(existing.command) ? { command: patch.command ?? str(existing.command) } : {}),
      ...(patch.args ?? stringArray(existing.args) ? { args: patch.args ?? stringArray(existing.args) } : {}),
      ...(patch.url ?? str(existing.url) ? { url: patch.url ?? str(existing.url) } : {}),
      ...(patch.cwd ?? str(existing.cwd) ? { cwd: patch.cwd ?? str(existing.cwd) } : {}),
      ...((patch.enabled ?? existing.enabled) === false ? { enabled: false } : {}),
    };
    this.patchSecretField(existing, next, "env", "envRefs", patch.env, staged, retired);
    this.patchSecretField(existing, next, "headers", "headerRefs", patch.headers, staged, retired);
    const retained = new Set(storedRefs(next));
    for (let index = retired.length - 1; index >= 0; index -= 1) {
      if (retained.has(retired[index] as string)) retired.splice(index, 1);
    }
    transportFields(name, next);
    return next;
  }

  private patchSecretField(existing: Record<string, unknown>, next: Record<string, unknown>,
    legacyField: string, refsField: string, mutation: SecretMutation | undefined,
    staged: string[], retired: string[]): void {
    if (mutation === undefined) {
      const legacy = stringRecord(existing[legacyField]);
      const refs = stringRecord(existing[refsField]);
      const migrated = { ...(refs ?? {}) };
      for (const [key, value] of Object.entries(legacy ?? {})) {
        if (!(key in migrated)) migrated[key] = this.stage(value, staged);
      }
      if (Object.keys(migrated).length) next[refsField] = migrated;
      return;
    }
    const currentRefs = stringRecord(existing[refsField]) ?? {};
    const legacy = stringRecord(existing[legacyField]) ?? {};
    const refs: Record<string, string> = { ...currentRefs };
    for (const [key, value] of Object.entries(legacy)) {
      if (mutation[key] !== null) refs[key] = this.stage(value, staged);
    }
    for (const [key, value] of Object.entries(mutation)) {
      const old = refs[key] ?? currentRefs[key];
      if (value === null) delete refs[key];
      else refs[key] = this.stage(value, staged);
      if (old) retired.push(old);
    }
    for (const ref of Object.values(currentRefs)) {
      if (!Object.values(refs).includes(ref) && !retired.includes(ref)) retired.push(ref);
    }
    if (Object.keys(refs).length) next[refsField] = refs;
  }

  private stageValues(values: Record<string, string> | undefined, staged: string[]): Record<string, string> | undefined {
    if (!values || Object.keys(values).length === 0) return undefined;
    const refs: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) refs[key] = this.stage(value, staged);
    return refs;
  }

  private stage(value: string, staged: string[]): string {
    const secrets = this.deps.secrets;
    if (!secrets) throw new Error("capygen cannot store API MCP secrets without safeStorage");
    const ref = secrets.newRef?.() ?? `mcp/${crypto.randomBytes(16).toString("hex")}`;
    secrets.setRef(ref, value);
    staged.push(ref);
    return ref;
  }

  private resolveSecrets(record: Record<string, unknown>, legacyField: string, refsField: string): Record<string, string> | undefined {
    const values = { ...(stringRecord(record[legacyField]) ?? {}) };
    for (const [key, ref] of Object.entries(stringRecord(record[refsField]) ?? {})) {
      if (!MCP_REF.test(ref)) continue;
      const value = this.deps.secrets?.getRef(ref);
      if (value !== null && value !== undefined) values[key] = value;
    }
    return Object.keys(values).length ? values : undefined;
  }

  private cleanup(refs: readonly string[]): void {
    for (const ref of new Set(refs)) {
      try { this.deps.secrets?.deleteRef(ref); } catch { /* inaccessible orphan only */ }
    }
  }

  private assertOwnScope(scope: McpServerScope, name: string): void {
    if (scope === "user") return;
    throw new Error(`"${name}" is inherited by the api backend, not owned by it — edit it on the backend whose config file declares it (SPEC R29)`);
  }

  private requireOwn(name: string): McpServerEntry {
    const written = this.ownServers().find((entry) => entry.name === name);
    if (!written) throw new Error(`capygen wrote the api server "${name}" but could not read it back`);
    return written;
  }
}

function transportFields(name: string, record: Record<string, unknown>): McpServerConfig {
  const command = str(record.command);
  const url = str(record.url);
  const declared = str(record.transport) ?? str(record.type);
  const transport: McpTransport = declared === "sse" ? "sse" : declared === "http" || (!command && url) ? "http" : "stdio";
  if (transport === "stdio" && !command) throw new Error(`stdio MCP server "${name}" needs a command`);
  if (transport !== "stdio" && !url) throw new Error(`${transport} MCP server "${name}" needs a url`);
  return { name, transport, source: "agent", ...(command ? { command } : {}),
    ...(stringArray(record.args) ? { args: stringArray(record.args) as string[] } : {}),
    ...(url ? { url } : {}), ...(str(record.cwd) ? { cwd: str(record.cwd) as string } : {}) };
}

function secretKeys(record: Record<string, unknown>, legacyField: string, refsField: string): string[] {
  return [...new Set([...Object.keys(stringRecord(record[legacyField]) ?? {}),
    ...Object.keys(stringRecord(record[refsField]) ?? {})])].sort((a, b) => a.localeCompare(b));
}
function storedRefs(record: Record<string, unknown>): string[] {
  return [...Object.values(stringRecord(record.envRefs) ?? {}),
    ...Object.values(stringRecord(record.headerRefs) ?? {})].filter((ref) => MCP_REF.test(ref));
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function str(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}
function stringTransport(value: unknown): McpTransport { return value === "http" || value === "sse" ? value : "stdio"; }
function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value); if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) if (typeof item === "string") out[key] = item;
  return Object.keys(out).length ? out : undefined;
}
