/**
 * Where an `api` agent's MCP servers come from.
 *
 * SPEC R28/R29 make the backends' own files the source of truth, and an `api`
 * agent has no backend of its own — so it reads the *other* backends' files,
 * **read-only**, and sees the same servers the CLIs see:
 *
 *   1. the agent/session config (`config.mcpServers`) — highest precedence;
 *   2. `<project>/.mcp.json` — the repo's own servers (Claude Code's format);
 *   3. `~/.claude/settings.json` → `mcpServers`;
 *   4. `~/.codex/config.toml` → `[mcp_servers.<name>]`.
 *
 * Later sources never overwrite an earlier one, so a project can shadow a global
 * server by name. Nothing here writes: editing these files is Phase 6's job, and
 * doing it from the engine would break R29's "the backend's files are the source
 * of truth, edited in one place".
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpConfigSource, McpServerConfig } from "./types.js";

export interface LoadMcpServersOptions {
  /** The session's project directory (`.mcp.json` lives here). */
  projectPath?: string;
  /** `agent.config.mcpServers`, in Claude's `settings.json` shape. */
  agentConfig?: unknown;
  /** Overridden in tests; defaults to `os.homedir()`. */
  home?: string;
  /** Overridden in tests. Resolves undefined when the file is absent/unreadable. */
  readFile?: (file: string) => Promise<string | undefined>;
  log?: { warn: (...args: unknown[]) => void };
}

const defaultReadFile = async (file: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
};

export async function loadMcpServers(
  options: LoadMcpServersOptions = {},
): Promise<McpServerConfig[]> {
  const home = options.home ?? os.homedir();
  const read = options.readFile ?? defaultReadFile;
  const warn = options.log?.warn ?? ((): void => {});

  const byName = new Map<string, McpServerConfig>();
  const add = (config: McpServerConfig): void => {
    if (!byName.has(config.name)) byName.set(config.name, config);
  };

  for (const config of fromMcpServersObject(readMcpServersField(options.agentConfig), "agent")) {
    add(config);
  }

  if (options.projectPath) {
    const projectFile = path.join(options.projectPath, ".mcp.json");
    const text = await read(projectFile);
    if (text !== undefined) {
      for (const config of parseJsonMcpServers(text, "project-mcp-json", projectFile, warn)) {
        add(config);
      }
    }
  }

  const claudeSettings = await read(path.join(home, ".claude", "settings.json"));
  if (claudeSettings !== undefined) {
    for (const config of parseJsonMcpServers(
      claudeSettings,
      "claude-settings",
      path.join(home, ".claude", "settings.json"),
      warn,
    )) {
      add(config);
    }
  }

  const codexConfig = await read(path.join(home, ".codex", "config.toml"));
  if (codexConfig !== undefined) {
    for (const config of parseCodexMcpServers(codexConfig)) add(config);
  }

  return [...byName.values()];
}

function readMcpServersField(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.mcpServers)) return value.mcpServers;
  return undefined;
}

function parseJsonMcpServers(
  text: string,
  source: McpConfigSource,
  file: string,
  warn: (...args: unknown[]) => void,
): McpServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(`[mcp] ${file} is not valid JSON; ignoring it`, err);
    return [];
  }
  return fromMcpServersObject(readMcpServersField(parsed), source);
}

