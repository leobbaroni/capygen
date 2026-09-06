/**
 * The seam between the IPC handlers and whatever actually answers a turn.
 *
 * The handlers own the turn *rows*; an engine owns everything that happens
 * inside a turn — blocks, permission round-trips, usage. `createSessionRunner`
 * is the real implementation (Claude via `@capygen/engine`); `createStubEngine`
 * is the echo double the handler tests run against.
 */
import type { CapygenStore } from "@capygen/db";
import type { KeyProvider } from "@capygen/engine";
import type { EventChannel, EventInput, SlashCommand } from "@capygen/shared";
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

export interface Engine {
  send(args: EngineSendArgs): void;
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
   * The backend's own commands/skills/plugins for the agent that will receive
   * the next message — the session's lead unless `agentId` names another (R14).
   */
  listCommands(sessionId?: string, agentId?: string | null): SlashCommand[];
  /**
   * Release every backend. Resolves only once each harness is down *and* the
   * final status of any turn it was running has been written, so a caller can
   * close the database straight afterwards without losing that write.
   */
  dispose(): void | Promise<void>;
}

export type EngineFactory = (deps: EngineDeps) => Engine;
