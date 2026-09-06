/**
 * The echo double.
 *
 * It answers `echo: <text>` after 300 ms, exercising the whole path a real
 * harness uses — block row, `chat.block`, turn status, session status — without
 * a model, a process or a network call. The handler tests run against it; the
 * app runs `createSessionRunner` instead (see `ipc/handlers.ts`).
 */
import { emitBlock, finishTurn, openAgentTurn, recordUserTurn, textBlock } from "./persist.js";
import type { Engine, EngineDeps } from "./types.js";

export const ECHO_DELAY_MS = 300;

export function createStubEngine(deps: EngineDeps, delayMs = ECHO_DELAY_MS): Engine {
  const inFlight = new Map<string, { timer: ReturnType<typeof setTimeout>; turnId: string }>();

  const engine: Engine = {
    send({ sessionId, turnId, text }) {
      // One turn at a time per session: a second send supersedes the first.
      const existing = inFlight.get(sessionId);
      if (existing) clearTimeout(existing.timer);

      const timer = setTimeout(() => {
        inFlight.delete(sessionId);
        try {
          emitBlock(
            deps,
            textBlock(
              sessionId,
              turnId,
              deps.store.blocks.nextIndex(turnId),
              `echo: ${text}`,
            ),
          );
          finishTurn(deps, sessionId, turnId, "done");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          finishTurn(deps, sessionId, turnId, "error", message);
        }
      }, delayMs);
      timer.unref?.();
      inFlight.set(sessionId, { timer, turnId });
    },

    /**
     * [B1] The echo double's round table: the lead (or the named agent), one
     * hop, no mention chaining. It reproduces exactly what the real dispatcher
     * writes for the single-target case — user turn, one agent turn opened
     * `streaming` — so the handler tests still exercise the real row and
     * broadcast sequence without a backend.
     */
    dispatch({ sessionId, text, agentId }) {
      const session = deps.store.sessions.get(sessionId);
      if (!session) throw new Error(`unknown session: ${sessionId}`);
      const userTurn = recordUserTurn(deps, sessionId, text);
      const target = agentId ?? session.leadAgentId;
      const agentTurn = openAgentTurn(deps, {
        sessionId,
        agentId: target,
        parentTurnId: userTurn.id,
        hopIndex: userTurn.hopIndex + 1,
        triggeredByTurnId: userTurn.id,
      });
      engine.send({ sessionId, turnId: agentTurn.id, agentId: target, text });
      return {
        userTurnId: userTurn.id,
        agentTurnId: agentTurn.id,
        agentTurnIds: [agentTurn.id],
      };
    },

    continueChain(sessionId) {
      const session = deps.store.sessions.get(sessionId);
      if (!session) throw new Error(`unknown session: ${sessionId}`);
      if (deps.store.turns.hasStreaming(sessionId)) return { ok: false, agentTurnId: null };
      const turns = deps.store.turns.list(sessionId);
      const last = turns[turns.length - 1];
      const agentId = last?.agentId ?? session.leadAgentId;
      if (!last || !agentId) return { ok: false, agentTurnId: null };
      const agentTurn = openAgentTurn(deps, {
        sessionId,
        agentId,
        parentTurnId: last.id,
        hopIndex: last.hopIndex + 1,
        triggeredByTurnId: last.triggeredByTurnId ?? last.id,
      });
      engine.send({ sessionId, turnId: agentTurn.id, agentId, text: "Continue." });
      return { ok: true, agentTurnId: agentTurn.id };
    },

    interrupt(sessionId) {
      const existing = inFlight.get(sessionId);
      if (!existing) return false;
      clearTimeout(existing.timer);
      inFlight.delete(sessionId);
      return true;
    },

    answerPermission: () => false,
    answerQuestion: () => false,
    answerElicitation: () => false,
    listCommands: () => [],

    dispose() {
      for (const { timer } of inFlight.values()) clearTimeout(timer);
      inFlight.clear();
    },
  };

  return engine;
}
