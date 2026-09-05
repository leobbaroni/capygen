/**
 * Every IPC handler, with no Electron import — the shell injects the two things
 * that need it (the folder picker and the app metadata) and the broadcast
 * function. That keeps this file unit-testable against a temp SQLite store,
 * which is where the interesting logic (turn/block lifecycle) lives.
 *
 * Handlers receive input already parsed by the contract (`parseInvokeArgs` in
 * main.ts) and return the domain shape; main validates the result on the way
 * back so a handler bug is caught at the boundary.
 */
import type { CapygenStore } from "@capygen/db";
import {
  BUILTIN_SLASH_COMMANDS,
  type Block,
  type InvokeArgs,
  type InvokeChannel,
  type InvokeResult,
  type Project,
  type SlashCommand,
} from "@capygen/shared";
import { createSessionRunner } from "../engine/SessionRunner.js";
import { emitBlock as persistBlock, textBlock } from "../engine/persist.js";
import type {
  Broadcast,
  Engine,
  EngineDeps,
  EngineFactory,
  EngineLogger,
} from "../engine/types.js";

export type { Broadcast };

export interface IpcContextDeps {
  store: CapygenStore;
  broadcast: Broadcast;
  log: EngineLogger;
  /** Native folder picker; resolves to null when the user cancels. */
  pickDirectory: () => Promise<string | null>;
  appInfo: () => InvokeResult<"app.version">;
  /**
   * Overridable for tests, which run against the echo double; the app runs the
   * real session runner (one Claude harness per agent).
   */
  makeEngine?: EngineFactory;
}

export type IpcHandlers = {
  [C in InvokeChannel]: (args: InvokeArgs<C>) => Promise<InvokeResult<C>> | InvokeResult<C>;
};

export interface IpcContext {
  handlers: IpcHandlers;
  engine: Engine;
  dispose(): void;
}

