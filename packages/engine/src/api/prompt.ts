/**
 * The one system prompt an `api` agent gets — built **once per session** and
 * never rebuilt (SPEC R24).
 *
 * This is the whole efficiency story for the API backend. Anthropic's prompt
 * cache keys on an exact prefix; a system prompt that carries the date, the turn
 * number, a todo list or "the user has 3 open files" invalidates that prefix on
 * every single turn, so a 20-turn session pays for the prefix 20 times. Nothing
 * that changes within a session is allowed in here — `buildSystemPrompt` takes
 * only facts that are fixed for the session's lifetime, and `ApiHarness` calls
 * it exactly once, in `start()`.
 *
 * The cost of that discipline is that the model is not told today's date. That
 * is the right trade: it can run `bash` if it needs one.
 */
import type { ToolDefinition } from "../tools/types.js";

export interface SystemPromptInput {
  /** The session's project directory. */
  cwd: string;
  /** `process.platform`, spelled for a model rather than for Node. */
  platform: NodeJS.Platform;
  /** The agent's display name, so a round-table agent knows who it is (R11). */
  agentName?: string;
  /** Extra, session-fixed guidance from the agent's config. */
  extra?: string;
  /** Named so the prompt can describe the shell without hard-coding it. */
  shell?: string;
}

function osLabel(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

/**
 * Tool *guidance*, not tool *schemas*: the schemas travel in the request's tools
 * block (which carries its own `cache_control`), so repeating them here would
 * double the prefix for nothing.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const os = osLabel(input.platform);
  const shell = input.shell ?? (input.platform === "win32" ? "PowerShell" : "sh");
  const lines = [
    "You are an agent inside capygen, a desktop app the user runs on their own machine.",
    input.agentName ? `You are the agent named "${input.agentName}".` : "",
    "",
    "Environment:",
    `- Working directory: ${input.cwd}`,
    `- Operating system: ${os}`,
    `- Shell used by the bash tool: ${shell}`,
    "",
    "How to work:",
    "- Use your tools to find things out. Do not guess a file's contents or a command's output.",
    "- Read a file before editing it, and match its existing style.",
    "- edit_file replaces an exact string that must occur once; include surrounding lines to make it unique.",
    "- Prefer grep and glob over listing directories one at a time.",
    "- ask_user_question is for decisions that are the user's to make. Do not use it to ask permission —",
    "  capygen already asks the user before it runs anything that writes, executes or reaches the network.",
    "- If a tool call is denied, do not try to work around the denial. Say what you needed and why.",
    "",
    "How to answer:",
    "- Be concise. The user is reading this in a chat pane, not a report.",
    "- Say what you did and what you found. No preamble, no restating the request.",
    "- Reference files by their path so the user can open them.",
    input.extra ? `\n${input.extra}` : "",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/** The provider-neutral tool schema list, built once alongside the prompt. */
export function toolSchemas(
  tools: readonly ToolDefinition[],
): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as Record<string, unknown>,
  }));
}
