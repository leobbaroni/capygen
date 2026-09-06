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
  builtinSlashCommandsFor,
  type ApiProvider,
  type Block,
  type InvokeArgs,
  type InvokeChannel,
  type InvokeResult,
  type Project,
  type SlashCommand,
} from "@capygen/shared";
import { createSessionRunner } from "../engine/SessionRunner.js";
import { API_ENV_KEYS } from "./harnessList.js";
import type { McpPoolRegistry } from "./mcpPools.js";
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
  /**
   * The plaintext key, for the `api` harness only. Deliberately **not** an IPC
   * channel: `secrets.has` is the whole renderer-facing read surface (R21), and
   * this value only ever travels main-process-internal, from here into
   * `ApiHarnessDeps.keys`.
   */
  get(provider: ApiProvider): Promise<string | null> | string | null;
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
    get: (provider) => values.get(provider) ?? null,
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
  /** Shared MCP client pools (R26); see `EngineDeps.pools`. */
  pools?: McpPoolRegistry;
  /** Overridden in tests; `secrets.has` reads the documented API-key env vars. */
  env?: Record<string, string | undefined>;
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
  const secrets = deps.secrets ?? createInMemorySecretsStore();
  const engineDeps: EngineDeps = {
    store,
    broadcast,
    log,
    ...(deps.widgets ? { widgets: deps.widgets } : {}),
    ...(deps.pools ? { pools: deps.pools } : {}),
    // R21: the engine never reads a key from disk. This is the only bridge
    // between the stored ciphertext and an `api` harness, and it hands over a
    // value the renderer can never ask for (`secrets.has` returns a boolean).
    keys: { getKey: (provider) => secrets.get(provider) },
  };

  /** Persist a block and push it to every renderer (upsert by id). */
  function emitBlock(block: Block): Block {
    return persistBlock(engineDeps, block);
  }

  function emitSession(sessionId: string): void {
    const session = store.sessions.get(sessionId);
    if (session) broadcast("session.updated", session);
  }

  /** Broadcast the whole roster after an agents.add/update/remove/setLead —
   *  the agent tree (R13) replaces its list rather than merging one row. */
  function emitAgents(sessionId: string): void {
    broadcast("agents.updated", { sessionId, agents: store.sessions.agents(sessionId) });
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
                role: "lead" as const,
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

    /** ADR-0002: "can be switched later without losing history" — agents and
     *  the transcript are untouched. */
    "sessions.setMode": (args) => {
      const session = store.sessions.setMode(args.sessionId, args.mode);
      broadcast("session.updated", session);
      return session;
    },

    "sessions.updateSettings": (args) => {
      const session = store.sessions.updateSettings(args.sessionId, args.patch);
      broadcast("session.updated", session);
      return session;
    },

    "agents.list": (args) => store.sessions.agents(args.sessionId),

    "agents.add": (args) => {
      const agent = store.sessions.addAgent(args.sessionId, {
        backend: args.backend,
        model: args.model,
        ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
        ...(args.mentionName !== undefined ? { mentionName: args.mentionName } : {}),
        ...(args.role !== undefined ? { role: args.role } : {}),
        ...(args.config !== undefined ? { config: args.config } : {}),
      });
      emitAgents(args.sessionId);
      // A `role: "lead"` add also moves `leadAgentId` (SessionsRepo.addAgent).
      emitSession(args.sessionId);
      return agent;
    },

    "agents.update": (args) => {
      const agent = store.sessions.updateAgent(args.agentId, args.patch);
      emitAgents(agent.sessionId);
      return agent;
    },

    "agents.remove": (args) => {
      const agent = store.sessions.agent(args.agentId);
      if (!agent) return { ok: false };
      const removed = store.sessions.removeAgent(args.agentId);
      if (removed) {
        emitAgents(agent.sessionId);
        emitSession(agent.sessionId); // leadAgentId may have been cleared
      }
      return { ok: removed };
    },

    "agents.setLead": (args) => {
      const session = store.sessions.setLead(args.sessionId, args.agentId);
      emitAgents(args.sessionId);
      broadcast("session.updated", session);
      return session;
    },

    /**
     * A Claude-Code-info-card-style usage description (R13). `capabilities`
     * and `tools` are best-effort here: they name what a *running* harness
     * reports, and this handler has no live harness to ask (that seam is
     * `Engine`, an `apps/desktop`-only concept `@capygen/db` cannot see) — an
     * agent with no turns run yet, or whose harness has not reported its
     * tool list, honestly returns both empty rather than a guess.
     */
    "agents.describe": (args) => {
      const agent = store.sessions.agent(args.agentId);
      if (!agent) throw new Error(`unknown agent: ${args.agentId}`);
      const usage = store.usage.totalsByAgent(agent.id);
      const others = store.sessions
        .agents(agent.sessionId)
        .filter((a) => a.id !== agent.id)
        .map((a) => ({ agentId: a.id, mentionName: a.mentionName, backend: a.backend, model: a.model }));
      return {
        description: agent.description ?? "",
        capabilities: [],
        tools: [],
        model: agent.model,
        backend: agent.backend,
        usage,
        others,
      };
    },

    "turns.list": (args) => ({
      turns: store.turns.list(args.sessionId),
      blocks: store.blocks.listBySession(args.sessionId),
    }),

    "blocks.getOutput": (args) => store.toolOutputs.get(args.id),

    "turns.usage": (args) => ({ events: store.usage.listBySession(args.sessionId) }),

    /**
     * [B1] Round-table dispatch (ADR-0002, SPEC R11). Both turn rows are the
     * engine's to write now, not this handler's: how many agent turns one
     * message opens depends on its @-mentions, and *when* the next one opens
     * depends on when the last finished — neither of which a request/response
     * handler can see. `agentTurnId` stays the first of them, which is what
     * the contract promises and what the composer scrolls to.
     */
    "chat.send": (args) => {
      const dispatched = engine.dispatch({
        sessionId: args.sessionId,
        text: args.text,
        agentId: args.agentId,
      });
      return {
        userTurnId: dispatched.userTurnId,
        agentTurnId: dispatched.agentTurnId,
      };
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
     * The built-ins **this backend can actually run**, then whatever the
     * session's backend reported in its own listing — for Claude that is
     * `system/init.slash_commands`, which already contains the user's skills
     * and every plugin command (R14). A backend name that collides with a
     * built-in is dropped rather than duplicated.
     *
     * The filter is not cosmetic. The whole seven-command list used to be
     * offered to every session, and an argument-less command fires straight
     * from the menu — so picking `/cost` in a Codex or `api` session posted the
     * literal text "/cost" to the model and spent a real turn on it. The table
     * lives in `@capygen/shared` (`BACKEND_BUILTIN_SLASH_COMMANDS`) next to the
     * list itself, so a new built-in has to answer for all three backends.
     */
    "chat.listCommands": (args): SlashCommand[] => {
      const backend = args.sessionId ? backendOf(store, args.sessionId, args.agentId) : null;
      const commands: SlashCommand[] = builtinSlashCommandsFor(backend).map((c) => ({
        name: c.name,
        description: c.description,
        source: "builtin" as const,
        ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      }));
      const seen = new Set(commands.map((c) => c.name));
      const backendCommands = args.sessionId
        ? engine.listCommands(args.sessionId, args.agentId ?? null)
        : [];
      for (const command of backendCommands) {
        if (seen.has(command.name)) continue;
        seen.add(command.name);
        commands.push(command);
      }
      return commands;
    },

    /**
     * [B1] Resume a chain the hop cap stopped (ADR-0002, SPEC R11: "until the
     * user speaks or presses Continue"). One press buys exactly one more hop —
     * the dispatcher remembered which agents the refused hop was for, and the
     * cap applies again to whatever *that* hop mentions. `agentTurnId` is
     * `null` when there is nothing to continue: a turn is already streaming, or
     * the session has no agent turn to resume from.
     */
    "chat.continue": (args) => engine.continueChain(args.sessionId),

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

    /**
     * An **empty** answer map is the card's Decline button, not a submission:
     * the row is recorded as `cancelled` with `answers: null` so nothing ever
     * renders a green "Submitted" with nothing in it (R32), and the harness
     * denies the tool rather than handing the model a blank answer.
     */
    "question.answer": (args) => {
      const declined = Object.keys(args.answers).length === 0;
      const delivered = engine.answerQuestion(args.requestId, args.answers);
      if (!delivered) return { ok: false };
      const block = findBlockByRequestId(store, args.requestId, "question");
      if (!block || block.kind !== "question") return { ok: true };
      emitBlock({
        ...block,
        answers: declined ? null : args.answers,
        status: declined ? "cancelled" : "answered",
        updatedAt: Date.now(),
      });
      return { ok: true };
    },

    /**
     * The block, not a request id, is what the card knows — an elicitation is
     * addressed by the row the user is looking at — so the `requestId` the
     * backend is blocked on is read back off that row and handed to the
     * harness (R32). `ok: false` means nothing was waiting any more; the row is
     * still updated so a relaunch renders the choice the user made rather than
     * an eternally pending form.
     */
    "elicitation.answer": (args) => {
      const block = store.blocks.get(args.blockId);
      if (!block || block.kind !== "elicitation") return { ok: false };
      const delivered = engine.answerElicitation(block.requestId, args.answers);
      emitBlock({
        ...block,
        answers: args.answers,
        status: args.answers === null ? "declined" : "accepted",
        updatedAt: Date.now(),
      });
      return { ok: delivered };
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
          reason: "no harness lister was wired, so the codex CLI was never probed",
          models: [],
          defaultModel: "",
        },
        {
          backend: "api" as const,
          label: "API model",
          available: false,
          reason: "no harness lister was wired, so no stored API key was checked",
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
    /**
     * `source` matters to the page: `harness.list` counts the documented env
     * var as a key too, so reporting a bare `has: false` for an env-supplied
     * key made Settings ▸ API keys say "Not set" while the composer happily
     * offered that provider's models.
     */
    "secrets.has": async (args) => {
      if (await secrets.has(args.provider)) return { has: true, source: "stored" as const };
      const env = deps.env ?? process.env;
      if (env[API_ENV_KEYS[args.provider]]) return { has: true, source: "environment" as const };
      return { has: false, source: "none" as const };
    },
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
 * The backend of the agent a message would reach — the one named, else the
 * session's lead. Read from the row rather than from a live harness on
 * purpose: the slash menu is fetched when a session opens, which is before any
 * harness exists.
 */
function backendOf(
  store: CapygenStore,
  sessionId: string,
  agentId?: string | null,
): string | null {
  const session = store.sessions.get(sessionId);
  if (!session) return null;
  const wanted = agentId ?? session.leadAgentId;
  if (!wanted) return null;
  return store.sessions.agent(wanted)?.backend ?? null;
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
