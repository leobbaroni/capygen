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
