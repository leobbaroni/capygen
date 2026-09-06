/**
 * The two writes every engine performs: persist a block, and close a turn.
 *
 * Both live here so the echo double and the real session runner cannot drift on
 * the thing the renderer depends on — a block row and its `chat.block` event are
 * written in the same call, always upserted by id (SPEC R23: persist
 * incrementally, never rebuild a turn).
 */
import { newId, type Block, type TurnStatus } from "@capygen/shared";
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