export function createIpcContext(deps: IpcContextDeps): IpcContext {
  const { store, broadcast, log } = deps;
  const engineDeps: EngineDeps = { store, broadcast, log };

  /** Persist a block and push it to every renderer (upsert by id). */
  function emitBlock(block: Block): Block {
    return persistBlock(engineDeps, block);
  }

  function emitSession(sessionId: string): void {
    const session = store.sessions.get(sessionId);
    if (session) broadcast("session.updated", session);
  }

  const engine = (deps.makeEngine ?? createSessionRunner)(engineDeps);

  const handlers: IpcHandlers = {
    "projects.pick": async (): Promise<Project | null> => {
      const dir = await deps.pickDirectory();
      if (!dir) return null;
      const project = store.projects.upsertByPath({ path: dir });
      log.info(`[ipc] project picked ${project.path}`);
      return project;
    },

    "projects.list": () => store.projects.list(),

    "sessions.create": (args) => {
      const project = store.projects.get(args.projectId);
      if (!project) throw new Error(`unknown project: ${args.projectId}`);
      const agents =
        args.agents.length > 0
          ? args.agents
          : [
              {
                name: "capy",
                backend: "claude" as const,
                model: store.settings.all().defaultModel,
                role: "lead",
                config: null,
              },
            ];
      const created = store.sessions.create({
        projectId: args.projectId,
        mode: args.mode,
        title: args.title,
        agents,
      });
      store.projects.touch(args.projectId);
      broadcast("session.updated", created.session);
      log.info(`[ipc] session created ${created.session.id} (${args.mode})`);
      return created;
    },

    "sessions.list": (args) =>
      store.sessions.list({
        ...(args.projectId ? { projectId: args.projectId } : {}),
        includeArchived: args.includeArchived,
      }),

    "sessions.get": (args) => {
      const session = store.sessions.get(args.sessionId);
      if (!session) return null;
      return {
        session,
        agents: store.sessions.agents(session.id),
        turns: store.turns.list(session.id),
        blocks: store.blocks.listBySession(session.id),
      };
    },

    "sessions.archive": (args) => {
      const session = store.sessions.setArchived(args.sessionId, args.archived);
      if (!session) throw new Error(`unknown session: ${args.sessionId}`);
      broadcast("session.updated", session);
      return session;
    },

    "turns.list": (args) => ({
      turns: store.turns.list(args.sessionId),
      blocks: store.blocks.listBySession(args.sessionId),
    }),

    "chat.send": (args) => {
      const session = store.sessions.get(args.sessionId);
      if (!session) throw new Error(`unknown session: ${args.sessionId}`);

      // The user's turn is complete the moment it is stored.
      const userTurn = store.turns.create({
        sessionId: session.id,
        role: "user",
        status: "done",
      });
      emitBlock(textBlock(session.id, userTurn.id, 0, args.text));
      broadcast("chat.turnStatus", {
        sessionId: session.id,
        turnId: userTurn.id,
        status: "done",
      });

      // The agent's turn opens as streaming and the engine fills it in.
      const agentId = args.agentId ?? session.leadAgentId;
      const agentTurn = store.turns.create({
        sessionId: session.id,
        agentId,
        role: "agent",
        status: "streaming",
        parentTurnId: userTurn.id,
        hopIndex: userTurn.hopIndex + 1,
      });
      store.sessions.setStatus(session.id, "running");
      broadcast("chat.turnStatus", {
        sessionId: session.id,
        turnId: agentTurn.id,
        status: "streaming",
      });
      emitSession(session.id);

      engine.send({
        sessionId: session.id,
        turnId: agentTurn.id,
        agentId,
        text: args.text,
      });

      return { userTurnId: userTurn.id, agentTurnId: agentTurn.id };
    },

    "chat.interrupt": async (args) => {
      const stopped = await engine.interrupt(args.sessionId);
      if (stopped) {
        const turns = store.turns.list(args.sessionId);
        const live = [...turns].reverse().find((t) => t.status === "streaming");
        if (live) {
          store.turns.setStatus(live.id, "interrupted");
          broadcast("chat.turnStatus", {
            sessionId: args.sessionId,
            turnId: live.id,
            status: "interrupted",
          });
        }
        store.sessions.setStatus(args.sessionId, "idle");
        emitSession(args.sessionId);
      }
      return { ok: stopped };
    },

    /**
     * Built-ins first, then whatever the session's backend reported in its own
     * listing — for Claude that is `system/init.slash_commands`, which already
     * contains the user's skills and every plugin command (R14). A backend name
     * that collides with a built-in is dropped rather than duplicated.
     */
    "chat.listCommands": (args): SlashCommand[] => {
      const commands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((c) => ({
        name: c.name,
        description: c.description,
        source: "builtin" as const,
      }));
      const seen = new Set(commands.map((c) => c.name));
      for (const command of args.sessionId ? engine.listCommands(args.sessionId) : []) {
        if (seen.has(command.name)) continue;
        seen.add(command.name);
        commands.push(command);
      }
      return commands;
    },

    /**
     * Unblocks the backend first — the agent is what is actually waiting — then
     * records the decision on the block so a relaunch can still show it.
     */
    "permission.answer": (args) => {
      const delivered = engine.answerPermission(args.requestId, {
        behavior: args.behavior,
        ...(args.updatedInput !== undefined ? { updatedInput: args.updatedInput } : {}),
        ...(args.message !== undefined ? { message: args.message } : {}),
      });
      const block = findBlockByRequestId(store, args.requestId, "permission");
      if (!block || block.kind !== "permission") return { ok: delivered };
      emitBlock({
        ...block,
        decision: {
          behavior: args.behavior,
          ...(args.updatedInput !== undefined ? { updatedInput: args.updatedInput } : {}),
          ...(args.message !== undefined ? { message: args.message } : {}),
          scope: args.scope,
          decidedAt: Date.now(),
        },
        updatedAt: Date.now(),
      });
      return { ok: true };
    },

    "question.answer": (args) => {
      const delivered = engine.answerQuestion(args.requestId, args.answers);
      const block = findBlockByRequestId(store, args.requestId, "question");
      if (!block || block.kind !== "question") return { ok: delivered };
      emitBlock({ ...block, answers: args.answers, updatedAt: Date.now() });
      return { ok: true };
    },

    "settings.get": () => store.settings.all(),

    "settings.set": (args) => {
      const next = store.settings.patch(args);
      log.info("[ipc] settings updated", Object.keys(args).join(","));
      return next;
    },

    "app.version": () => deps.appInfo(),
  };

  return {
    handlers,
    engine,
    dispose: () => engine.dispose(),
  };
}

/**
 * Find a permission/question block by the request id the harness minted. The
 * harness holds the live promise; this lookup only exists so the decision is
 * also written to the row the renderer re-reads after a relaunch.
 */
function findBlockByRequestId(
  store: CapygenStore,
  requestId: string,
  kind: "permission" | "question",
): Block | null {
  const rows = store.db.all<{ id: string }>(
    "SELECT id FROM blocks WHERE kind = ? ORDER BY updated_at DESC LIMIT 500",
    kind,
  );
  for (const row of rows) {
    const block = store.blocks.get(row.id);
    if (!block) continue;
    if (block.kind === "permission" && block.request.requestId === requestId) return block;
    if (block.kind === "question" && block.requestId === requestId) return block;
  }
  return null;
}
