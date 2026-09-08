import { useMemo, useState } from "react";
import type { Agent, AgentToolCatalogue } from "@capygen/shared";

/**
 * The session's own MCP servers, for one agent.
 *
 * Two halves that must not be confused for each other. The **editor** writes
 * `agent.config.<backend>.mcpServers` through the ordinary `agents.update`
 * path — there is no shadow table, and what is stored is exactly what the
 * resolver already reads at highest precedence. The **runtime list** is what
 * the backend reports it actually has, which is a different question: a server
 * can be configured and not yet started, configured and failing, or running
 * from the user's own files and not configured here at all.
 *
 * Every write rewrites the whole `mcpServers` map, so an entry this panel does
 * not understand must still survive one. Each row therefore keeps the **raw**
 * object it was read from and writes that object back, changing only the field
 * the user actually touched. An earlier version rebuilt every row as
 * `{command, args, disabled}`, which silently destroyed the `url`, `transport`,
 * `cwd` and every other field of every *other* server the moment one server was
 * added, removed or toggled.
 *
 * Credentials are refused rather than accepted and hidden. An authenticated
 * server belongs in Settings ▸ MCP servers, where capygen encrypts its values
 * with safeStorage; a session addition is a command and its arguments.
 */

/** Names that must never key a config record, matching the engine's own rule. */
const RESERVED_NAMES = new Set(["__proto__", "constructor", "prototype", "toString"]);

/**
 * The redaction markers `redactInlineAgentMcpCredentials` leaves behind.
 *
 * An agent crossing IPC has its inline `env`/`headers` **deleted** and replaced
 * with these name-only markers, so the renderer never holds the values. That
 * makes such an entry impossible to round-trip from here: writing the markers
 * back would persist invented keys, and writing without them would silently
 * drop the user's credentials. The panel refuses to write instead.
 */
const REDACTION_MARKERS = ["envKeys", "headerKeys"] as const;

/**
 * One stored `mcpServers` entry, as it crosses back to `agents.update`.
 *
 * Every field is optional and unknown keys are preserved: an entry may be an
 * http server with a `url` and no `command` at all, and a future capygen may
 * store a field this build has never heard of. A caller that declares
 * `command: string` here is asserting something the config does not guarantee.
 */
export interface SessionMcpServerEntry {
  command?: string;
  args?: string[];
  disabled?: boolean;
  [key: string]: unknown;
}

/** The whole map one write replaces. */
export type SessionMcpServersPatch = Record<string, SessionMcpServerEntry>;

export interface SessionMcpServerDraft {
  name: string;
  command: string;
  args: string[];
  disabled: boolean;
  /** The entry exactly as stored, so a write preserves what this panel ignores. */
  raw: Record<string, unknown>;
  /** This entry holds credentials capygen redacted; it cannot be rewritten here. */
  holdsHiddenCredentials: boolean;
}

export interface SessionMcpPanelProps {
  agent: Agent;
  /** What the backend reports right now. `null` before anything was asked. */
  catalogue: AgentToolCatalogue | null;
  /** True while a refresh is in flight, so the button can say so. */
  refreshing?: boolean;
  /** Explicit refresh only — nothing here polls a backend on its own. */
  onRefresh: () => void;
  /** Writes through `agents.update`; the caller owns the IPC call. */
  onChange: (servers: SessionMcpServersPatch) => void;
  /** Set while the session is busy: editing waits for quiescence. */
  disabledReason?: string | null;
  error?: string | null;
}

/** Values a session addition may never carry (`assertNoInlineAgentMcpCredentials`). */
const CREDENTIAL_HINT =
  /(?:^|[^A-Za-z0-9])(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|credentials?|key|bearer)(?:[^A-Za-z0-9]|$)/i;

export function readSessionServers(agent: Agent): SessionMcpServerDraft[] {
  const section = (agent.config as Record<string, unknown> | null)?.[agent.backend];
  const servers = (section as { mcpServers?: unknown } | undefined)?.mcpServers;
  if (typeof servers !== "object" || servers === null) return [];
  return Object.entries(servers as Record<string, unknown>).map(([name, value]) => {
    const raw = (typeof value === "object" && value !== null
      ? value
      : {}) as Record<string, unknown>;
    return {
      name,
      command: typeof raw.command === "string" ? raw.command : "",
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      disabled: raw.disabled === true,
      raw,
      holdsHiddenCredentials: REDACTION_MARKERS.some((marker) =>
        Object.prototype.hasOwnProperty.call(raw, marker)),
    };
  });
}

/** A transport this row runs over, for the summary line. */
function transportOf(raw: Record<string, unknown>): string {
  if (typeof raw.transport === "string") return raw.transport;
  return typeof raw.url === "string" ? "http" : "stdio";
}

