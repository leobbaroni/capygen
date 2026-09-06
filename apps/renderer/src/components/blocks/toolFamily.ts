/**
 * Per-family tool-call helpers (SPEC R6 item 3: "ToolCallCard per family").
 *
 * `ToolCallBlock.family` is optional and, today, only ever set by the API
 * tool runtime and the Codex harness (packages/engine/src/{tools,codex}) —
 * `ClaudeHarness` does not stamp it yet (verified: no `family:` assignment
 * anywhere in packages/engine/src/claude/ClaudeHarness.ts). `effectiveFamily`
 * is the fallback: it classifies Claude Code's own native tool names
 * (`Bash`, `Read`, …) and capygen's own API-backend tool names (`bash`,
 * `read_file`, …) the same way, so every card in this file works against
 * both today's Claude-only transcripts and tomorrow's Codex/API ones without
 * caring which harness produced the block.
 *
 * Field names are read defensively (`path` **or** `file_path`, etc.) for the
 * same reason: Claude's native tools and capygen's own tool runtime do not
 * always agree on argument names for the same concept.
 */
import type { ToolCallBlock, ToolCallFamily } from "@capygen/shared";
import { truncate } from "./blockFormat";

/** Claude Code's own tool names → family. */
const CLAUDE_TOOL_FAMILY: Record<string, ToolCallFamily> = {
  Bash: "bash",
  BashOutput: "bash",
  KillShell: "bash",
  Read: "read",
  NotebookRead: "read",
  Write: "write",
  NotebookEdit: "write",
  Edit: "edit",
  MultiEdit: "edit",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "web",
  WebSearch: "web",
  Task: "task",
};

/** capygen's own API-backend tool runtime names (packages/engine/src/tools/*). */
const API_TOOL_FAMILY: Record<string, ToolCallFamily> = {
  bash: "bash",
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  list_dir: "read",
  glob: "glob",
  grep: "grep",
  web_fetch: "web",
};

/** The family this card should render as, falling back to name-based
 *  classification when the block did not carry one. */
export function effectiveFamily(
  block: Pick<ToolCallBlock, "family" | "name" | "serverName">,
): ToolCallFamily {
  if (block.family) return block.family;
  if (block.serverName) return "mcp";
  if (block.name.startsWith("mcp__")) return "mcp";
  return CLAUDE_TOOL_FAMILY[block.name] ?? API_TOOL_FAMILY[block.name] ?? "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function bashCommand(input: unknown): string | undefined {
  return isRecord(input) ? str(input.command) : undefined;
}

/** `path` (capygen's own tools) or `file_path` (Claude's Read/Write/Edit). */
export function filePath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return str(input.path) ?? str(input.file_path);
}

/** `offset`/`limit` (both tool sets use these names for Read). */
export function lineRange(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const offset = num(input.offset);
  const limit = num(input.limit);
  if (offset === undefined && limit === undefined) return undefined;
  const start = offset ?? 1;
  if (limit === undefined) return `from line ${start}`;
  return `lines ${start}-${start + limit - 1}`;
}

export interface EditStrings {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/** `old_string`/`new_string` — the one pair of names Claude's Edit tool and
 *  capygen's `edit_file` happen to share. */
export function editStrings(input: unknown): EditStrings | null {
  if (!isRecord(input)) return null;
  const oldString = str(input.old_string);
  const newString = typeof input.new_string === "string" ? input.new_string : undefined;
  if (oldString === undefined || newString === undefined) return null;
  return { oldString, newString, replaceAll: input.replace_all === true };
}

export function writeContent(input: unknown): string | undefined {
  return isRecord(input) && typeof input.content === "string" ? input.content : undefined;
}

export function searchPattern(input: unknown): string | undefined {
  return isRecord(input) ? str(input.pattern) : undefined;
}

/** Grep's optional file filter (`glob`, shared name across both tool sets). */
export function searchGlob(input: unknown): string | undefined {
  return isRecord(input) ? str(input.glob) : undefined;
}

export function fetchUrl(input: unknown): string | undefined {
  return isRecord(input) ? str(input.url) : undefined;
}

/** Best-effort exit/timeout status lifted out of a bash tool's own output
 *  text (capygen's `bash` tool embeds `(exit code N)` / `(timed out …)` /
 *  `(ended on signal …)` in its first lines; Claude's native Bash usually
 *  does not, so this quietly renders nothing rather than guessing). */
export function bashExitStatus(text: string | null): string | undefined {
  if (!text) return undefined;
  const m = /\((exit code \d+|timed out after [^)]+|ended on signal [^)]+)\)/.exec(text);
  return m?.[1];
}

