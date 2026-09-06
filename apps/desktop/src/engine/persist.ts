/**
 * The two writes every engine performs: persist a block, and close a turn.
 *
 * Both live here so the echo double and the real session runner cannot drift on
 * the thing the renderer depends on — a block row and its `chat.block` event are
 * written in the same call, always upserted by id (SPEC R23: persist
 * incrementally, never rebuild a turn).
 */
import { newId, type Block, type Turn, type TurnStatus } from "@capygen/shared";
import type { EngineDeps } from "./types.js";

/** Store the block and push the stored value (never the caller's draft). */
export function emitBlock(deps: EngineDeps, block: Block): Block {
  const saved = deps.store.blocks.upsert(block);
  deps.broadcast("chat.block", saved);
  return saved;
}

export function textBlock(
  sessionId: string,
  turnId: string,
  index: number,
  text: string,
): Block {
  const ts = Date.now();
  return {
    id: newId("block"),
    turnId,
    sessionId,
    kind: "text",
    index,
    text,
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * [B1] The user's turn: stored complete, its text emitted as one block, and its
 * `mentions` recorded so the transcript keeps *who the message was addressed
 * to* rather than re-deriving it from the text later (ADR-0002).
 */
export function recordUserTurn(
  deps: EngineDeps,
  sessionId: string,
  text: string,
  mentions: readonly string[] = [],
): Turn {
  const turn = deps.store.turns.create({
    sessionId,
    role: "user",
    status: "done",
    mentions: [...mentions],
  });
  emitBlock(deps, textBlock(sessionId, turn.id, 0, text));
  deps.broadcast("chat.turnStatus", { sessionId, turnId: turn.id, status: "done" });
  return turn;
}

/**
 * [B1] One agent turn, opened `streaming` for an engine to fill in. Every
 * round-table field is set here rather than by the caller so a turn created by
 * `chat.send`, by a hop and by `chat.continue` carry the same shape:
 * `parentTurnId` orders the transcript, `triggeredByTurnId` remembers the
 * mention that started the chain, `speakerLabel` freezes the header so a later
 * rename cannot rewrite history (see `TurnSchema`).
 */
export function openAgentTurn(
  deps: EngineDeps,
  args: {
    sessionId: string;
    agentId: string | null;
    parentTurnId: string | null;
    hopIndex: number;
    triggeredByTurnId?: string | null;
    speakerLabel?: string;
    mentions?: readonly string[];
  },
): Turn {
  const turn = deps.store.turns.create({
    sessionId: args.sessionId,
    agentId: args.agentId,
    role: "agent",
    status: "streaming",
    parentTurnId: args.parentTurnId,
    hopIndex: args.hopIndex,
    triggeredByTurnId: args.triggeredByTurnId ?? null,
    ...(args.speakerLabel !== undefined ? { speakerLabel: args.speakerLabel } : {}),
    mentions: [...(args.mentions ?? [])],
  });
  deps.store.sessions.setStatus(args.sessionId, "running");
  deps.broadcast("chat.turnStatus", {
    sessionId: args.sessionId,
    turnId: turn.id,
    status: "streaming",
  });
  const session = deps.store.sessions.get(args.sessionId);
  if (session) deps.broadcast("session.updated", session);
  return turn;
}

/**
 * [B1] A `system` turn — capygen speaking in the transcript rather than an
 * agent. Today only the hop-cap notice (SPEC R11); it is a real turn so it
 * survives a relaunch and so the "Continue" affordance has something to sit on.
 */
export function systemTurn(deps: EngineDeps, sessionId: string, text: string): Turn {
  const turn = deps.store.turns.create({ sessionId, role: "system", status: "done" });
  emitBlock(deps, textBlock(sessionId, turn.id, 0, text));
  deps.broadcast("chat.turnStatus", { sessionId, turnId: turn.id, status: "done" });
  return turn;
}

export function errorBlock(
  deps: EngineDeps,
  sessionId: string,
  turnId: string,
  message: string,
): Block {
  const ts = Date.now();
  return emitBlock(deps, {
    id: newId("block"),
    turnId,
    sessionId,
    kind: "error",
    index: deps.store.blocks.nextIndex(turnId),
    message,
    createdAt: ts,
    updatedAt: ts,
  });
}

/**
 * Move a turn (and with it the session) to its final state and tell every
 * renderer. `error` marks the session errored; anything else leaves it idle so
 * the composer unlocks.
 *
 * The session only follows the turn once nothing else in it is still
 * streaming: a second agent turn ending — or being refused — must not declare
 * the session idle or errored while a healthy turn is still producing blocks.
 */
export function finishTurn(
  deps: EngineDeps,
  sessionId: string,
  turnId: string,
  status: TurnStatus,
  error?: string,
): void {
  deps.store.turns.setStatus(turnId, status);
  if (!deps.store.turns.hasStreaming(sessionId)) {
    deps.store.sessions.setStatus(sessionId, status === "error" ? "error" : "idle");
  }
  deps.broadcast("chat.turnStatus", {
    sessionId,
    turnId,
    status,
    ...(error ? { error } : {}),
  });
  const session = deps.store.sessions.get(sessionId);
  if (session) deps.broadcast("session.updated", session);
}