/** What this row actually is, without printing anything credential-bearing. */
export function describeServer(server: SessionMcpServerDraft): string {
  const transport = transportOf(server.raw);
  if (transport !== "stdio") {
    const url = typeof server.raw.url === "string" ? server.raw.url : "";
    return url ? `${transport} · ${url}` : transport;
  }
  return [server.command, ...server.args].join(" ").trim() || "stdio";
}

export type ParsedCommandLine =
  | { ok: true; command: string; args: string[] }
  | { ok: false; reason: string };

/**
 * Split a command line into a command and its arguments.
 *
 * Quoted segments stay whole, because a Windows path routinely contains a
 * space and splitting one would produce a command that cannot be found. An
 * **unclosed** quote is refused rather than tokenised: the old pattern matched
 * the opening quote as a bare word, so `"C:\Program Files\node.exe` quietly
 * became the two arguments `"C:\Program` and `Files\node.exe` and the server
 * failed to launch with nothing on screen explaining why.
 */
export function parseCommandLine(value: string): ParsedCommandLine {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    // Anything skipped between matches must be whitespace; a stray quote is not.
    const skipped = value.slice(index, match.index);
    if (skipped.trim().length > 0) {
      return { ok: false, reason: "That command line has an unmatched quote." };
    }
    parts.push(match[1] ?? match[2] ?? "");
    index = pattern.lastIndex;
  }
  if (value.slice(index).trim().length > 0) {
    return { ok: false, reason: "That command line has an unmatched quote." };
  }
  // An odd number of quotes cannot have been fully paired, however it tokenised.
  if ((value.match(/"/g)?.length ?? 0) % 2 !== 0) {
    return { ok: false, reason: "That command line has an unmatched quote." };
  }
  const command = parts[0] ?? "";
  return { ok: true, command, args: parts.slice(1) };
}

/** Why this draft cannot be saved, or null. */
export function validateDraft(
  name: string,
  commandLine: string,
  existing: readonly string[],
): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Give the server a name.";
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(trimmed)) {
    return "A server name uses letters, numbers, dots, dashes or underscores.";
  }
  // Matches the charset but must never key a record, and the engine refuses it
  // too — accepting it here would produce a server that is silently dropped.
  if (RESERVED_NAMES.has(trimmed)) return "That name is reserved and cannot be used.";
  if (existing.includes(trimmed)) return "This session already has a server with that name.";
  const parsed = parseCommandLine(commandLine);
  if (!parsed.ok) return parsed.reason;
  if (parsed.command.length === 0) return "Give the command that starts the server.";
  if (CREDENTIAL_HINT.test(commandLine)) {
    return "This looks like a credential. Add an authenticated server in Settings ▸ MCP servers, "
      + "where capygen encrypts its values.";
  }
  return null;
}

/** What the backend reports about this server, or why it reports nothing. */
export function runtimeLabel(catalogue: AgentToolCatalogue | null, name: string): string {
  if (!catalogue) return "Not checked";
  switch (catalogue.kind) {
    case "notStarted": return "Not started";
    case "unsupported": return "Not reported by this backend";
    case "error": return "Could not be read";
    case "cancelled": return "Check cancelled";
    case "stale": return "Out of date";
    case "ok": {
      const server = catalogue.servers.find((candidate) => candidate.name === name);
      if (!server) return "Not running";
      return server.state === "connected"
        ? `Connected · ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`
        : server.state;
    }
    default: return "Unknown";
  }
}

/**
 * What a disable in this session's config has actually achieved.
 *
 * A stored `disabled` flag is a **request**, and the two backends honour it
 * differently. For Claude the resolved set is authoritative (`strictMcpConfig`),
 * so omission genuinely suppresses. For Codex the per-thread config *merges*
 * with the home's config.toml, so suppression uses explicit enabled=false
 * rather than omission. Both paths are natively verified, but a stored request
 * may precede restart: the observed runtime status is shown separately.
 */
export function disabledLabel(backend: string, runtime: string): string {
  return backend === "codex"
    ? `Disable requested · backend reports: ${runtime}`
    : `Disabled for this session · backend reports: ${runtime}`;
}

