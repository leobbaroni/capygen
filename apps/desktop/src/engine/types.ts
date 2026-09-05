/**
 * The seam between the IPC handlers and whatever actually answers a turn.
 *
 * The handlers own the turn *rows*; an engine owns everything that happens
 * inside a turn — blocks, permission round-trips, usage. `createSessionRunner`
 * is the real implementation (Claude via `@capygen/engine`); `createStubEngine`
 * is the echo double the handler tests run against.
 */
import type { CapygenStore } from "@capygen/db";
import type { EventChannel, EventInput, SlashCommand } from "@capygen/shared";

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
  /** The backend's own commands/skills/plugins for this session (R14). */
  listCommands(sessionId?: string): SlashCommand[];
  dispose(): void;
}

export type EngineFactory = (deps: EngineDeps) => Engine;
