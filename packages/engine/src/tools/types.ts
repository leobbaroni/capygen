/**
 * The local tool runtime's contract (SPEC R9, R27).
 *
 * An `api`-backend agent has no CLI to borrow tools from, so capygen supplies
 * them. Every tool is a plain object: a JSON Schema the provider advertises, a
 * `run` that does the work, and — the part R27 turns on — a **permission
 * class**. The harness never asks "is this tool `bash`?"; it asks the class,
 * and the session's `permissionMode` decides whether that class needs a card.
 *
 * Tools return *strings*, not structures: that is what a model consumes, and it
 * keeps truncation (R25) a single rule applied in one place rather than a
 * per-tool concern.
 */
import type { Question, ToolCallFamily } from "@capygen/shared";
import type { EnvRecord } from "../env.js";

/**
 * What a tool is allowed to touch. The four capability classes SPEC R9 names,
 * plus `interaction` for the tools whose whole effect is a card in the
 * transcript (`ask_user_question`) — those must never be permission-gated, or
 * the user would be asked for permission to be asked a question.
 */
export type PermissionClass = "read" | "write" | "execute" | "network" | "interaction";

/** The JSON Schema shape every tool advertises. Kept structural on purpose:
 * Anthropic wants it as `input_schema`, OpenAI as `parameters`, and neither
 * accepts anything this file could usefully narrow further. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface ToolLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Everything a tool may reach for. Nothing here is global state. */
export interface ToolContext {
  /** The session's project directory; every relative path resolves against it. */
  cwd: string;
  /** Aborted when the turn is interrupted. */
  signal?: AbortSignal;
  /** Base environment for child processes (`cleanEnv` is applied by the caller). */
  env?: EnvRecord;
  log: ToolLogger;
  /** Characters of tool output kept before it becomes a stub (R25). */
  maxOutputChars: number;
  /**
   * Raise an `AskUserQuestion` card and wait for the answer
   * (`question text → chosen option label`). Only `ask_user_question` uses it.
   */
  ask(questions: Question[], allowOther: boolean): Promise<Record<string, string>>;
}

export interface ToolResult {
  /** What goes back to the model — already truncated if it was oversized. */
  content: string;
  isError?: boolean;
  /** True when `content` is a stub; `fullOutput` then holds the whole value. */
  truncated?: boolean;
  fullOutput?: string;
  /**
   * The tool's own structured result, kept whole for the transcript. Only MCP
   * tools set it, and only because SPEC R31's widget host needs the untouched
   * `content` / `structuredContent` / `_meta` that the string above has already
   * flattened away.
   */
  raw?: unknown;
}

/** Set on a tool that came from an MCP server rather than the local runtime. */
export interface McpToolOrigin {
  serverName: string;
  /** The server's own tool name (the model sees `mcp__server__tool`). */
  toolName: string;
  /** `ui://…` from the tool's `_meta`, when it declares an MCP App UI (R31). */
  resourceUri?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  permissionClass: PermissionClass;
  /** Coarse grouping for the transcript's iconography (`ToolCallBlock.family`). */
  family: ToolCallFamily;
  parameters: JsonSchemaObject;
  /** Present only for MCP-hosted tools; drives `ToolCallBlock.serverName`. */
  mcp?: McpToolOrigin;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required string argument, or a thrown `ToolInputError`. */
export function requireString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`${key} is required and must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

/** A bad argument from the model — reported to it as a tool error, not a crash. */
export class ToolInputError extends Error {}

/**
 * R25 in one function: keep the head, say how much was dropped, and hand the
 * whole value back separately so the block row can still store it (and the UI
 * can expand the stub).
 */
export function clampText(text: string, limit: number): ToolResult {
  if (text.length <= limit) return { content: text };
  return {
    content: `${text.slice(0, limit)}\n… ${text.length - limit} more characters (truncated)`,
    truncated: true,
    fullOutput: text,
  };
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
