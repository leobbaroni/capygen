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
  type ApiProvider,
  type Block,
  type InvokeArgs,
  type InvokeChannel,
  type InvokeResult,
  type Project,
  type SlashCommand,
} from "@capygen/shared";
import { createSessionRunner } from "../engine/SessionRunner.js";
import type { WidgetHostHandlers } from "./widgets.js";
import { emitBlock as persistBlock, textBlock } from "../engine/persist.js";
import type {
  Broadcast,
  Engine,
  EngineDeps,
  EngineFactory,
  EngineLogger,
} from "../engine/types.js";

export type { Broadcast };

/**
 * Where API keys live between `secrets.set`/`.has`/`.delete` calls (R21).
 * Electron-free like the rest of this file — `createInMemorySecretsStore`
 * below is what runs until Phase 6 wires a `safeStorage`-backed one in.
 */
export interface SecretsStore {
  set(provider: ApiProvider, value: string): Promise<void> | void;
  has(provider: ApiProvider): Promise<boolean> | boolean;
  delete(provider: ApiProvider): Promise<void> | void;
}

/**
 * Never persists anything to disk, so it cannot be the thing that leaks a key
 * to a log or a settings file — it also cannot remember a key across a
 * restart, which is exactly why this is a placeholder and not the R21
 * implementation. Phase 6 replaces this with Electron `safeStorage`.
 */
export function createInMemorySecretsStore(): SecretsStore {
  const values = new Map<ApiProvider, string>();
  return {
    set: (provider, value) => void values.set(provider, value),
    has: (provider) => values.has(provider),
    delete: (provider) => void values.delete(provider),
  };
}

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
  /** Defaults to an in-memory store; see `createInMemorySecretsStore`. */
  secrets?: SecretsStore;
  /**
   * Defaults to a static Claude-only list; see the `harness.list` handler.
   * May return a `Promise` — `apps/desktop/src/ipc/harnessList.ts` probes the
   * `claude`/`codex` CLIs, which is inherently async.
   */
  listHarnesses?: () => InvokeResult<"harness.list"> | Promise<InvokeResult<"harness.list">>;
  /**
   * [B3] The MCP Apps widget host (`apps/desktop/src/ipc/widgets.ts`, SPEC
   * R31). Absent in tests and in any profile with no MCP client, in which case
   * the three widget channels refuse loudly instead of pretending.
   */
  widgets?: WidgetHostHandlers;
}

export type IpcHandlers = {
  [C in InvokeChannel]: (args: InvokeArgs<C>) => Promise<InvokeResult<C>> | InvokeResult<C>;
};

export interface IpcContext {
  handlers: IpcHandlers;
  engine: Engine;
  /** Resolves once every backend is down and its last turn status is written. */
  dispose(): void | Promise<void>;
}

