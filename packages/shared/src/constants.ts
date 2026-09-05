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

/** Built-in slash commands (R14); backends add their own on top. */
export const BUILTIN_SLASH_COMMANDS = [
  { name: "/compact", description: "Summarise the conversation to free context" },
  { name: "/context", description: "Show what is in the model's context" },
  { name: "/effort", description: "Set the reasoning effort" },
  { name: "/model", description: "Switch the model for this agent" },
  { name: "/help", description: "List available commands" },
  { name: "/clear", description: "Start a fresh context in this session" },
  { name: "/cost", description: "Show tokens and cost so far" },
] as const;
