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
import { effectiveBackendConfig, type ModelCatalogue } from "@capygen/engine";
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
import { catalogueFrom, checkModelSelection, type ModelSelectionDeps } from "./modelSelection.js";
import { createPrereqsIpc, type PrereqsIpcDeps } from "./prereqs.js";
import { createWorkspaceIpc, type WorkspaceIpcDeps } from "./workspace.js";
// [B1/Phase 6] The settings hub, the config-sync engine and diagnostics.
import { createSettingsHubHandlers } from "./settings.js";
import { createIntegrationsHandlers } from "./integrations.js";
import { createDiagnosticsHandlers } from "./diagnostics.js";
import { SettingsService, type SettingsPlatform } from "../integrations/SettingsService.js";
import {
  IntegrationsService,
  type IntegrationsDeps,
} from "../integrations/IntegrationsService.js";
import {
  DiagnosticsService,
  type DiagnosticsAppInfo,
  type DiagnosticsDeps,
} from "../integrations/DiagnosticsService.js";
import type { McpPoolRegistry } from "./mcpPools.js";
import type { WidgetHostHandlers } from "./widgets.js";
import type { BrowserViewHandlers } from "../workspace/BrowserViewService.js";
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
   * [7-P1] The last **already resolved** `harness.list` answer, or `[]`. Read
   * synchronously wherever a model has to be resolved or validated
   * (`sessions.create`, `agents.*`, `SessionRunner`), so none of those spawns a
   * probe. `main.ts` fills it in from the same cached lister; a build with no
   * lister simply has no catalogue.
   */
  catalogue?: () => InvokeResult<"harness.list">;
  /**
   * [B3] The MCP Apps widget host (`apps/desktop/src/ipc/widgets.ts`, SPEC
   * R31). Absent in tests and in any profile with no MCP client, in which case
   * the three widget channels refuse loudly instead of pretending.
   */
  widgets?: WidgetHostHandlers;
  /** Shared MCP client pools (R26); see `EngineDeps.pools`. */
  pools?: McpPoolRegistry;
  /**
   * [B1] The Browser pane's `WebContentsView` host (SPEC R16). Built in
   * `main.ts` because it is the only workspace service that needs Electron;
   * absent in tests, where the five `browser.*` channels refuse loudly.
   */
  browser?: BrowserViewHandlers;
  /** [B1] Test seams for the workspace services (fake pty, fake spawn, fake
   *  git client, fake watcher). Never set by the app. */
  workspace?: Omit<WorkspaceIpcDeps, "store" | "broadcast" | "log" | "browser">;
  /** Overridden in tests; `secrets.has` reads the documented API-key env vars. */
  env?: Record<string, string | undefined>;
  /**
   * [B3] The setup panel (SPEC R3): `../prereqs/**` + `./prereqs.ts`. Unlike
   * `browser`/`widgets` above, nothing here is Electron-required by the app —
   * `createPrereqsIpc`'s own defaults are real (a live CLI probe, a real
   * confirm dialog, a real visible console), so this is only ever set in
   * tests, to replace the confirm dialog / console spawn / CLI probes with
   * fakes.
   */
  prereqs?: PrereqsIpcDeps;
  /**
   * [B1/Phase 6] The OS-facing half of the Settings hub (SPEC R19, R30):
   * `nativeTheme`, `app.setLoginItemSettings`, the tray. Absent in tests, in
   * which case a settings write still stores and broadcasts — it just changes
   * nothing outside the app.
   */
  settingsPlatform?: SettingsPlatform;
  /**
   * [B1/Phase 6] Test seams for the config-sync engine (SPEC R28-R30): a temp
   * `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, a fake `claude` runner, a fake watcher.
   * The app sets only `openPath` and `probeMcpServer`, both from `main.ts`.
   */
  integrations?: Omit<IntegrationsDeps, "store" | "broadcast" | "log">;
  /**
   * [B1/Phase 6] Diagnostics' two injected pieces: the clipboard and the file
   * size probe. `appInfo` and `listHarnesses` are taken from the context's own
   * deps, so the page can never disagree with `app.version` / `harness.list`.
   */
  diagnostics?: Omit<DiagnosticsDeps, "log" | "appInfo" | "listHarnesses">;
}

export type IpcHandlers = {
  [C in InvokeChannel]: (args: InvokeArgs<C>) => Promise<InvokeResult<C>> | InvokeResult<C>;
};

