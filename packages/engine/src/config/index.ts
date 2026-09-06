/**
 * The config-sync engine (SPEC R19-R21, R28-R30; PLAN Phase 6).
 *
 * Everything here is pure Node — file IO, child processes, string parsing — so
 * `apps/desktop` can own the stateful half (watchers, the SQLite cache, IPC)
 * while the rules about *what a backend's configuration means* live next to the
 * harnesses that consume them, and can be tested against a temp home with no
 * Electron in the room.
 */
export * from "./types.js";
export * from "./paths.js";
export * from "./files.js";
export * from "./cli.js";
export * from "./toml.js";
export * from "./layering.js";
export * from "./ClaudeConfigStore.js";
export * from "./CodexConfigStore.js";
export * from "./ApiConfigStore.js";
