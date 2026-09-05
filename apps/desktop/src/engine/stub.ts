/**
 * The echo double.
 *
 * It answers `echo: <text>` after 300 ms, exercising the whole path a real
 * harness uses — block row, `chat.block`, turn status, session status — without
 * a model, a process or a network call. The handler tests run against it; the
 * app runs `createSessionRunner` instead (see `ipc/handlers.ts`).
 */
import { emitBlock, finishTurn, textBlock } from "./persist.js";
import type { Engine, EngineDeps } from "./types.js";

export const ECHO_DELAY_MS = 300;

export function createStubEngine(deps: EngineDeps, delayMs = ECHO_DELAY_MS): Engine {
  const inFlight = new Map<string, { timer: ReturnType<typeof setTimeout>; turnId: string }>();

  return {
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

    interrupt(sessionId) {
      const existing = inFlight.get(sessionId);
      if (!existing) return false;
      clearTimeout(existing.timer);
      inFlight.delete(sessionId);
      return true;
    },

    answerPermission: () => false,
    answerQuestion: () => false,
    listCommands: () => [],

    dispose() {
      for (const { timer } of inFlight.values()) clearTimeout(timer);
      inFlight.clear();
    },
  };
}
