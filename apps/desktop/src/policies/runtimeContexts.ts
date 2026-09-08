/**
 * What main actually captured about one agent, for the policy service to
 * decide against.
 *
 * Two facts live here and nowhere else.
 *
 * **The lifecycle token.** It is minted when a harness is captured and dies
 * when that capture is released, so a grant bound to it cannot survive a
 * restarted backend, a changed configuration, or a replaced connection — even
 * one that resumes the same native conversation. It is opaque and random: it
 * identifies a capture, it does not describe one, so nothing about the user's
 * configuration leaks through it.
 *
 * **Boundary availability.** Computed per agent from that same captured
 * configuration, never unioned across agents: a Codex thread started with
 * `approvalPolicy: "never"` cannot enforce an approval-category rule however
 * its neighbour is configured. Where capygen has not *proved* it can stand in
 * the execution path, the boundary is reported unavailable with a reason —
 * claiming coverage that has not been demonstrated is the one failure mode this
 * file exists to prevent (ADR-0007, "unproven coverage must not be described as
 * complete enforcement").
 */
import { randomUUID } from "node:crypto";
import type { Backend, CodexApprovalPolicy } from "@capygen/shared";
import type { PolicyBoundary, PolicyBoundaryUnavailableReason } from "@capygen/engine";
import type { AgentPolicyContext } from "./LocalPolicyService.js";

/** Every boundary, with why it is or is not enforceable for one capture. */
export interface BoundaryState {
  boundary: PolicyBoundary;
  available: boolean;
  reason: PolicyBoundaryUnavailableReason | null;
}

/** What main knows at the moment it captures a harness. */
export interface CapturedAgent {
  sessionId: string;
  agentId: string;
  projectId: string | null;
  backend: Backend;
  /** True for an imported transcript or a received bundle: it never dispatches. */
  readOnly: boolean;
  /** The captured Codex approval policy, when this is a Codex capture. */
  codexApprovalPolicy?: CodexApprovalPolicy | undefined;
  /** Whether this capture declared client-hosted dynamic tools. */
  declaresDynamicTools?: boolean;
  /**
   * This capture is one MCP connection behind an app widget.
   *
   * Marks the *execution site*, not a widened capability: the capture still
   * reports exactly the boundaries its originating backend can enforce, and a
   * widget's call is authorized with `executionSite: "widget-host"` — capygen's
   * own MCP client intercepts it, so availability is a property of the site
   * rather than something claimed of the backend.
   */
  widgetHost?: boolean;
}

const ALL_BOUNDARIES: readonly PolicyBoundary[] = [
  "api-tool",
  "claude-pre-tool",
  "codex-dynamic-tool",
  "codex-command-approval",
  "codex-file-approval",
  "codex-permissions-approval",
];

/**
 * Whether a Codex thread's captured approval policy actually asks the app.
 *
 * `never` and `on-failure` do not produce a pre-execution approval request, so
 * a rule filed against a command or file boundary has nothing to intercept.
 * Reporting it available would be the fake coverage the ADR forbids.
 */
function codexApprovalAsksTheApp(policy: CodexApprovalPolicy | undefined): boolean {
  return policy === "untrusted" || policy === "on-request";
}

/** The boundaries one captured agent can and cannot enforce, with reasons. */
export function boundaryStates(capture: CapturedAgent): BoundaryState[] {
  const unavailable = (
    boundary: PolicyBoundary,
    reason: PolicyBoundaryUnavailableReason,
  ): BoundaryState => ({ boundary, available: false, reason });
  const available = (boundary: PolicyBoundary): BoundaryState =>
    ({ boundary, available: true, reason: null });

  return ALL_BOUNDARIES.map((boundary) => {
    switch (boundary) {
      case "api-tool":
        return capture.backend === "api"
          ? available(boundary)
          : unavailable(boundary, "unsupported-backend");
      case "claude-pre-tool":
        if (capture.backend !== "claude") return unavailable(boundary, "unsupported-backend");
        // Proven, not assumed. `packages/engine/scripts/probe-claude-hook-precedence.ts`
        // runs the pinned bundled CLI against a loopback Messages endpoint in a
        // throwaway config directory, and observes a *sentinel file on disk*
        // rather than anything capygen reports about itself. Its eight cases
        // establish the three properties this boundary needs:
        // a hook denial holds over the user's own native allow rule; it holds
        // under `bypassPermissions`; and a neutral (locally allowed) hook
        // leaves a native deny intact instead of widening it. The control case
        // confirms a neutral hook still lets an allowed tool run.
        // (e2e-out/claude-hook-astra-proof.json — no remote model, no
        // credentials, no personal config.)
        return available(boundary);
      case "codex-dynamic-tool":
        if (capture.backend !== "codex") return unavailable(boundary, "unsupported-backend");
        return capture.declaresDynamicTools === true
          ? available(boundary)
          : unavailable(boundary, "harness-unavailable");
      case "codex-command-approval":
      case "codex-file-approval":
        if (capture.backend !== "codex") return unavailable(boundary, "unsupported-backend");
        return codexApprovalAsksTheApp(capture.codexApprovalPolicy)
          ? available(boundary)
          : unavailable(boundary, "native-approval-disabled");
      case "codex-permissions-approval":
        if (capture.backend !== "codex") return unavailable(boundary, "unsupported-backend");
        // The permission-profile protocol and its response semantics are not
        // implemented, so this boundary is unavailable on every capture.
        return unavailable(boundary, "capability-unproven");
      default:
        return unavailable(boundary, "unsupported-backend");
    }
  });
}

