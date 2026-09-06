/**
 * The sub-agent routing policy (SPEC R12, ADR-0002 "advisory and fails open").
 *
 * One pure function decides where a spawned sub-agent runs, from two inputs
 * that are both optional:
 *
 *   per-agent `Agent.subagentRouting`   >   per-session `settings.routing.subagents`
 *
 * and one fallback that is not a decision at all: **inherit**. Every failure
 * mode collapses onto that. No rule configured, a rule that names the parent's
 * own backend and model, a malformed rule, a thrown resolver — all of them
 * return `null`, and `null` means "let the backend spawn its sub-agent exactly
 * as it would have without capygen". That is the whole of "fails open": there
 * is no state in which the policy can stop a spawn, only states in which it
 * redirects one.
 *
 * A decision then splits in two, and the split is what decides *how* it is
 * enforced:
 *
 *  - **same backend** (`sameBackend: true`) — only the model changes. Claude's
 *    `PreToolUse` hook on `Task|Agent` rewrites `updatedInput.model` and the
 *    CLI spawns the sub-agent on it (proved in docs/spikes/engine.md §2 row 7).
 *    Nothing new runs; capygen only re-labels the spawn.
 *  - **another backend** (`sameBackend: false`) — no hook can do that: a Claude
 *    CLI cannot spawn a Codex thread. The parent is told, in its session-stable
 *    prompt, to call `delegate_task` instead, and capygen runs the sub-agent
 *    itself on the routed backend through the harness registry.
 */
import type { Backend, RoutingTarget } from "@capygen/shared";

/** Where the spawn comes from — the agent whose tool asked for a sub-agent. */
export interface SpawnParent {
  backend: Backend;
  model: string;
}

/** What the policy was asked about; mirrors `SubagentRouteRequest`. */
export interface SpawnRequest {
  sessionId: string;
  agentId: string;
  toolName: string;
  toolUseId?: string | undefined;
  description: string;
  subagentType?: string | undefined;
  input?: Record<string, unknown>;
}

export interface RoutingDecision {
  backend: Backend;
  model: string;
  /** True when only the model changes, i.e. the hook can enforce it. */
  sameBackend: boolean;
  /** Which layer won, for the log line and the agent info card. */
  source: "agent" | "session";
}

export interface ResolveRouteInput {
  /** `Agent.subagentRouting` — the per-agent override. */
  agent?: RoutingTarget | null | undefined;
  /** `Session.settings.routing.subagents` — the session-wide default. */
  session?: RoutingTarget | null | undefined;
  parent: SpawnParent;
}

function pick(target: RoutingTarget | null | undefined): RoutingTarget | null {
  if (!target) return null;
  const backend = typeof target.backend === "string" ? target.backend : undefined;
  const model = typeof target.model === "string" && target.model ? target.model : undefined;
  if (!backend && !model) return null;
  return { ...(backend ? { backend } : {}), ...(model ? { model } : {}) };
}

/**
 * `null` ⇒ inherit (fail open). Never throws: a caller may hand this a value
 * straight out of a database row.
 */
export function resolveRoute(input: ResolveRouteInput): RoutingDecision | null {
  const agent = pick(input.agent);
  const session = pick(input.session);
  const chosen = agent ?? session;
  if (!chosen) return null;

  const backend = chosen.backend ?? input.parent.backend;
  // A rule that names only a backend keeps the parent's model *unless* it
  // crosses backends, where the parent's model id is meaningless (a Claude
  // model id is not a Codex one). There, "no model" means the delegated
  // harness picks the backend's own default, which is what it does with "".
  const model =
    chosen.model ?? (backend === input.parent.backend ? input.parent.model : "");

  const sameBackend = backend === input.parent.backend;
  if (sameBackend && (model === "" || model === input.parent.model)) return null;

  return { backend, model, sameBackend, source: agent ? "agent" : "session" };
}

/**
 * The `routeSubagent` callback `ClaudeHarness` takes, built from a policy.
 *
 * Two things this deliberately does *not* do:
 *  - it never returns a route for a cross-backend decision. The hook's only
 *    lever is `updatedInput.model`, and handing Claude a Codex model id would
 *    fail the spawn outright — the opposite of failing open. Cross-backend goes
 *    through `delegate_task`, and the native spawn is left untouched.
 *  - it never throws. `ClaudeHarness` already catches, but a policy that can
 *    only be wrong by returning `null` is one less thing to reason about.
 */
export function createSubagentRouter(deps: {
  route: (req: SpawnRequest) => RoutingDecision | null;
  log?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}): (req: SpawnRequest) => { model: string; backend: Backend } | null {
  return (req) => {
    try {
      const decision = deps.route(req);
      if (!decision) return null;
      if (!decision.sameBackend) {
        deps.log?.info(
          `[routing] ${req.toolName} for agent ${req.agentId} routes to ` +
            `${decision.backend}/${decision.model}; the native spawn is left alone ` +
            "(delegate_task is the cross-backend path)",
        );
        return null;
      }
      if (!decision.model) return null;
      return { model: decision.model, backend: decision.backend };
    } catch (err) {
      deps.log?.warn("[routing] policy threw; failing open", err);
      return null;
    }
  };
}