export function SessionMcpPanel(props: SessionMcpPanelProps) {
  const configured = useMemo(() => readSessionServers(props.agent), [props.agent]);
  const [name, setName] = useState("");
  const [commandLine, setCommandLine] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  // Any write rewrites the whole map, so one unrewritable entry freezes the
  // editor: the alternatives are persisting invented keys or dropping the
  // user's credentials, and neither is this panel's decision to make.
  const blocked = configured.find((server) => server.holdsHiddenCredentials);
  const lockedReason = props.disabledReason
    ?? (blocked
      ? `"${blocked.name}" stores credentials capygen cannot show here. Move it to `
        + "Settings ▸ MCP servers before editing this session's servers."
      : null);
  const locked = lockedReason !== null;

  const write = (next: SessionMcpServerDraft[]): void => {
    // The raw entry goes back exactly as it came, so a field this panel does
    // not model — `url`, `cwd`, `transport`, anything a future version adds —
    // survives an edit to a different server.
    props.onChange(Object.fromEntries(next.map((server) => [server.name, server.raw])));
  };

  const setDisabled = (target: SessionMcpServerDraft, disabled: boolean): void => {
    write(configured.map((server) => server.name !== target.name
      ? server
      : {
          ...server,
          disabled,
          // Only this one key moves; the rest of the entry is untouched.
          raw: disabled
            ? { ...server.raw, disabled: true }
            : Object.fromEntries(
                Object.entries(server.raw).filter(([key]) => key !== "disabled"),
              ),
        }));
  };

  const add = (): void => {
    const failure = validateDraft(name, commandLine, configured.map((server) => server.name));
    setProblem(failure);
    if (failure) return;
    const parsed = parseCommandLine(commandLine);
    if (!parsed.ok) {
      setProblem(parsed.reason);
      return;
    }
    const raw: Record<string, unknown> = {
      command: parsed.command,
      ...(parsed.args.length > 0 ? { args: parsed.args } : {}),
    };
    write([...configured, {
      name: name.trim(), command: parsed.command, args: parsed.args,
      disabled: false, raw, holdsHiddenCredentials: false,
    }]);
    setName("");
    setCommandLine("");
  };

  return (
    <section data-testid="session-mcp-panel" className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">Session MCP servers</h3>
          <p className="text-xs text-muted-foreground">
            Added for this agent only, on top of the servers your Claude and Codex
            configuration already provide.
          </p>
        </div>
        <button
          type="button"
          data-testid="session-mcp-refresh"
          className="rounded-md border border-border px-2 py-1 text-xs"
          onClick={props.onRefresh}
          disabled={props.refreshing === true}
        >
          {props.refreshing === true ? "Checking…" : "Refresh"}
        </button>
      </header>

      {lockedReason ? (
        <p data-testid="session-mcp-locked" className="text-xs text-muted-foreground">
          {lockedReason}
        </p>
      ) : null}
      {props.error ? (
        <p data-testid="session-mcp-error" className="text-xs text-[var(--destructive)]">
          {props.error}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2" data-testid="session-mcp-list">
        {configured.length === 0 ? (
          <li className="text-xs text-muted-foreground">This session adds no servers of its own.</li>
        ) : null}
        {configured.map((server) => (
          <li
            key={server.name}
            data-testid={`session-mcp-item-${server.name}`}
            className="flex items-center justify-between gap-2 rounded-md border border-border p-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm">{server.name}</p>
              <p className="truncate text-xs text-muted-foreground">{describeServer(server)}</p>
              <p data-testid={`session-mcp-state-${server.name}`} className="text-xs text-muted-foreground">
                {server.disabled
                  ? disabledLabel(props.agent.backend, runtimeLabel(props.catalogue, server.name))
                  : runtimeLabel(props.catalogue, server.name)}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                data-testid={`session-mcp-toggle-${server.name}`}
                className="rounded-md border border-border px-2 py-1 text-xs"
                disabled={locked}
                onClick={() => setDisabled(server, !server.disabled)}
              >
                {server.disabled ? "Enable" : "Disable"}
              </button>
              <button
                type="button"
                data-testid={`session-mcp-remove-${server.name}`}
                className="rounded-md border border-border px-2 py-1 text-xs"
                disabled={locked}
                onClick={() => write(configured.filter((candidate) => candidate.name !== server.name))}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2">
        <input
          data-testid="session-mcp-name"
          className="rounded-md border border-border bg-background p-2 text-sm"
          placeholder="Server name"
          value={name}
          disabled={locked}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          data-testid="session-mcp-command"
          className="rounded-md border border-border bg-background p-2 text-sm"
          placeholder="Command and arguments, e.g. npx -y @scope/server"
          value={commandLine}
          disabled={locked}
          onChange={(event) => setCommandLine(event.target.value)}
        />
        {problem ? (
          <p data-testid="session-mcp-problem" className="text-xs text-[var(--destructive)]">{problem}</p>
        ) : null}
        <button
          type="button"
          data-testid="session-mcp-add"
          className="self-start rounded-md border border-border px-2 py-1 text-xs"
          disabled={locked}
          onClick={add}
        >
          Add server
        </button>
      </div>
    </section>
  );
}