export interface IpcContext {
  handlers: IpcHandlers;
  engine: Engine;
  /**
   * [B1/Phase 6] The config-sync engine, reachable directly so `main.ts` can
   * start its watchers after the window exists (SPEC R29) and so the tests can
   * drive a refresh without going through IPC.
   */
  integrations: IntegrationsService;
  /** [B1/Phase 6] The settings hub; `main.ts` calls `applyOnStart()`. */
  settings: SettingsService;
  /** Resolves once every backend is down and its last turn status is written. */
  dispose(): void | Promise<void>;
}

export function createIpcContext(deps: IpcContextDeps): IpcContext {
  const { store, broadcast, log } = deps;
  const secrets = deps.secrets ?? createInMemorySecretsStore();

  // [B3] The setup panel (SPEC R3): `prereqs.status` / `prereqs.run`. See
  // `IpcContextDeps.prereqs`'s own comment for why this needs no `main.ts`
  // wiring the way `browser`/`widgets` do. `broadcastChanged` is the one
  // piece that *is* wired here rather than defaulted inside `prereqs.ts`: it
  // is `broadcast` itself, already in scope, not an Electron object, so
  // there is nothing for a default to reach for — Settings ▸ Prerequisites
  // (`PrereqsSection`, Task B2) subscribes to `prereqs.changed` for its own
  // live update after a Run, and this is what makes that event real.
  const prereqs = createPrereqsIpc({
    broadcastChanged: (steps) => broadcast("prereqs.changed", { steps }),
    // [C] The gate's refusals ("unknown step", "`codex-cli` is not detected
    // yet") and its "launched in a visible console" line are the only record
    // that R27 held for a given run. They were being written to a logger that
    // was never supplied, so a refusal left no trace at all in the app.
    log: { info: (msg) => log.info(msg), warn: (msg) => log.warn(msg) },
    ...deps.prereqs,
  });

  // [B1/Phase 6] The Settings hub (R19, R30) and the config-sync engine
  // (R28-R29). Both are Electron-free: the OS-facing switches (theme, run at
  // login) and the two Electron objects diagnostics needs (clipboard, file
  // size) arrive as injected functions from `main.ts`.
  /**
   * [7-P1] Each backend's own catalogue default, from the same probe the
   * picker uses, without ever forcing one: `deps.catalogue` reads the harness
   * lister's **last resolved** answer. `sessions.create` must not spawn a
   * `codex app-server` to validate a model, and a profile that has not probed
   * yet simply has no catalogue opinion — which resolves to "pick a model"
   * rather than to a guess.
   */
  const catalogue: ModelCatalogue = (backend) =>
    catalogueFrom(() => deps.catalogue?.() ?? [], {
      // Read the canonical row directly: SettingsService.all() derives its
      // alias through this callback and would recurse. Provider changes must
      // affect the alias even while the last harness catalogue is cached.
      settings: store.globalSettings.all(),
    })(backend);

  /** [7-P1] "Can this agent actually run?", before anything is written. */
  const modelSelection: ModelSelectionDeps = {
    settings: () => settingsService.all(),
    harnesses: () => deps.catalogue?.() ?? [],
  };
  function requireRunnable(selection: {
    backend: import("@capygen/shared").Backend;
    model?: string | null;
    name?: string;
    /** The agent's own config, if any; the effective section is derived here so
     *  every caller validates against the provider the agent will run on. */
    config?: import("@capygen/shared").AgentConfig | null;
  }): void {
    const { config: agentConfig, ...rest } = selection;
    const check = checkModelSelection(modelSelection, {
      ...rest,
      config: effectiveBackendConfig(settingsService.all(), agentConfig, selection.backend),
    });
    if (!check.ok) throw new Error(check.reason ?? "no model could be resolved");
  }

  // The flat compatibility view derives `defaultModel` too, and shipping code
  // reads it straight off the repo — so it is given the same catalogue the
  // service uses, or the two would disagree by one step.
  store.setModelCatalogue(catalogue);

  const settingsService = new SettingsService({
    store,
    broadcast,
    log,
    catalogue,
    ...(deps.settingsPlatform ? { platform: deps.settingsPlatform } : {}),
  });
  const integrations = new IntegrationsService({
    store,
    broadcast,
    log,
    ...(deps.integrations ?? {}),
  });
  const diagnostics = new DiagnosticsService({
    log,
    appInfo: () => deps.appInfo() as DiagnosticsAppInfo,
    // The very same probe the picker uses, so Diagnostics can never claim a
    // backend is available that the composer says is not.
    listHarnesses: () => deps.listHarnesses?.() ?? [],
    ...(deps.diagnostics ?? {}),
  });

  // [B1] Files, git, terminals, dev servers, tasks and the Browser pane's
  // native view (SPEC R16-R18). One module, five registration lines below.
  const workspace = createWorkspaceIpc({
    store,
    broadcast,
    log,
    ...(deps.browser ? { browser: deps.browser } : {}),
    ...(deps.workspace ?? {}),
  });

  /**
   * [B1] Every engine broadcast passes through here on its way out so the
   * Tasks pane can derive a plan from the blocks an agent already wrote
   * (`TasksService`) — a `TodoWrite` becomes task rows without asking a model
   * anything (R26). The tap only reads; the payload is forwarded untouched,
   * and a derivation that throws is swallowed inside `observeBlock` rather
   * than being allowed to break the event the renderer was waiting for.
   */
  const tappedBroadcast: Broadcast = (event, payload) => {
    if (event === "chat.block") workspace.observeBlock(payload as Block);
    broadcast(event, payload);
  };

  const engineDeps: EngineDeps = {
    store,
    broadcast: tappedBroadcast,
    log,
    ...(deps.widgets ? { widgets: deps.widgets } : {}),
    ...(deps.pools ? { pools: deps.pools } : {}),
    // R21: the engine never reads a key from disk. This is the only bridge
    // between the stored ciphertext and an `api` harness, and it hands over a
    // value the renderer can never ask for (`secrets.has` returns a boolean).
    keys: { getKey: (provider) => secrets.get(provider) },
  };

  /**
   * [7-P1] The runner resolves and validates a model the same way the IPC
   * boundary does. Passed as functions rather than values so a settings change
   * reaches the **next** harness build without restarting anything.
   */
  const runnerConfig = {
    settings: () => settingsService.all(),
    catalogue,
    validateModel: (selection: {
      backend: import("@capygen/shared").Backend;
      model?: string | null;
      name?: string;
      config?: Record<string, unknown> | null;
    }) => checkModelSelection(modelSelection, selection),
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

  // Handed to whichever engine is wired, including a test's own — a runner
  // built by `makeEngine` that spreads its deps gets the same resolution and
  // validation the shipping one does, rather than silently falling back to the
  // bare chain.
  const engine = (deps.makeEngine ?? createSessionRunner)({ ...engineDeps, ...runnerConfig });

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
      // [7-P1] The implicit agent follows Settings ▸ General's **selected**
      // backend, and takes that backend's own model. It used to be hardcoded to
      // `claude` with the app-wide `defaultModel`, so a profile whose default
      // backend was Codex created a Claude agent — and handed it whatever id
      // the general alias held.
      const global = settingsService.all();
      const agents =
        args.agents.length > 0
          ? args.agents
          : [
              {
                name: "capy",
                backend: global.general.defaultBackend,
                model: global.general.defaultModel,
                role: "lead" as const,
                config: null,
              },
            ];
      // Before the mutation: a session whose lead cannot resolve a model is a
      // session that fails on its first turn, with nothing to show for it.
      for (const draft of agents) {
        requireRunnable({
          backend: draft.backend,
          model: draft.model,
          name: draft.name,
          config: draft.config ?? null,
        });
      }
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
        // Durable answer to "is the Continue button real?" — the renderer
        // cannot keep that from a `chat.chainStopped` event it may not have
        // been listening for (ADR-0002, SPEC R11).
        chainPending: engine.hasPendingChain(session.id),
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
      requireRunnable({
        backend: args.backend,
        model: args.model,
        ...(args.displayName ? { name: args.displayName } : {}),
        config: args.config ?? null,
      });
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

    /**
     * [7-P1] A model/config edit is validated before it lands, and then
     * **evicts that agent's harness** so the next turn is built from the new
     * opinion (the harness captures its effective config once, at
     * construction). An agent that is mid-turn is marked restart-pending
     * instead and evicted when that turn ends — including when it ends in an
     * error or a cancel — because changing a running turn's options underneath
     * it is exactly what the contract forbids.
     */
    "agents.update": (args) => {
      const before = store.sessions.agent(args.agentId);
      if (before && (args.patch.model !== undefined || args.patch.config !== undefined)) {
        requireRunnable({
          backend: before.backend,
          model: args.patch.model ?? before.model,
          name: before.displayName,
          // The config this update lands on, not the one it replaces.
          config: args.patch.config !== undefined ? args.patch.config : before.config,
        });
      }
      const agent = store.sessions.updateAgent(args.agentId, args.patch);
      if (args.patch.model !== undefined || args.patch.config !== undefined) {
        engine.agentConfigChanged?.(agent.id);
      }
      emitAgents(agent.sessionId);
      return agent;
    },

    /** [7-P1] Minimal non-secret runtime facts; null for an unknown agent or
     *  an engine that does not track them (the echo double). */
    "agents.runtime": (args) => engine.agentRuntime?.(args.agentId) ?? null,

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
     * A Claude-Code-info-card-style usage description (R13).
     *
     * [C] Answered by the engine, not here: `capabilities` and `tools` are
     * facts of the agent's *running* harness (Claude's `system/init`, Codex's
     * `mcpServerStatus/list`, the API loop's built tool list), and the harness
     * registry is `SessionRunner`'s. `describeAgent` composes those with the
     * two things only the database knows — usage totals and the other agents —
     * and falls back to config-only info for an agent that has not spoken yet
     * rather than guessing at a tool list.
     */
    "agents.describe": (args) => engine.describeAgent(args.agentId),

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
        unknownMentions: dispatched.unknownMentions,
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
          providers: [],
        },
        {
          backend: "codex" as const,
          label: "Codex",
          available: false,
          reason: "no harness lister was wired, so the codex CLI was never probed",
          models: [],
          defaultModel: "",
          providers: [],
        },
        {
          backend: "api" as const,
          label: "API model",
          available: false,
          reason: "no harness lister was wired, so no stored API key was checked",
          models: [],
          defaultModel: "",
          providers: [],
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

    /**
     * [7-P1] Both settings surfaces go through `SettingsService`. `settings.get`
     * is a **derived view** of the canonical object plus the three flat-only
     * preferences; `settings.set` translates the overlapping half onto the
     * canonical row and applies the same platform effects and
     * `settings.changed` broadcast the hub does. Writing the flat row directly
     * here is what let a second authority exist: it bypassed both, and the next
     * `settings.patch` silently reverted it.
     */
    "settings.get": () => settingsService.flat(),

    "settings.set": (args) => {
      const next = settingsService.setFlat(args);
      log.info("[ipc] settings updated", Object.keys(args).join(","));
      return next;
    },

    // -------------------------------------------------------------------
    // Settings hub, integrations, diagnostics (Phase 6, SPEC R19-R21,
    // R28-R30). Three modules, three registration lines — the same shape
    // `workspace.handlers` uses below, and for the same reason: this file
    // stays a map from channel to behaviour, and the services that own the
    // config stores, the watchers and the SQLite cache live next door in
    // `../integrations/**`.
    //
    // `prereqs.status` / `.run` are wired separately above (`./prereqs.ts`,
    // SPEC R3) because they own the confirm dialog and the visible console.
    // -------------------------------------------------------------------
    ...createSettingsHubHandlers(settingsService),
    ...createIntegrationsHandlers(integrations),
    ...prereqs.handlers,
    ...createDiagnosticsHandlers(diagnostics),

    // -------------------------------------------------------------------
    // Workspace panes (SPEC R16-R18) — layout, files, git, terminals, dev
    // servers, tasks and the Browser pane's native `WebContentsView`. All
    // thirty channels live in `./workspace.ts`, which owns the five services
    // behind them (`apps/desktop/src/workspace/**`); this file keeps its
    // no-Electron rule because the only Electron-shaped one, the browser
    // view, is injected by `main.ts` as `deps.browser`.
    // -------------------------------------------------------------------
    ...workspace.handlers,

    "app.version": () => deps.appInfo(),
  };

  return {
    handlers,
    engine,
    integrations,
    settings: settingsService,
    dispose: async () => {
      // The engine first: a harness still writing a turn's final status must
      // not find the workspace services gone underneath it.
      await engine.dispose();
      await workspace.dispose();
      // Last: the config watchers own nothing anybody else is waiting on, but
      // a chokidar instance left running keeps the process alive on quit.
      await integrations.dispose();
    },
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
 * Phase 6's settings-hub/integrations/prerequisites channels (SPEC R3,
 * R19-R21, R28-R30) are contract-complete but not yet wired to a live
 * backend from here — see the block comment above their entries in
 * `handlers`. Typed `never` so it satisfies every one of those channels'
 * differing `InvokeResult` regardless of call site.
 */
function notImplemented(channel: string, args?: unknown): never {
  throw new Error(
    `${channel}: not implemented yet — Phase 6 Build wires this` +
      (args !== undefined ? ` (args: ${JSON.stringify(args)})` : ""),
  );
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