interface Entry {
  capture: CapturedAgent;
  lifecycleToken: string;
  boundaries: BoundaryState[];
}

export interface LifecycleRegistryDeps {
  /** Called when a capture is released, so its grants die with it. */
  onLifecycleEnded?: (lifecycleToken: string) => void;
  newToken?: () => string;
}

/**
 * Every live capture, keyed by session and agent.
 *
 * A delegated child gets its own entry even though its agent id is not a
 * persisted roster row: it runs its own harness, so it has its own lifecycle
 * and its own grants, and the parent's authority does not reach it.
 */
export class LifecycleRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly newToken: () => string;

  constructor(private readonly deps: LifecycleRegistryDeps = {}) {
    this.newToken = deps.newToken ?? (() => randomUUID().replaceAll("-", ""));
  }

  private static key(sessionId: string, agentId: string): string {
    return `${sessionId}:${agentId}`;
  }

  /**
   * Record a capture and mint its token.
   *
   * Capturing over a live entry ends the old lifecycle first: a re-captured
   * agent is a *different* run, and its predecessor's grants must not carry
   * into it even when the backend resumes the same conversation.
   */
  capture(capture: CapturedAgent, lifecycleToken?: string): string {
    const key = LifecycleRegistry.key(capture.sessionId, capture.agentId);
    const previous = this.entries.get(key);
    if (previous) {
      // Re-capturing with the identity it already has is not a new lifecycle:
      // a widget connection that authorizes a second call must not revoke the
      // grants its first call made.
      //
      // The *facts* are still refreshed. The connection has not changed, but
      // the session it belongs to may have — it can have become a read-only
      // artifact, or the agent's configuration can have moved — and a capture
      // that answered from the state it was first created in would keep
      // authorizing against a world that no longer exists.
      if (lifecycleToken !== undefined && previous.lifecycleToken === lifecycleToken) {
        previous.capture = capture;
        previous.boundaries = boundaryStates(capture);
        return previous.lifecycleToken;
      }
      this.deps.onLifecycleEnded?.(previous.lifecycleToken);
    }
    const entry: Entry = {
      capture,
      // A caller that already owns an identity — an MCP connection, say —
      // supplies it, so the grant is bound to the thing itself rather than to
      // a second name for it.
      lifecycleToken: lifecycleToken ?? this.newToken(),
      boundaries: boundaryStates(capture),
    };
    this.entries.set(key, entry);
    return entry.lifecycleToken;
  }

  /** The live token for an agent, or null when nothing is captured. */
  tokenFor(sessionId: string, agentId: string): string | null {
    return this.entries.get(LifecycleRegistry.key(sessionId, agentId))?.lifecycleToken ?? null;
  }

  /** Release one capture; its grants end with it. */
  release(sessionId: string, agentId: string): boolean {
    const key = LifecycleRegistry.key(sessionId, agentId);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.deps.onLifecycleEnded?.(entry.lifecycleToken);
    return true;
  }

  /**
   * Who holds this lifecycle token, if anyone.
   *
   * A connection knows its own token but not the synthetic agent id its capture
   * was filed under, and nothing may reconstruct that id by string surgery — so
   * the registry answers it.
   */
  ownerOfToken(lifecycleToken: string): { sessionId: string; agentId: string } | null {
    for (const entry of this.entries.values()) {
      if (entry.lifecycleToken === lifecycleToken) {
        return { sessionId: entry.capture.sessionId, agentId: entry.capture.agentId };
      }
    }
    return null;
  }

  /** Release whichever capture holds this token. */
  releaseByToken(lifecycleToken: string): boolean {
    for (const [key, entry] of [...this.entries]) {
      if (entry.lifecycleToken !== lifecycleToken) continue;
      this.entries.delete(key);
      this.deps.onLifecycleEnded?.(entry.lifecycleToken);
      return true;
    }
    return false;
  }

  /** Release every capture in a session — a shutdown, or the session ending. */
  releaseSession(sessionId: string): number {
    let released = 0;
    for (const [key, entry] of [...this.entries]) {
      if (entry.capture.sessionId !== sessionId) continue;
      this.entries.delete(key);
      this.deps.onLifecycleEnded?.(entry.lifecycleToken);
      released += 1;
    }
    return released;
  }

  releaseAll(): number {
    let released = 0;
    for (const [key, entry] of [...this.entries]) {
      this.entries.delete(key);
      this.deps.onLifecycleEnded?.(entry.lifecycleToken);
      released += 1;
    }
    return released;
  }

  /** Availability for an agent, captured or not. */
  boundariesFor(sessionId: string, agentId: string): BoundaryState[] | null {
    return this.entries.get(LifecycleRegistry.key(sessionId, agentId))?.boundaries ?? null;
  }

  /**
   * The policy service's view of one agent.
   *
   * `null` when nothing is captured: the service must not be told a lifecycle
   * exists before a harness has been built, and a caller naming an uncaptured
   * agent is refused rather than given a fresh token on demand.
   */
  contextFor(sessionId: string, agentId: string): AgentPolicyContext | null {
    const entry = this.entries.get(LifecycleRegistry.key(sessionId, agentId));
    if (!entry) return null;
    return {
      projectId: entry.capture.projectId,
      readOnly: entry.capture.readOnly,
      backend: entry.capture.backend,
      lifecycleToken: entry.lifecycleToken,
      availableBoundaries: entry.boundaries
        .filter((state) => state.available)
        .map((state) => state.boundary),
      // From the capture, so the service reads a site nobody asked for.
      executionSite: entry.capture.widgetHost === true ? "widget-host" : "backend",
    };
  }

  size(): number {
    return this.entries.size;
  }
}