/** Claude Code's `mcpServers` map → our config list. */
export function fromMcpServersObject(
  value: unknown,
  source: McpConfigSource,
): McpServerConfig[] {
  if (!isRecord(value)) return [];
  const out: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const declaredType = str(raw.type);
    const url = str(raw.url);
    const command = str(raw.command);
    const transport: McpServerConfig["transport"] =
      declaredType === "sse"
        ? "sse"
        : declaredType === "http" || declaredType === "streamable-http" || (!command && url)
          ? "http"
          : "stdio";
    const config: McpServerConfig = { name, transport, source };
    if (command) config.command = command;
    if (Array.isArray(raw.args)) {
      config.args = raw.args.filter((a): a is string => typeof a === "string");
    }
    const env = stringRecord(raw.env);
    if (env) config.env = env;
    const cwd = str(raw.cwd);
    if (cwd) config.cwd = cwd;
    if (url) config.url = url;
    const headers = stringRecord(raw.headers);
    if (headers) config.headers = headers;
    if (raw.disabled === true) config.disabled = true;
    out.push(config);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ~/.codex/config.toml — a deliberately tiny TOML reader
// ---------------------------------------------------------------------------

/**
 * Only what `[mcp_servers.*]` tables actually contain: string, boolean, number,
 * an array of strings, and a single-line inline table (`env = { A = "b" }`).
 * A full TOML parser would be another dependency for four value kinds, and
 * anything it understood beyond these would still be ignored downstream.
 *
 * `startup_timeout_sec`, `tool_timeout_sec` and friends are read and dropped:
 * they exist in the file, they just have no capygen equivalent yet.
 */
export function parseCodexMcpServers(toml: string): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  let current: { name: string; values: Record<string, unknown> } | null = null;

  const flush = (): void => {
    if (!current) return;
    const values = current.values;
    const command = str(values.command);
    const url = str(values.url);
    const config: McpServerConfig = {
      name: current.name,
      transport: command ? "stdio" : url ? "http" : "stdio",
      source: "codex-config",
    };
    if (command) config.command = command;
    if (Array.isArray(values.args)) {
      config.args = values.args.filter((a): a is string => typeof a === "string");
    }
    const env = stringRecord(values.env);
    if (env) config.env = env;
    const cwd = str(values.cwd);
    if (cwd) config.cwd = cwd;
    if (url) config.url = url;
    const headers = stringRecord(values.http_headers ?? values.headers);
    if (headers) config.headers = headers;
    if (values.enabled === false) config.disabled = true;
    out.push(config);
    current = null;
  };

  for (const rawLine of toml.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) continue;

    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) {
      flush();
      const dotted = (table[1] as string).trim();
      const prefix = "mcp_servers.";
      if (dotted.startsWith(prefix)) {
        const rest = dotted.slice(prefix.length).trim();
        // The dot test has to happen *before* unquoting: `[mcp_servers.x.env]`
        // is a nested table we do not read, while `[mcp_servers."x.y"]` is a
        // single server whose name happens to contain a dot.
        const quoted =
          (rest.startsWith('"') && rest.endsWith('"')) ||
          (rest.startsWith("'") && rest.endsWith("'"));
        if (quoted || !rest.includes(".")) current = { name: unquote(rest), values: {} };
      }
      continue;
    }

    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = unquote(line.slice(0, eq).trim());
    const value = parseTomlValue(line.slice(eq + 1).trim());
    if (value !== undefined) current.values[key] = value;
  }
  flush();
  return out;
}

/** Drop a trailing `# comment`, but not a `#` inside a quoted string. */
function stripComment(line: string): string {
  let inString = false;
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(raw: string): unknown {
  if (raw.length === 0) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith('"') || raw.startsWith("'")) return unquote(raw);
  if (raw.startsWith("[")) {
    const end = raw.lastIndexOf("]");
    const body = raw.slice(1, end < 0 ? undefined : end);
    return splitTopLevel(body).map((part) => unquote(part.trim()));
  }
  if (raw.startsWith("{")) {
    const end = raw.lastIndexOf("}");
    const body = raw.slice(1, end < 0 ? undefined : end);
    const record: Record<string, string> = {};
    for (const part of splitTopLevel(body)) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      record[unquote(part.slice(0, eq).trim())] = unquote(part.slice(eq + 1).trim());
    }
    return record;
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : raw;
}

/** Split on commas that are not inside a quoted string. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let quote = "";
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  const tail = body.slice(start);
  if (tail.trim().length > 0) parts.push(tail);
  return parts.filter((part) => part.trim().length > 0);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith('"') ? inner.replace(/\\(.)/g, "$1") : inner;
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