export function createIpcContext(deps: IpcContextDeps): IpcContext {
  const { store, broadcast, log } = deps;
  const engineDeps: EngineDeps = {
    store,
    broadcast,
    log,
    ...(deps.widgets ? { widgets: deps.widgets } : {}),
  };
  const secrets = deps.secrets ?? createInMemorySecretsStore();

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

    "blocks.getOutput": (args) => store.toolOutputs.get(args.id),

    "turns.usage": (args) => ({ events: store.usage.listBySession(args.sessionId) }),

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

    /**
     * Stop whatever the engine is running, then make sure no row is left
     * `streaming` either way. The second half is not redundant: a row can
     * outlive the engine that wrote it (a crash, or a quit mid-turn), and
     * while it says `streaming` the renderer keeps the composer locked with a
     * Stop button that would otherwise do nothing at all.
     */
    "chat.interrupt": async (args) => {
      const stopped = await engine.interrupt(args.sessionId);
      const stale = store.turns.list(args.sessionId).filter((t) => t.status === "streaming");
      for (const turn of stale) {
        store.turns.setStatus(turn.id, "interrupted");
        broadcast("chat.turnStatus", {
          sessionId: args.sessionId,
          turnId: turn.id,
          status: "interrupted",
        });
      }
      const flipped = stale.length > 0;
      if (stopped || flipped) {
        store.sessions.setStatus(args.sessionId, "idle");
        emitSession(args.sessionId);
      }
      return { ok: stopped || flipped };
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
        ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
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
     *
     * `decision` is the three-way UI choice (Allow / Always Allow / Deny). The
     * harness only ever needs to unblock a call, so `allow_always` collapses
     * to `behavior: "allow"` for `engine.answerPermission`; the "always" part
     * is recorded as `scope: "always"` on the persisted decision instead
     * (`PermissionDecisionSchema.behavior` in `@capygen/shared` keeps the full
     * three-way value for the card and for a future policy engine to read).
     *
     * `ok` is whether the backend actually took the answer. Nothing is waiting
     * on a request whose turn has ended (or whose engine is from a previous
     * launch), and marking such a card "Allowed" would tell the user their
     * click reached an agent that no longer exists — so the row is left
     * undecided and the renderer says the request is stale.
     */
    "permission.answer": (args) => {
      const behavior: "allow" | "deny" = args.decision === "deny" ? "deny" : "allow";
      const scope = args.decision === "allow_always" ? "always" : args.scope;
      const delivered = engine.answerPermission(args.requestId, {
        behavior,
        ...(args.updatedInput !== undefined ? { updatedInput: args.updatedInput } : {}),
        ...(args.message !== undefined ? { message: args.message } : {}),
      });
      if (!delivered) return { ok: false };
      const block = findBlockByRequestId(store, args.requestId, "permission");
      if (!block || block.kind !== "permission") return { ok: true };
      emitBlock({
        ...block,
        decision: {
          behavior: args.decision,
          ...(args.updatedInput !== undefined ? { updatedInput: args.updatedInput } : {}),
          ...(args.message !== undefined ? { message: args.message } : {}),
          scope,
          decidedAt: Date.now(),
        },
        updatedAt: Date.now(),
      });
      return { ok: true };
    },

    "question.answer": (args) => {
      const delivered = engine.answerQuestion(args.requestId, args.answers);
      if (!delivered) return { ok: false };
      const block = findBlockByRequestId(store, args.requestId, "question");
      if (!block || block.kind !== "question") return { ok: true };
      emitBlock({ ...block, answers: args.answers, updatedAt: Date.now() });
      return { ok: true };
    },

    /**
     * Phase 3 stub: no elicitation source exists yet (no MCP client, no Codex
     * user-input wiring), so there is nothing to route this to. Records the
     * answer on the block — same shape a relaunch needs to render it — and
     * reports `ok: false` (nothing delivered), matching how a stale
     * permission/question answer is reported above.
     */
    "elicitation.answer": (args) => {
      const block = store.blocks.get(args.blockId);
      if (block && block.kind === "elicitation") {
        emitBlock({
          ...block,
          answers: args.answers,
          status: args.answers === null ? "declined" : "accepted",
          updatedAt: Date.now(),
        });
      }
      return { ok: false };
    },

    /**
     * `deps.listHarnesses` (`apps/desktop/src/ipc/harnessList.ts`) probes the
     * `claude`/`codex` CLIs; the fallback below is the honest static list a
     * caller that supplies nothing gets instead (tests, and any future
     * profile that has not wired a lister in).
     */
    "harness.list": async () =>
      (await deps.listHarnesses?.()) ?? [
        {
          backend: "claude" as const,
          label: "Claude Code",
          available: true,
          models: [
            { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
            { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
          ],
          defaultModel: store.settings.all().defaultModel,
        },
        {
          backend: "codex" as const,
          label: "Codex",
          available: false,
          reason: "not wired yet (Phase 3)",
          models: [],
          defaultModel: "",
        },
        {
          backend: "api" as const,
          label: "API model",
          available: true,
          models: [],
          defaultModel: "",
        },
      ],

    /**
     * `deps.secrets` is an in-memory placeholder when nothing is injected: it
     * never touches disk, so it cannot leak a key to a log or a settings file
     * (R21) — but it also forgets every key on restart. Phase 6 wires this to
     * Electron `safeStorage` (this file stays Electron-free on purpose).
     */
    "secrets.set": async (args) => {
      await secrets.set(args.provider, args.value);
      return { ok: true };
    },
    "secrets.has": async (args) => ({ has: await secrets.has(args.provider) }),
    "secrets.delete": async (args) => {
      await secrets.delete(args.provider);
      return { ok: true };
    },

    /**
     * The three widget channels are the MCP Apps host's whole renderer-facing
     * surface (R31). All of the policy — which server a widget may call, which
     * URLs may leave the app — lives in `deps.widgets`, never here and never in
     * the renderer, because the renderer is the side a hostile widget talks to.
     *
     * Refusing loudly when no host is wired beats returning an empty body,
     * which a widget host would render as "this tool has no UI".
     */
    "mcp.readResource": (args) => {
      if (!deps.widgets) throw new Error("mcp.readResource: no MCP client is wired");
      return deps.widgets.readResource(args);
    },

    "widget.callTool": (args) => {
      if (!deps.widgets) throw new Error("widget.callTool: no widget host is wired");
      return deps.widgets.callTool(args);
    },

    "widget.event": (args) => {
      if (!deps.widgets) {
        log.info(`[ipc] widget event ${args.type} for block ${args.blockId} (no host wired)`);
        return { ok: false };
      }
      return deps.widgets.event(args);
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
