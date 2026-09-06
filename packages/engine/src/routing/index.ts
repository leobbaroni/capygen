/**
 * Sub-agent routing (SPEC R12): the policy that decides where a spawned
 * sub-agent runs, and the two ways that decision is enforced — Claude's
 * `PreToolUse` model rewrite for a same-backend route, `delegate_task` for a
 * cross-backend one. Both fail open.
 */
export * from "./policy.js";
export * from "./delegate.js";
export * from "./sdkMcp.js";
