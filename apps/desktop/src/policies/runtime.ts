/**
 * One local policy runtime, assembled once in main.
 *
 * ADR-0007 asks for a single `LocalPolicyService` behind management, dispatch,
 * tool execution and widgets. This is where that one instance is built and
 * given the live facts only main owns: which captures exist, what each one can
 * enforce, whether a session is genuinely quiescent, and how to interrupt it.
 *
 * The assembly is separated from `main.ts` so it can be tested without an
 * Electron process — the wiring *is* the security property here, and a mistake
 * in it (an actor read from a payload, a quiescence check that only reads the
 * session status row) is exactly the kind of thing a unit test can catch and a
 * screenshot cannot.
 */
import { BUILT_IN_OWNER_MEMBER_ID } from "@capygen/db";
import type { CapygenStore } from "@capygen/db";
import type { Backend, PermissionRequest, PolicyBoundaryAvailability } from "@capygen/shared";
import { randomUUID } from "node:crypto";
import {
  LocalPolicyService,
  originToolBoundary,
  type AgentPolicyContext,
  type PolicyActor,
} from "./LocalPolicyService.js";
import { AskBroker, type AskBrokerDeps } from "./askBroker.js";
import { LifecycleRegistry, boundaryStates, type CapturedAgent } from "./runtimeContexts.js";
import type { Broadcast } from "../engine/types.js";
import type { PolicyPreflight, SessionPolicyHooks } from "../engine/SessionRunner.js";
import type { LocalPolicyCatalogue, LocalPolicyIpcDeps } from "../ipc/localPolicies.js";

export interface PolicyRuntimeDeps {
  store: CapygenStore;
  /** How a local ask reaches the user; see `AskBroker`. */
  ask: Omit<AskBrokerDeps, "now">;
  /** Metadata-only invalidation for open management views. */
  publishChanged: (change: {
    area: "members" | "subjects" | "rules" | "grants" | "runtime";
    sessionId: string | null;
  }) => void;
  /**
   * The live engine, read lazily: it is constructed after this runtime, and a
   * captured `undefined` would make every quiescence check answer "idle".
   */
  engine: () => {
    interrupt(sessionId: string): boolean | Promise<boolean>;
    hasPendingChain(sessionId: string): boolean;
  } | null;
  now?: () => number;
}

export interface PolicyRuntime {
  service: LocalPolicyService;
  /** What `createWidgetHost` needs to govern a widget's own tool calls. */
  widgets: {
    authorizeWidgetCall(request: {
      sessionId: string;
      agentId: string;
      connectionToken: string;
      originTurnId: string | null;
      toolName: string;
      input: unknown;
    }): Promise<{ allowed: boolean; approvedInput?: unknown; message?: string | null }>;
    onConnectionEnded(connectionToken: string): void;
  };
  /**
   * Whether this machine's *current* execution subject may answer a session's
   * approvals, and why not when it may not.
   *
   * Resolved on every read rather than cached: a profile demoted to viewer in
   * another window must stop being able to approve from the Approve page too.
   */
  approvability(sessionId: string): {
    answerable: boolean;
    refusal: "viewer" | "missing-member" | "read-only-artifact" | null;
  };
  /** What `createIpcContext` needs for scheduled runs. */
  subject: {
    copyForRun(
      sourceSessionId: string,
      targetSessionId: string,
    ): { ok: true } | { ok: false; reason: string; message: string };
  };
  lifecycles: LifecycleRegistry;
  broker: AskBroker;
  /** What `createSessionRunner` needs. */
  hooks: SessionPolicyHooks;
  /** What `createIpcContext` needs for the management channels. */
  ipcDeps: LocalPolicyIpcDeps;
  dispose(): void;
}

/**
 * A context for a dispatch check, from facts alone.
 *
 * Its `lifecycleToken` is a fresh random value that no capture ever minted, so
 * this context can decide whether a turn may *start* but can never satisfy the
 * token check a tool call has to pass. Authority for execution stays with the
 * capture, exactly as ADR-0007 requires.
 */
function preflightContext(facts: PolicyPreflight): AgentPolicyContext {
  return {
    projectId: facts.projectId,
    readOnly: facts.readOnly,
    backend: facts.backend,
    lifecycleToken: `preflight-${randomUUID()}`,
    executionSite: "backend",
    availableBoundaries: boundaryStates({
      sessionId: "", agentId: "", projectId: facts.projectId,
      backend: facts.backend, readOnly: facts.readOnly,
      ...(facts.codexApprovalPolicy !== undefined
        ? { codexApprovalPolicy: facts.codexApprovalPolicy as never }
        : {}),
      declaresDynamicTools: facts.declaresDynamicTools,
    }).filter((state) => state.available).map((state) => state.boundary),
  };
}

