/**
 * The local tool runtime's registry and its permission gate (SPEC R9, R27).
 *
 * The gate is one pure function, `gateFor(mode, class)`, so the rule is
 * reviewable in one place and testable without a model:
 *
 * | permissionMode     | read  | write | execute | network | interaction |
 * |--------------------|-------|-------|---------|---------|-------------|
 * | `default`          | allow | ask   | ask     | ask     | allow       |
 * | `acceptEdits`      | allow | allow | ask     | ask     | allow       |
 * | `bypassPermissions`| allow | allow | allow   | allow   | allow       |
 * | `plan`             | allow | deny  | deny    | deny    | allow       |
 *
 * `plan` denies rather than asks on purpose: plan mode's contract is "nothing
 * changes until the plan is accepted", and a mode that could be clicked out of
 * one tool call at a time would not keep it. The denial message tells the model
 * to present its plan instead, which is what Claude Code's plan mode does.
 */
import type { PermissionMode } from "@capygen/shared";
import { askUserQuestionTool } from "./ask.js";
import { createBashTool, type BashToolDeps } from "./bash.js";
import { FS_TOOLS } from "./fs.js";
import { createGrepTool, globTool, type GrepDeps } from "./search.js";
import { createWebFetchTool, type WebFetchDeps } from "./web.js";
import type { PermissionClass, ToolDefinition } from "./types.js";

export type PermissionGate = "allow" | "ask" | "deny";

export function gateFor(mode: PermissionMode, permissionClass: PermissionClass): PermissionGate {
  if (permissionClass === "read" || permissionClass === "interaction") return "allow";
  switch (mode) {
    case "bypassPermissions":
      return "allow";
    case "acceptEdits":
      return permissionClass === "write" ? "allow" : "ask";
    case "plan":
      return "deny";
    case "default":
    default:
      return "ask";
  }
}

/** Why a `deny` gate refused, in words the model can act on. */
export function gateDenialMessage(mode: PermissionMode, tool: ToolDefinition): string {
  if (mode === "plan") {
    return (
      `plan mode: ${tool.name} (${tool.permissionClass}) is not available until the user accepts a plan. ` +
      "Present the plan instead of running it."
    );
  }
  return `${tool.name} was refused by the ${mode} permission mode.`;
}

export interface BuiltinToolDeps {
  bash?: BashToolDeps;
  grep?: GrepDeps;
  web?: WebFetchDeps;
  /** Drop tools by name (e.g. a harness configured without network access). */
  exclude?: readonly string[];
}

/**
 * The nine tools an `api` agent gets. Order is stable because it is part of the
 * request body a provider caches on (R24): a reshuffled tool array is a cache
 * miss for no reason.
 */
export function builtinTools(deps: BuiltinToolDeps = {}): ToolDefinition[] {
  const tools = [
    ...FS_TOOLS,
    globTool,
    createGrepTool(deps.grep ?? {}),
    createBashTool(deps.bash ?? {}),
    createWebFetchTool(deps.web ?? {}),
    askUserQuestionTool,
  ];
  if (!deps.exclude || deps.exclude.length === 0) return tools;
  const excluded = new Set(deps.exclude);
  return tools.filter((tool) => !excluded.has(tool.name));
}

/** Name → tool, for the loop's dispatch. */
export function toolMap(tools: readonly ToolDefinition[]): Map<string, ToolDefinition> {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

export const BUILTIN_TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "glob",
  "grep",
  "bash",
  "web_fetch",
  "ask_user_question",
] as const;
