/**
 * The round table (ADR-0002, SPEC R10-R13, R23): mention parsing, turn-taking
 * and the two strings an agent is given — its session-stable prompt addition
 * and, per turn, the labelled context delta.
 *
 * Everything here is pure. The stateful half lives in
 * `apps/desktop/src/engine/RoundTable.ts`, which is the only place that has a
 * database and a harness registry.
 */
export * from "./types.js";
export * from "./mentions.js";
export * from "./context.js";
export * from "./prompt.js";
export * from "./dispatcher.js";
