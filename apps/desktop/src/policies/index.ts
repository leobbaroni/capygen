/**
 * Local execution policy (ADR-0007, Phase 9 / P17).
 *
 * Persistence lives in `@capygen/db` (migration 0010); this directory holds the
 * pure evaluator, the in-memory grant registry and the main-process service.
 * Harness enforcement at the actual boundaries is separate, still-pending work:
 * nothing here is wired into a harness, and nothing here should be described as
 * complete enforcement.
 */
export * from "./evaluate.js";
export * from "./grants.js";
export * from "./inputSnapshot.js";
export * from "./LocalPolicyService.js";
