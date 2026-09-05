/**
 * `@capygen/engine` — the backend adapters (CONTEXT.md §Harness).
 *
 * Phase 2 ships the Claude Code harness; Codex and the API-model loop follow in
 * Phase 3 behind the same `Harness` interface.
 */
export * from "./harness.js";
export * from "./asyncQueue.js";
export * from "./env.js";
export * from "./claude/sdk.js";
export * from "./claude/ClaudeHarness.js";