export function createPolicyRuntime(deps: PolicyRuntimeDeps): PolicyRuntime {
  const { store } = deps;
  let service!: LocalPolicyService;

  const broker = new AskBroker({ ...deps.ask, ...(deps.now ? { now: deps.now } : {}) });

  // A capture ending revokes its grants: that is the whole point of binding a
  // grant to a lifecycle token rather than to a session.
  /**
   * The preflight context for the one `checkDispatch` currently running.
   *
   * A dispatch decision has to be made *before* anything is captured — that is
   * the whole point of checking first — so for the duration of that one
   * synchronous call `resolveContext` answers from what the agent would run
   * under. Outside it, only a real capture counts.
   *
   * Scoped rather than stored: `checkDispatch` is synchronous, so nothing can
   * interleave, and a preflight left lying around would be indistinguishable
   * from a capture the next time a tool asked to execute.
   */
  let preflight: { key: string; context: AgentPolicyContext } | null = null;

  const lifecycles = new LifecycleRegistry({
    onLifecycleEnded: (token) => {
      const revoked = service.endLifecycle(token);
      if (revoked > 0) deps.publishChanged({ area: "grants", sessionId: null });
    },
  });

  /**
   * Whether a session is really idle.
   *
   * Not the session status row alone: a round-table chain waiting on its next
   * hop and a permission card waiting on an answer are both work in flight, and
   * an ordinary reassignment that ignored them would change the execution
   * subject underneath a turn that is still going.
   */
  const isQuiescent = (sessionId: string): boolean => {
    if (store.turns.hasStreaming(sessionId)) return false;
    if (deps.engine()?.hasPendingChain(sessionId) === true) return false;
    if (broker.pending().some((entry) => entry.sessionId === sessionId)) return false;
    const session = store.sessions.get(sessionId);
    return session !== null && session.status !== "running" && session.status !== "waiting";
  };

  /**
   * A restrictive reassignment, applied at once.
   *
   * Waiting approvals are denied *before* the interrupt, so a card cannot be
   * answered into an authorization during the teardown it is being torn down
   * by.
   */
  const interruptAndDeny = (sessionId: string, reason: string): void => {
    broker.denySession(sessionId, reason);
    void Promise.resolve(deps.engine()?.interrupt(sessionId)).catch(() => {
      // Nothing to interrupt, or it is already going away.
    });
    deps.publishChanged({ area: "subjects", sessionId });
  };

  service = new LocalPolicyService({
    store: {
      localMembers: store.localMembers,
      sessionMembers: store.sessionMembers,
      localPolicyRules: store.localPolicyRules,
      localPolicyAudit: store.localPolicyAudit,
    },
    resolveContext: (sessionId, agentId) => {
      if (agentId === null) return null;
      // Preflight wins while a dispatch check is in flight: it describes the
      // configuration that is about to run, where a capture may describe one
      // the user has since changed.
      if (preflight && preflight.key === `${sessionId}:${agentId}`) return preflight.context;
      return lifecycles.contextFor(sessionId, agentId);
    },
    ask: broker.ask,
    interruptAndDeny,
    isQuiescent,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const hooks: SessionPolicyHooks = {
    capture: (info) => lifecycles.capture(info as CapturedAgent),
    release: (sessionId, agentId) => {
      // A capture going away settles anything that agent left waiting: a card
      // whose harness no longer exists can never be executed.
      broker.cancelAgent(sessionId, agentId);
      lifecycles.release(sessionId, agentId);
    },
    authorizeFor: ({ sessionId, agentId, lifecycleToken, originTurnId }) => async (request) => {
      // Bound in main: the session, the agent, the token and the turn a card
      // would belong to all come from the capture, never from the request the
      // model influenced. `stage` and `callId` are passed straight through —
      // the *service* decides whether an earlier answer for this exact call may
      // stand in for asking again, and it re-evaluates the current rules,
      // member, grants and lifecycle either way.
      const authorization = await service.authorize({
        sessionId,
        agentId,
        lifecycleToken,
        originTurnId: originTurnId(),
        boundary: request.boundary,
        toolName: request.toolName,
        input: request.input,
        cwd: request.cwd,
        stage: request.stage,
        callId: request.callId,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (authorization.grantCreated) deps.publishChanged({ area: "grants", sessionId });
      return authorization.allowed
        ? { allowed: true, approvedInput: authorization.approvedInput, message: null }
        : { allowed: false, message: authorization.message };
    },
    checkDispatch: (sessionId, agentId, facts) => {
      if (agentId === null) {
        const decision = service.checkDispatch(sessionId, agentId);
        return decision.allowed ? { allowed: true } : { allowed: false, message: decision.message };
      }
      preflight = { key: `${sessionId}:${agentId}`, context: preflightContext(facts) };
      try {
        const decision = service.checkDispatch(sessionId, agentId);
        return decision.allowed ? { allowed: true } : { allowed: false, message: decision.message };
      } finally {
        preflight = null;
      }
    },
  };

  /** What exists, what never runs, and what one capture can enforce. */
  const catalogue: LocalPolicyCatalogue = {
    sessionExists: (sessionId) => store.sessions.get(sessionId) !== null,
    projectExists: (projectId) => store.projects.get(projectId) !== null,
    isReadOnlyArtifact: (sessionId) => {
      const session = store.sessions.get(sessionId);
      return session !== null && session.origin !== "live";
    },
    boundaryAvailability: (sessionId, agentId) => {
      if (agentId === null) return null;
      const states = lifecycles.boundariesFor(sessionId, agentId);
      const agent = store.sessions.agent(agentId);
      if (!states) {
        // Nothing captured: the honest answer is that no boundary is
        // enforceable yet, not a guess from the agent's stored configuration.
        if (!agent) return null;
        return {
          backend: agent.backend as Backend,
          boundaries: [] as PolicyBoundaryAvailability[],
        };
      }
      return {
        backend: (agent?.backend ?? "api") as Backend,
        boundaries: states.map((state) => ({
          boundary: state.boundary,
          available: state.available,
          reason: state.reason,
        })) as PolicyBoundaryAvailability[],
      };
    },
  };

  /**
   * The management actor.
   *
   * Always the built-in local operator, resolved in main. A renderer naming a
   * member or a role is not authority — these are execution profiles, not
   * logins — so this closure takes no argument at all.
   */
  const actor = (): PolicyActor => ({ memberId: BUILT_IN_OWNER_MEMBER_ID });

  const ipcDeps: LocalPolicyIpcDeps = {
    service,
    catalogue,
    actor,
    // Management mutations reach open views through the same metadata-only
    // event a grant lifecycle change uses.
    publishChanged: deps.publishChanged,
    audit: {
      recent: (limit) => store.localPolicyAudit.recent(limit),
      bySession: (sessionId, limit) => store.localPolicyAudit.bySession(sessionId, limit),
    },
  };

  return {
    service,
    lifecycles,
    broker,
    hooks,
    ipcDeps,
    widgets: {
      /**
       * A widget's call, judged like a model's.
       *
       * The lifecycle token is the *connection's*, not the agent's harness
       * token: a widget runs against an MCP connection, and that connection is
       * what a grant here is bound to. The agent's own capture is still what
       * decides whether the boundary is enforceable at all, which is why the
       * session and agent come from the widget's recorded origin rather than
       * from anything the page said.
       */
      authorizeWidgetCall: async (request) => {
        // Read fresh on every call, never cached with the connection: the
        // session can have become a read-only artifact and the agent can have
        // been removed since the page was opened.
        const session = store.sessions.get(request.sessionId);
        const agent = store.sessions.agent(request.agentId);
        // Existence is not ownership. An agent from another session would
        // otherwise be captured under this one, carrying its backend and its
        // boundaries into a session it has nothing to do with.
        if (!session || !agent || agent.sessionId !== request.sessionId) {
          return { allowed: false, message: "That widget's session is no longer available." };
        }
        // A widget's lifecycle is its *connection*, not its agent's harness:
        // the page outlives a harness restart and dies with the connection. So
        // each connection registers as its own capture, under an id that
        // includes the connection's own token — two widgets on two different
        // hosts coexist as two captures rather than one replacing the other,
        // which is what would happen if every widget for an agent shared a
        // single `#widget` id.
        //
        // The originating agent's backend is preserved, so a rule written for
        // that backend still resolves; what capygen actually intercepts here is
        // its *own* MCP execution, which is why `widgetHost` marks this capture
        // as genuinely able to enforce that boundary.
        const widgetAgentId = `${request.agentId}#widget:${request.connectionToken}`;
        lifecycles.capture({
          sessionId: request.sessionId,
          agentId: widgetAgentId,
          projectId: session.projectId,
          readOnly: session.origin !== "live",
          backend: agent.backend,
          widgetHost: true,
        }, request.connectionToken);
        const authorization = await service.authorize({
          sessionId: request.sessionId,
          agentId: widgetAgentId,
          lifecycleToken: request.connectionToken,
          originTurnId: request.originTurnId,
          // The origin's own tool boundary, evaluated at capygen's widget host.
          boundary: originToolBoundary(agent.backend),
          executionSite: "widget-host",
          toolName: request.toolName,
          input: request.input,
          cwd: store.projects.get(
            store.sessions.get(request.sessionId)?.projectId ?? "")?.path ?? "",
        });
        if (authorization.grantCreated) {
          deps.publishChanged({ area: "grants", sessionId: request.sessionId });
        }
        return authorization.allowed
          ? { allowed: true, approvedInput: authorization.approvedInput, message: null }
          : { allowed: false, message: authorization.message };
      },
      onConnectionEnded: (connectionToken) => {
        // Anything that connection left waiting is settled first: a card whose
        // page and connection are both gone can never be answered, and leaving
        // it open would keep the session from ever being quiescent again.
        const owner = lifecycles.ownerOfToken(connectionToken);
        if (owner) broker.cancelAgent(owner.sessionId, owner.agentId);
        lifecycles.releaseByToken(connectionToken);
        const revoked = service.endLifecycle(connectionToken);
        if (revoked > 0) deps.publishChanged({ area: "grants", sessionId: null });
      },
    },
    approvability: (sessionId) => {
      const session = store.sessions.get(sessionId);
      if (!session) return { answerable: false, refusal: "missing-member" };
      if (session.origin !== "live") {
        return { answerable: false, refusal: "read-only-artifact" };
      }
      const subject = service.resolveSubject(sessionId);
      if (!subject) return { answerable: false, refusal: "missing-member" };
      if (subject.member.role === "viewer") return { answerable: false, refusal: "viewer" };
      return { answerable: true, refusal: null };
    },
    subject: {
      copyForRun: (sourceSessionId, targetSessionId) => {
        // What exists is main's fact, not the service's. Without this a run
        // whose source session had been deleted resolved to the *implicit*
        // built-in owner and dispatched as an owner — precisely the fallback
        // ADR-0007 forbids.
        if (!store.sessions.get(sourceSessionId)) {
          return {
            ok: false,
            reason: "unknown-session",
            message: "The session this automation belongs to no longer exists, so there is no "
              + "execution profile to run it under.",
          };
        }
        const copied = service.copySubjectForRun(sourceSessionId, targetSessionId);
        if (copied.ok) {
          deps.publishChanged({ area: "subjects", sessionId: targetSessionId });
          return { ok: true };
        }
        return { ok: false, reason: copied.reason, message: copied.message };
      },
    },
    dispose: () => {
      broker.dispose();
      lifecycles.releaseAll();
    },
  };
}

/**
 * Persist and publish a local policy's permission card.
 *
 * Typed against the event contract on purpose. The first version of this took
 * an untyped `(channel, payload)` broadcast and was called through casts in
 * main, which hid the fact that it emitted `{sessionId, agentId, request}`
 * while `permission.request` requires `{sessionId, turnId, blockId, request}`.
 * Main's event parser rejected every one of them — *before* the broker
 * registered its waiter — so every local ask died and its card sat in the
 * transcript with a null decision. Nothing here is cast any more: a payload
 * that does not satisfy the channel is now a compile error.
 *
 * The turn is supplied by the caller rather than looked up here, because the
 * agent id is not always a row: a delegated child and a widget both run under
 * synthetic ids, and their card belongs to the turn that provoked them.
 */
export function createPermissionCardPublisher(deps: {
  store: CapygenStore;
  broadcast: Broadcast;
  newBlockId: () => string;
  now?: () => number;
}): Pick<PolicyRuntimeDeps["ask"], "publish" | "settleCard"> {
  const now = deps.now ?? Date.now;
  return {
    publish: ({ sessionId, agentId, originTurnId, request }) => {
      void agentId;
      // No turn means no card, and no card means nothing to answer. Refusing
      // here is what turns an unanswerable prompt into an honest denial.
      if (!originTurnId) return null;
      const turn = deps.store.turns.get(originTurnId);
      if (!turn || turn.sessionId !== sessionId) return null;

      const block = {
        id: deps.newBlockId(),
        turnId: turn.id,
        sessionId,
        kind: "permission" as const,
        index: deps.store.blocks.nextIndex(turn.id),
        request,
        decision: null,
        createdAt: now(),
        updatedAt: now(),
      };
      const stored = deps.store.blocks.upsert(block as never);
      // The block first, then the event: a renderer that receives the request
      // can always find the card it refers to.
      deps.broadcast("chat.block", stored);
      deps.broadcast("permission.request", {
        sessionId,
        turnId: turn.id,
        blockId: stored.id,
        request,
      });
      return { blockId: stored.id, turnId: turn.id };
    },
    settleCard: ({ blockId, decision }) => {
      const block = deps.store.blocks.get(blockId);
      if (!block || block.kind !== "permission") return;
      const settled = deps.store.blocks.upsert({
        ...block,
        decision: { ...decision, decidedAt: decision.decidedAt || now() },
        updatedAt: now(),
      } as never);
      deps.broadcast("chat.block", settled);
    },
  };
}
