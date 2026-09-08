/**
 * The seam between the IPC handlers and whatever actually answers a turn.
 *
 * The handlers own the turn *rows*; an engine owns everything that happens
 * inside a turn — blocks, permission round-trips, usage. `createSessionRunner`
 * is the real implementation (Claude via `@capygen/engine`); `createStubEngine`
 * is the echo double the handler tests run against.
 */
import type { CapygenStore } from "@capygen/db";
import type { KeyProvider, McpServerConfig } from "@capygen/engine";
import type {
  AgentDescribe,
  AgentRuntimeInfo,
  AgentToolCatalogue,
  EventChannel,
  EventInput,
  SlashCommand,
  Backend,
} from "@capygen/shared";
import type { McpPoolRegistry } from "../ipc/mcpPools.js";
import type { WidgetHostHandlers } from "../ipc/widgets.js";

export type Broadcast = <E extends EventChannel>(event: E, payload: EventInput<E>) => void;

export interface EngineLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface EngineDeps {
  store: CapygenStore;
  broadcast: Broadcast;
  log: EngineLogger;
  /**
   * [B3] The MCP Apps widget host (SPEC R31), when one is wired. The runner
   * asks it, after every finished MCP tool call, whether that tool declares a
   * `ui://` resource; if it does, the tool_call card is joined by a widget
   * block. Optional because the echo double and the handler tests have no MCP
   * client at all.
   */
  widgets?: WidgetHostHandlers;
  /**
   * How the `api` backend gets its key (SPEC R21). The engine never reads a
   * key from disk; the desktop injects one backed by Electron `safeStorage`
   * (`apps/desktop/src/ipc/secrets.ts`). Absent in tests and in the stub
   * engine, in which case the harness falls back to the documented env vars.
   */
  keys?: KeyProvider;
  /**
   * The shared, reference-counted MCP client pools (SPEC R26,
   * `apps/desktop/src/ipc/mcpPools.ts`). The `api` harness borrows from this
   * instead of opening its own connections, so it and the widget host reach a
   * project's servers through one pool rather than spawning every stdio server
   * twice per session. Absent in tests and in the stub engine.
   */
  pools?: McpPoolRegistry;
  /** Main-process resolver for the exact MCP list captured by a harness. */
  resolveMcpServers?: (args: {
    backend: Backend;
    projectId?: string;
    agentConfig?: unknown;
  }) => McpServerConfig[];
}

export interface EngineSendArgs {
  sessionId: string;
  /** The agent turn row this send fills in; created by the handler. */
  turnId: string;
  /** Which agent speaks; the session's lead when null. */
  agentId?: string | null;
  text: string;
}

export interface EnginePermissionAnswer {
  behavior: "allow" | "deny";
  updatedInput?: unknown;
  message?: string;
}

/** [B1] `chat.send`'s whole payload; the engine owns both turn rows. */
export interface EngineDispatchArgs {
  sessionId: string;
  text: string;
  /** The composer's explicit agent pick; mention parsing decides when absent. */
  agentId?: string | null;
}

export interface EngineDispatchResult {
  userTurnId: string;
  /** The first agent turn opened — what `chat.send` returns to the renderer. */
  agentTurnId: string;
  /** Every agent turn this message opened, in target order (R11). */
  agentTurnIds: string[];
  /** `@names` the message used that answer to no agent in this session — the
   *  renderer warns rather than letting a typo look like a routed message. */
  unknownMentions: string[];
}

export interface Engine {
  send(args: EngineSendArgs): void;
  /**
   * [B1] Deliver a user message through the round table (ADR-0002, SPEC R11):
   * store the user's turn, work out the target agents from its @-mentions (or
   * the lead), open a turn for each and start the chain. The engine owns the
   * rows because it is the only thing that knows when a turn *finishes*, which
   * is when the next hop is decided.
   */
  dispatch(args: EngineDispatchArgs): EngineDispatchResult;
  /**
   * [B1] Resume a chain the hop cap stopped — exactly one more hop (R11's
   * "until the user speaks or presses Continue"). `agentTurnId` is null when
   * there was nothing to continue.
   */
  continueChain(sessionId: string): { ok: boolean; agentTurnId: string | null };
  /**
   * [B1] Is a hop the cap refused still resumable for this session? Durable
   * state the `chat.chainStopped` event is only a notification of, so
   * `sessions.get` can rebuild the Continue bar for a session the user
   * navigated away from and back to.
   */
  hasPendingChain(sessionId: string): boolean;
  /** Crew Apply requires no active turn, queued chain or unanswered interaction. */
  isSessionQuiescent?(sessionId: string): boolean;
  restartSessionCrew?(sessionId: string, previousAgentIds: string[]): Promise<void>;
  /** Cancel the in-flight turn for a session. Resolves true if one was running. */
  interrupt(sessionId: string): boolean | Promise<boolean>;
  /** Route a permission card's answer back to the waiting backend. */
  answerPermission(requestId: string, answer: EnginePermissionAnswer): boolean;
  /** Route an AskUserQuestion answer (`question text → option label`). */
  answerQuestion(requestId: string, answers: Record<string, string>): boolean;
  /**
   * Route an elicitation form back to the backend that asked (R32); `null`
   * declines it. False when nothing is waiting on that request any more — the
   * same "stale card" answer `answerPermission`/`answerQuestion` give.
   */
  answerElicitation(requestId: string, answers: Record<string, unknown> | null): boolean;
  /**
   * [C] `agents.describe` (SPEC R13). The engine answers rather than the
   * handler because the interesting two-thirds of the card — capabilities and
   * the tool list — are facts of the agent's *running* harness, and the
   * harness registry is the runner's. An agent that has not spoken yet has no
   * harness and gets the config-only description, which is the honest answer
   * rather than a guess.
   */
  describeAgent(agentId: string): Promise<AgentDescribe>;
  /**
   * The backend's own commands/skills/plugins for the agent that will receive
   * the next message — the session's lead unless `agentId` names another (R14).
   */
  listCommands(sessionId?: string, agentId?: string | null): SlashCommand[];
  /**
   * [7-P1] One agent's model or config changed. The harness captured its
   * effective configuration when it was built, so the old one has to go:
   * an **idle** agent's harness is disposed immediately (its backend resume id
   * is kept, so the next turn continues the same conversation), and an agent
   * that is mid-turn is marked restart-pending and evicted when that turn ends,
   * however it ends. A running turn's options are never changed underneath it.
   *
   * Optional so the echo double and the handler tests need not implement it.
   */
  agentConfigChanged?(agentId: string): { evicted: boolean; pending: boolean };
  /**
   * [7-P1] The minimal, non-secret runtime facts a settings/e2e assertion may
   * read: which model an agent's harness is actually running, its effort when
   * one is set, and whether a restart is waiting on the current turn. Never the
   * effective config object, environment, headers or keys.
   */
  agentRuntime?(agentId: string): AgentRuntimeInfo | null;
  /** Metadata from this agent's captured runtime; initialization never sends a prompt. */
  catalogueAgent?(sessionId: string, agentId: string, initialize: boolean): Promise<AgentToolCatalogue>;
  /**
   * Release every backend. Resolves only once each harness is down *and* the
   * final status of any turn it was running has been written, so a caller can
   * close the database straight afterwards without losing that write.
   */
  dispose(): void | Promise<void>;
}

export type EngineFactory = (deps: EngineDeps) => Engine;