/** One line per summary, tailored to what the family's arguments actually
 *  are — `null` defers to the generic key:value summarizer. */
export function familySummary(family: ToolCallFamily, input: unknown): string | null {
  switch (family) {
    case "bash": {
      const command = bashCommand(input);
      return command ? truncate(command, 100) : null;
    }
    case "read": {
      const path = filePath(input);
      if (!path) return null;
      const range = lineRange(input);
      return range ? `${path} (${range})` : path;
    }
    case "write":
    case "edit":
      return filePath(input) ?? null;
    case "glob":
    case "grep": {
      const pattern = searchPattern(input);
      if (!pattern) return null;
      const glob = family === "grep" ? searchGlob(input) : undefined;
      return glob ? `${truncate(pattern, 60)} (${glob})` : truncate(pattern, 80);
    }
    case "web": {
      const url = fetchUrl(input);
      return url ? truncate(url, 100) : null;
    }
    default:
      return null;
  }
}

/** `mcp__<server>__<tool>` (Claude's namespacing) split into display parts,
 *  falling back to `block.serverName` when the harness already supplied it
 *  structurally (Codex, the API runtime). */
export function mcpServerAndTool(
  block: Pick<ToolCallBlock, "name" | "serverName">,
): { server: string; tool: string } {
  if (block.serverName) return { server: block.serverName, tool: block.name };
  const parts = block.name.split("__");
  if (parts.length >= 3 && parts[0] === "mcp") {
    return { server: parts[1] as string, tool: parts.slice(2).join("__") };
  }
  return { server: "MCP", tool: block.name };
}

export interface SimpleDiff {
  patch: string;
  additions: number;
  deletions: number;
}

/**
 * A minimal line-based diff between an edit's before/after text — not a real
 * LCS diff (no dependency for one), just common-prefix/common-suffix
 * trimming so an edit that only touches a few lines does not render as a
 * wholesale delete+insert of the entire string.
 */
export function buildEditDiff(oldString: string, newString: string): SimpleDiff {
  const oldLines = oldString.split(/\r?\n/);
  const newLines = newString.split(/\r?\n/);
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const removed = oldLines.slice(start, endOld);
  const added = newLines.slice(start, endNew);
  const lines = [
    `@@ -${start + 1},${removed.length} +${start + 1},${added.length} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ];
  return { patch: lines.join("\n"), additions: added.length, deletions: removed.length };
}

/** A `write_file`/`Write` call has no "before" to diff against — rendered as
 *  a whole-file addition, same shell as an edit's diff view. */
export function buildWriteDiff(content: string): SimpleDiff {
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  const patch = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");
  return { patch, additions: lines.length, deletions: 0 };
}

/** One MCP `CallToolResult.content` item, read loosely — shape varies by server. */
export interface McpContentItem {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  [key: string]: unknown;
}

/** `output` read as an MCP `CallToolResult` (`{content: [...]}`) — `null`
 *  when it is not shaped that way, so the caller falls back to plain text/JSON. */
export function mcpContentItems(output: unknown): McpContentItem[] | null {
  if (!isRecord(output)) return null;
  const content = output.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  return content.filter(isRecord) as McpContentItem[];
}

/** The subagent block id a `Task`/`task`-family call would have produced
 *  (`ClaudeHarness` keys sub-agent blocks by the same `toolUseId` the
 *  spawning tool call carries), or `null` when there is nothing to link to. */
export function subagentBlockId(toolUseId: string | undefined): string | null {
  return toolUseId ? `subagent:${toolUseId}` : null;
}

/** A glob/grep result's own header line ("N matches for …") plus a bare list
 *  of hits below it — split so the list can render as `<li>` rows instead of
 *  one opaque `<pre>` block. Returns `null` when `text` does not look like
 *  that shape (e.g. an error message), so the caller falls back to plain text. */
export function splitResultList(text: string): { header: string | null; items: string[] } | null {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const looksLikeHeader = /^\d+ match(es)? for /.test(first) || /^No (files|matches)/.test(first);
  if (!looksLikeHeader) return null;
  const rest = lines.slice(1).filter((l) => l.length > 0);
  return { header: first, items: rest };
}
