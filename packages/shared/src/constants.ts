/** Names and defaults that more than one process needs to agree on. */

export const APP_NAME = "capygen";
/** Landing hero copy — Omnigent's, kept deliberately (SPEC §Design Reference). */
export const DEFAULT_HEADING = "What should we build?";

/** %APPDATA%\capygen — resolved by the main process via app.getPath("userData"). */
export const DB_FILE_NAME = "capygen.db";
export const LOG_DIR_NAME = "logs";
export const LOG_FILE_NAME = "capygen-desktop.log";

/** Set to a Vite dev-server URL to load the renderer from it instead of dist. */
export const DEV_URL_ENV = "CAPYGEN_DEV_URL";
/** Overrides Electron's userData dir; the e2e harness uses it for isolation. */
export const USER_DATA_ENV = "CAPYGEN_USER_DATA_DIR";
/**
 * `stub` runs the offline echo engine instead of a real backend. The e2e suite
 * sets it so the walking-skeleton run stays deterministic and spends no tokens;
 * anything else (including unset) runs the real harnesses.
 */
export const ENGINE_ENV = "CAPYGEN_ENGINE";

/** The eight mascot states (CONTEXT.md §Mascot). */
export const MASCOT_STATES = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "success",
  "error",
  "sleeping",
  "listening",
] as const;
export type MascotState = (typeof MASCOT_STATES)[number];

export interface BuiltinSlashCommand {
  name: string;
  description: string;
  /** Shown next to the name in the slash menu; also the signal the composer
   *  uses to decide insert-then-edit vs. run-immediately (R14). */
  argumentHint?: string;
}

/** Built-in slash commands (R14); backends add their own on top. */
export const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  { name: "/compact", description: "Summarise the conversation to free context" },
  { name: "/context", description: "Show what is in the model's context" },
  {
    name: "/effort",
    description: "Set the reasoning effort",
    argumentHint: "low | medium | high | default",
  },
  {
    name: "/model",
    description: "Switch the model for this agent",
    argumentHint: "<name> | default",
  },
  { name: "/help", description: "List available commands" },
  { name: "/clear", description: "Start a fresh context in this session" },
  { name: "/cost", description: "Show tokens and cost so far" },
];

/**
 * Which of the built-ins above each backend can actually run (R14).
 *
 * The list used to be offered whole to every session, which meant a Codex or
 * `api` agent was shown `/context`, `/effort`, `/help` and `/cost` — commands
 * neither backend implements. Selecting one is not a no-op: an argument-less
 * command fires straight from the menu, so `/cost` was posted to the backend as
 * the literal user message "/cost" and spent a real turn on it.
 *
 *  - **claude** — the Claude Agent SDK forwards slash text to Claude Code,
 *    whose own `slash_commands` include `clear, compact, context, effort,
 *    model, usage` (`usage` has the aliases `cost`/`stats`) — verified in
 *    `docs/spikes/claude-sdk-shapes.md` §8.1.
 *  - **codex** — slash commands are not a protocol concept (spike §2);
 *    `CodexHarness` implements `/compact`, `/model`, `/clear`, `/review` and
 *    `/status` itself and publishes them through `listCommands()` with Codex's
 *    own descriptions, so nothing is added on top of its own list here.
 *  - **api** — `ApiHarness.capabilities().slashCommands === false`; there is no
 *    command layer at all, only messages to a provider.
 */
export const BACKEND_BUILTIN_SLASH_COMMANDS: Record<string, readonly string[]> = {
  claude: ["/compact", "/context", "/effort", "/model", "/help", "/clear", "/cost"],
  codex: [],
  api: [],
};

/** The built-ins `backend` can run; unknown backends get the whole list. */
export function builtinSlashCommandsFor(backend: string | null | undefined): BuiltinSlashCommand[] {
  if (!backend) return [...BUILTIN_SLASH_COMMANDS];
  const allowed = BACKEND_BUILTIN_SLASH_COMMANDS[backend];
  if (!allowed) return [...BUILTIN_SLASH_COMMANDS];
  const names = new Set(allowed);
  return BUILTIN_SLASH_COMMANDS.filter((c) => names.has(c.name));
}
