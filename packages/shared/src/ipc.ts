/**
 * The IPC contract. Two typed maps — `INVOKE_CHANNELS` (renderer → main,
 * request/response) and `EVENT_CHANNELS` (main → renderer, push) — are the only
 * way the two processes talk. Everything is a zod schema, so:
 *
 *   - preload validates what it sends and what comes back,
 *   - main validates what it receives from a renderer it must not trust,
 *   - the renderer gets full inference from the same declarations.
 *
 * Adding a channel means adding one line here; `defineIpc` and the main-process
 * registry both derive their types from these objects, so a missing handler is a
 * compile error rather than a runtime "no handler registered".
 */
import { z } from "zod";
import {
  AgentConfigSchema,
  AgentDescribeSchema,
  AgentDraftSchema,
  AgentRuntimeInfoSchema,
  AgentPatchSchema,
  AgentRoleSchema,
  AgentSchema,
  ApiProviderSchema,
  BackendSchema,
  BlockSchema,
  BoundsSchema,
  DevServerDraftSchema,
  DevServerRunSchema,
  DevServerSchema,
  DevServerWithRunSchema,
  DiagnosticsInfoSchema,
  FileChangeSchema,
  FileEntrySchema,
  FileListResultSchema,
  FileReadResultSchema,
  GitDiffSchema,
  GitStatusSchema,
  GlobalSettingsPatchSchema,
  GlobalSettingsSchema,
  GlobalSettingsSectionSchema,
  HarnessInfoSchema,
  McpServerEntryDraftSchema,
  McpServerEntryPatchSchema,
  McpServerEntrySchema,
  McpServerScopeSchema,
  McpServerStatusSchema,
  MentionNameSchema,
  PermissionRequestSchema,
  PluginEntrySchema,
  PluginMarketplaceEntrySchema,
  PrereqStepSchema,
  ProjectSchema,
  QuestionSchema,
  SessionModeSchema,
  SessionSchema,
  SessionSettingsPatchSchema,
  SettingsPatchSchema,
  SettingsSchema,
  SkillEntrySchema,
  SkillScopeSchema,
  SlashCommandSchema,
  TaskPatchSchema,
  TaskSchema,
  TaskSourceSchema,
  TaskStatusSchema,
  TerminalInfoSchema,
  TimestampSchema,
  ToolOutputSchema,
  ToolPolicyDecisionSchema,
  ToolPolicyEntrySchema,
  ToolPolicyScopeSchema,
  TurnSchema,
  TurnStatusSchema,
  UsageEventSchema,
  WorkspaceLayoutSchema,
} from "./domain.js";

/** One request/response pair. */
export interface ChannelDef<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  input: I;
  output: O;
}

function channel<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  input: I,
  output: O,
): ChannelDef<I, O> {
  return { input, output };
}

/**
 * Nothing to send. Modelled as an object so JSON survives the bridge; callers
 * pass `{}`. Not `.default({})` — zod 4 types a default by the schema's OUTPUT,
 * which for a schema whose fields carry their own defaults is not `{}`.
 */
const Empty = z.object({});

const OkSchema = z.object({ ok: z.boolean() });

/**
 * Phase 7-P0: the explicit project scope every integrations operation carries.
 *
 * A Project id names **one concrete execution directory** (a future worktree is
 * a Project id of its own, linked to the same repository — selecting it must
 * never execute at the parent root). Spread into an integrations channel's args:
 *
 *  - present → that project's files (`.mcp.json`, `.claude/settings.local.json`,
 *    `<project>/.claude/skills`, …) **plus** the global ones;
 *  - absent → the **global** files only. Never "the most recently touched
 *    project": two windows on two projects would otherwise read and write each
 *    other's scope depending on which one last touched a session row.
 *
 * An id that names no project is refused before any read, write, probe or shell
 * open, and a project/local mutation requires one.
 */
const ProjectScoped = { projectId: z.string().min(1).optional() } as const;

// ---------------------------------------------------------------------------
// renderer → main (invoke)
// ---------------------------------------------------------------------------

export const INVOKE_CHANNELS = {
  /** Native folder picker; resolves to null when the user cancels. */
  "projects.pick": channel(Empty, ProjectSchema.nullable()),
  "projects.list": channel(Empty, z.array(ProjectSchema)),

  "sessions.create": channel(
    z.object({
      projectId: z.string().min(1),
      mode: SessionModeSchema.default("solo"),
      title: z.string().default(""),
      agents: z.array(AgentDraftSchema).default([]),
    }),
    z.object({ session: SessionSchema, agents: z.array(AgentSchema) }),
  ),
  "sessions.list": channel(
    z.object({
      projectId: z.string().min(1).optional(),
      includeArchived: z.boolean().default(false),
    }),
    z.array(SessionSchema),
  ),
  "sessions.get": channel(
    z.object({ sessionId: z.string().min(1) }),
    z
      .object({
        session: SessionSchema,
        agents: z.array(AgentSchema),
        turns: z.array(TurnSchema),
        blocks: z.array(BlockSchema),
        /** True when the dispatcher still holds a hop the cap refused, so
         *  `chat.continue` would run it (ADR-0002, SPEC R11). The renderer's
         *  Continue bar is rebuilt from this rather than from the one-shot
         *  `chat.chainStopped` event, which only the foreground session hears
         *  and which `openSession` clears. */
        chainPending: z.boolean().default(false),
      })
      .nullable(),
  ),
  "sessions.archive": channel(
    z.object({ sessionId: z.string().min(1), archived: z.boolean().default(true) }),
    SessionSchema,
  ),

  /** Switch a session's mode (ADR-0002: "can be switched later without
   *  losing history"); the agents and transcript are untouched. */
  "sessions.setMode": channel(
    z.object({ sessionId: z.string().min(1), mode: SessionModeSchema }),
    SessionSchema,
  ),
  /** Merge-patch a session's round-table settings (`SessionSettings` — hop
   *  cap, sub-agent routing default, parallel dispatch); same merge-and-return
   *  shape as `settings.set`, scoped to one session. */
  "sessions.updateSettings": channel(
    z.object({ sessionId: z.string().min(1), patch: SessionSettingsPatchSchema }),
    SessionSchema,
  ),

  /** A session's top-level agents, in `order` (R13's agent tree/hover cards). */
  "agents.list": channel(z.object({ sessionId: z.string().min(1) }), z.array(AgentSchema)),
  /** Add a top-level agent to an existing round-table session. `displayName`/
   *  `mentionName` default from each other, then from the backend, exactly as
   *  `SessionsRepo.create`'s agents do — see `AgentDraftSchema`. */
  "agents.add": channel(
    z.object({
      sessionId: z.string().min(1),
      backend: BackendSchema,
      model: z.string().min(1),
      displayName: z.string().min(1).optional(),
      mentionName: MentionNameSchema.optional(),
      role: AgentRoleSchema.optional(),
      config: AgentConfigSchema.nullable().optional(),
    }),
    AgentSchema,
  ),
  /** Merge-patch one agent (`AgentPatchSchema`); refused if `patch.role` is
   *  `"lead"` — see `AgentPatchSchema`'s doc comment. */
  "agents.update": channel(
    z.object({ agentId: z.string().min(1), patch: AgentPatchSchema }),
    AgentSchema,
  ),
  "agents.remove": channel(z.object({ agentId: z.string().min(1) }), OkSchema),
  /** Promote `agentId` to lead, demoting the session's previous lead in the
   *  same write (the only sanctioned way to change `Session.leadAgentId`). */
  "agents.setLead": channel(
    z.object({ sessionId: z.string().min(1), agentId: z.string().min(1) }),
    SessionSchema,
  ),
  /** One agent's usage description, Claude-Code-info-card style (R13). */
  "agents.describe": channel(z.object({ agentId: z.string().min(1) }), AgentDescribeSchema),
  /** [7-P1] The minimal non-secret runtime facts about one agent's live
   *  harness — effective model, effort, permission mode, whether a restart is
   *  pending. Never the effective config object, environment or any key. */
  "agents.runtime": channel(
    z.object({ agentId: z.string().min(1) }),
    AgentRuntimeInfoSchema.nullable(),
  ),

  "turns.list": channel(
    z.object({ sessionId: z.string().min(1) }),
    z.object({ turns: z.array(TurnSchema), blocks: z.array(BlockSchema) }),
  ),

  /**
   * The whole value behind a truncated tool_call block's `outputRef` (R25's
   * "expandable" stub, for the case a harness moved the full value into
   * `tool_outputs` instead of keeping it on the block row as `fullOutput`).
   * `null` when the id is unknown (a relaunch against a different profile, or
   * a row a migration dropped) — the card says the full output is gone rather
   * than throwing.
   */
  "blocks.getOutput": channel(
    z.object({ id: z.string().min(1) }),
    ToolOutputSchema.nullable(),
  ),

  /**
   * Raw `usage_events` rows for a session (R23) — the session header meter
   * sums them, and a turn's `UsageLine` groups the ones matching its own
   * `turnId` for the per-model breakdown tooltip. Kept as the raw rows rather
   * than a pre-aggregated shape so both call sites can slice it differently
   * without two channels.
   */
  "turns.usage": channel(
    z.object({ sessionId: z.string().min(1) }),
    z.object({ events: z.array(UsageEventSchema) }),
  ),

  /** Submit a user message. Returns the user turn and the agent turn it started. */
  "chat.send": channel(
    z.object({
      sessionId: z.string().min(1),
      text: z.string(),
      /** Target agent in round-table mode; the lead when omitted. */
      agentId: z.string().min(1).nullable().default(null),
    }),
    z.object({
      userTurnId: z.string(),
      agentTurnId: z.string(),
      /** `@names` in the message that answer to no agent in this session.
       *  `resolveTargets` documents these as "never silently dropped" — a
       *  typo (`@claud`) otherwise becomes a message to the lead with nothing
       *  in the UI to say so. */
      unknownMentions: z.array(z.string()).default([]),
    }),
  ),
  "chat.interrupt": channel(z.object({ sessionId: z.string().min(1) }), OkSchema),
  /**
   * Built-ins plus the backend's own commands/skills/plugins (R14). Scoped to
   * the agent that will receive the message — the session's lead unless
   * `agentId` names another — because in a round-table session two agents on
   * different backends offer different menus.
   */
  "chat.listCommands": channel(
    z.object({
      sessionId: z.string().min(1).optional(),
      agentId: z.string().min(1).optional(),
    }),
    z.array(SlashCommandSchema),
  ),

  /**
   * Resume a round-table chain the dispatcher stopped at the session's hop
   * cap (ADR-0002: "until the user speaks or presses Continue", SPEC R11).
   * `agentTurnId` is the new turn this started, or `null` when there was
   * nothing to continue (no stopped chain, or a turn is already streaming).
   */
  "chat.continue": channel(
    z.object({ sessionId: z.string().min(1) }),
    z.object({ ok: z.boolean(), agentTurnId: z.string().nullable() }),
  ),

  /**
   * `decision` replaces the Phase 2 `behavior` field: `allow_always` (R28/R32
   * "remember this choice") is a third button alongside Allow/Deny, not a
   * variant of `scope`. A handler collapses it to `{behavior:"allow"}` for the
   * harness (which only ever needs to unblock the call) and `scope:"always"`
   * for the persisted decision — `PermissionDecisionSchema.behavior` in
   * `@capygen/shared` carries the full three-way value.
   */
  "permission.answer": channel(
    z.object({
      requestId: z.string().min(1),
      decision: z.enum(["allow", "allow_always", "deny"]),
      updatedInput: z.unknown().optional(),
      message: z.string().optional(),
      scope: z.enum(["once", "session", "always"]).default("once"),
    }),
    OkSchema,
  ),
  "question.answer": channel(
    z.object({
      requestId: z.string().min(1),
      /** question text → chosen option label (Phase 1 proven shape). */
      answers: z.record(z.string(), z.string()),
    }),
    OkSchema,
  ),

  /**
   * A backend's structured input request that is neither a permission prompt
   * nor `AskUserQuestion` — MCP `elicitation/create`, or a Codex user-input
   * request (R32). `null` answers means the user cancelled/declined.
   */
  "elicitation.answer": channel(
    z.object({
      sessionId: z.string().min(1),
      turnId: z.string().min(1),
      blockId: z.string().min(1),
      answers: z.record(z.string(), z.unknown()).nullable(),
    }),
    OkSchema,
  ),

  /** Backend/model availability for the New Session picker and Settings ▸ Harnesses. */
  "harness.list": channel(Empty, z.array(HarnessInfoSchema)),

  /**
   * API keys via Electron `safeStorage` (R21) — `secrets.has` is the only read
   * path; the value itself never crosses this bridge again once set.
   */
  "secrets.set": channel(
    z.object({ provider: ApiProviderSchema, value: z.string().min(1) }),
    OkSchema,
  ),
  /**
   * `source` says *where* the key came from, because "not set" was misleading:
   * the harness list treats `ANTHROPIC_API_KEY` & co. as a key too, so the
   * composer offered API models while Settings ▸ API keys said "Not set".
   * `stored` = the safeStorage file, `environment` = the documented env var.
   */
  "secrets.has": channel(
    z.object({ provider: ApiProviderSchema }),
    z.object({
      has: z.boolean(),
      source: z.enum(["stored", "environment", "none"]).default("none"),
    }),
  ),
  "secrets.delete": channel(z.object({ provider: ApiProviderSchema }), OkSchema),

  /** Read one MCP resource — how a widget's `ui://` HTML is fetched (R31, A13). */
  "mcp.readResource": channel(
    z.object({
      sessionId: z.string().min(1),
      agentId: z.string().min(1),
      serverName: z.string().min(1),
      uri: z.string().min(1),
    }),
    z.object({
      mimeType: z.string().optional(),
      text: z.string().optional(),
      /** Base64, when the resource is not text. */
      blob: z.string().optional(),
    }),
  ),

  /** A widget calls a tool through the host (ext-apps `ui/callTool` bridge, R31). */
  "widget.callTool": channel(
    z.object({
      sessionId: z.string().min(1),
      agentId: z.string().min(1),
      blockId: z.string().min(1),
      name: z.string().min(1),
      args: z.unknown(),
    }),
    z.unknown(),
  ),
  /**
   * Any other `ui/*` message a widget sends the host (size negotiation,
   * host-side actions such as Higgsfield's Animate/Edit/Download) — renderer
   * to main, for host-side handling. Widget *state* changes the other
   * direction ride the existing `chat.block` upsert event, same as any other
   * block; there is no separate `widget.update` event (see EVENT_CHANNELS).
   */
  "widget.event": channel(
    z.object({ blockId: z.string().min(1), type: z.string().min(1), payload: z.unknown() }),
    OkSchema,
  ),

  "settings.get": channel(Empty, SettingsSchema),
  /** `SettingsPatchSchema`, not `SettingsSchema.partial()` — see that
   *  schema's doc comment for the jitless-defaults bug this avoids. */
  "settings.set": channel(SettingsPatchSchema, SettingsSchema),

  /**
   * Phase 6's sectioned Settings hub (SPEC R19, R30) — additive alongside
   * `settings.get`/`.set` above (`GlobalSettingsSchema`'s own doc comment
   * explains why the two coexist rather than one replacing the other in this
   * pass). `settings.getAll` fires no event; `.patch`/`.reset` both broadcast
   * `settings.changed` (main's job, not the contract's).
   */
  "settings.getAll": channel(Empty, GlobalSettingsSchema),
  /** Deep-merged section-by-section (`mergeGlobalSettingsPatch`), not
   *  `GlobalSettingsSchema.partial()` — see `GlobalSettingsPatchSchema`'s doc
   *  comment for the jitless-defaults hazard this avoids, one level deeper
   *  than `settings.set` already fixes for the flat `SettingsPatchSchema`. */
  "settings.patch": channel(
    z.object({ patch: GlobalSettingsPatchSchema }),
    GlobalSettingsSchema,
  ),
  /** Reset one section back to its shipping default, or `"all"` for the
   *  whole object (`resetGlobalSettingsSection`). */
  "settings.reset": channel(
    z.object({ section: GlobalSettingsSectionSchema }),
    GlobalSettingsSchema,
  ),

  "app.version": channel(
    Empty,
    z.object({
      name: z.string(),
      version: z.string(),
      electron: z.string(),
      chrome: z.string(),
      node: z.string(),
      platform: z.string(),
      userDataDir: z.string(),
      logFile: z.string(),
      dbFile: z.string(),
    }),
  ),

  // -------------------------------------------------------------------------
  // Integrations, prerequisites, diagnostics (Phase 6, SPEC R3, R19-R21,
  // R28-R30). The backend's own config (a file, or its live listing) is the
  // source of truth (R29); these channels are capygen's read/write surface
  // over it, cached in `@capygen/db`'s `mcp_servers`/`plugins`/`skills`/
  // `policies` tables. See `@capygen/shared/domain.js` for the entity doc
  // comments (`McpServerEntry`, `PluginEntry`, `SkillEntry`,
  // `ToolPolicyEntry`, `PrereqStep`, `DiagnosticsInfoSchema`).
  // -------------------------------------------------------------------------

  /** One backend's whole integrations snapshot for the Settings ▸
   *  Integrations page (R28). `lastSync` is `null` until `.refresh` (or an
   *  app-start sync) has run at least once this session. */
  "integrations.list": channel(
    z.object({ backend: BackendSchema, ...ProjectScoped }),
    z.object({
      mcpServers: z.array(McpServerEntrySchema),
      plugins: z.array(PluginEntrySchema),
      skills: z.array(SkillEntrySchema),
      tools: z.array(ToolPolicyEntrySchema),
      lastSync: TimestampSchema.nullable(),
    }),
  ),

  "integrations.mcp.add": channel(
    z.object({
      backend: BackendSchema,
      scope: McpServerScopeSchema,
      entry: McpServerEntryDraftSchema,
      ...ProjectScoped,
    }),
    McpServerEntrySchema,
  ),
  "integrations.mcp.update": channel(
    z.object({
      backend: BackendSchema,
      scope: McpServerScopeSchema,
      name: z.string().min(1),
      patch: McpServerEntryPatchSchema,
      ...ProjectScoped,
    }),
    McpServerEntrySchema,
  ),
  "integrations.mcp.remove": channel(
    z.object({
      backend: BackendSchema,
      scope: McpServerScopeSchema,
      name: z.string().min(1),
      ...ProjectScoped,
    }),
    OkSchema,
  ),
  /** Connect and list tools, with a timeout (R28) — a live check, never a
   *  cache read; `scope` is optional only to disambiguate a name that exists
   *  in more than one (SPEC's own field list for this call is
   *  `{backend, name}`). */
  "integrations.mcp.test": channel(
    z.object({
      backend: BackendSchema,
      name: z.string().min(1),
      scope: McpServerScopeSchema.optional(),
      ...ProjectScoped,
    }),
    z.object({
      ok: z.boolean(),
      status: McpServerStatusSchema,
      tools: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
  ),

  "integrations.plugin.install": channel(
    z.object({
      backend: BackendSchema,
      marketplace: z.string().min(1),
      name: z.string().min(1),
      ...ProjectScoped,
    }),
    PluginEntrySchema,
  ),
  "integrations.plugin.uninstall": channel(
    z.object({ backend: BackendSchema, name: z.string().min(1), ...ProjectScoped }),
    OkSchema,
  ),
  "integrations.plugin.setEnabled": channel(
    z.object({
      backend: BackendSchema,
      name: z.string().min(1),
      enabled: z.boolean(),
      ...ProjectScoped,
    }),
    PluginEntrySchema,
  ),
  "integrations.plugin.marketplaces": channel(
    z.object({ backend: BackendSchema, ...ProjectScoped }),
    z.array(PluginMarketplaceEntrySchema),
  ),

  "integrations.skill.setEnabled": channel(
    z.object({
      backend: BackendSchema,
      name: z.string().min(1),
      enabled: z.boolean(),
      /** Disambiguates a name that exists in more than one scope; omitted
       *  affects the first match for `backend`+`name` (SPEC's own field list
       *  for this call is `{backend, name, enabled}`). */
      scope: SkillScopeSchema.optional(),
      ...ProjectScoped,
    }),
    SkillEntrySchema,
  ),
  "integrations.skill.create": channel(
    z.object({
      backend: BackendSchema,
      scope: SkillScopeSchema,
      name: z.string().min(1),
      markdown: z.string().min(1),
      ...ProjectScoped,
    }),
    SkillEntrySchema,
  ),
  /** Reveal the skill's file in the Editor pane or the OS shell — which one
   *  is main's call; nothing in the contract says which it picked. */
  "integrations.skill.open": channel(
    z.object({ path: z.string().min(1), ...ProjectScoped }),
    OkSchema,
  ),

  "integrations.tools.setPolicy": channel(
    z.object({
      backend: BackendSchema,
      scope: ToolPolicyScopeSchema,
      pattern: z.string().min(1),
      decision: ToolPolicyDecisionSchema,
      ...ProjectScoped,
    }),
    ToolPolicyEntrySchema,
  ),
  "integrations.tools.removePolicy": channel(
    z.object({
      backend: BackendSchema,
      scope: ToolPolicyScopeSchema,
      pattern: z.string().min(1),
      ...ProjectScoped,
    }),
    OkSchema,
  ),

  /** Re-read the backend's own files/live lists and refresh the cache
   *  (R29); fires `integrations.changed` for whatever kinds actually moved. */
  "integrations.refresh": channel(z.object({ backend: BackendSchema, ...ProjectScoped }), OkSchema),

  /** The setup panel's steps (R3), freshly probed every call. */
  "prereqs.status": channel(
    Empty,
    z.object({ steps: z.array(PrereqStepSchema), recommendation: z.string() }),
  ),
  /** `started`, not `ok` alone: the confirm dialog + visible console (R3,
   *  CLAUDE.md) means the step's own command may still be running when this
   *  resolves — `ok` is only whether main was able to *launch* it. */
  "prereqs.run": channel(
    z.object({ stepId: z.string().min(1) }),
    z.object({ ok: z.boolean(), started: z.boolean() }),
  ),

  "diagnostics.get": channel(Empty, DiagnosticsInfoSchema),
  /** Copies the rendered diagnostics text to the OS clipboard. */
  "diagnostics.copy": channel(Empty, OkSchema),

  // -------------------------------------------------------------------------
  // Workspace panes (Phase 5, SPEC R16-R18) — layout, files, git, terminal,
  // dev servers, tasks, browser view. See `@capygen/shared/domain.js` for the
  // entity doc comments (`WorkspaceLayout`, `DevServer`, `Task`,
  // `TerminalInfo`, `FileEntry`, `GitStatus`, `GitDiff`).
  // -------------------------------------------------------------------------

  /** The dockview arrangement for one project (R17). `null` when the project
   *  has never saved one — the workspace host falls back to its own default
   *  layout rather than treating that as an error. */
  "layout.get": channel(
    z.object({ projectId: z.string().min(1) }),
    WorkspaceLayoutSchema.nullable(),
  ),
  /** Debounced by the caller (R23-R26: no per-drag IPC chatter) — one write
   *  per settle, not one per frame. */
  "layout.set": channel(
    z.object({ projectId: z.string().min(1), layoutJson: z.unknown() }),
    WorkspaceLayoutSchema,
  ),

  /** Bounded directory listing (R23: node_modules/.git/dist ignored, capped
   *  entries) — `depth` limits recursion, omitted = the one directory named. */
  "fs.list": channel(
    z.object({
      projectId: z.string().min(1),
      dir: z.string().default(""),
      depth: z.number().int().nonnegative().optional(),
    }),
    FileListResultSchema,
  ),
  "fs.read": channel(
    z.object({
      projectId: z.string().min(1),
      path: z.string().min(1),
      maxBytes: z.number().int().positive().optional(),
    }),
    FileReadResultSchema,
  ),
  "fs.write": channel(
    z.object({ projectId: z.string().min(1), path: z.string().min(1), content: z.string() }),
    OkSchema,
  ),
  "fs.search": channel(
    z.object({
      projectId: z.string().min(1),
      query: z.string().min(1),
      limit: z.number().int().positive().optional(),
    }),
    FileListResultSchema,
  ),
  /** Start/stop the project's chokidar watcher; `fs.changed` events follow
   *  while it is on. Idempotent — watching an already-watched project (or
   *  unwatching one that is not) is not an error. */
  "fs.watch": channel(z.object({ projectId: z.string().min(1) }), OkSchema),
  "fs.unwatch": channel(z.object({ projectId: z.string().min(1) }), OkSchema),

  /** `null` when `projectId` is not a git repository at all — not an error
   *  (the Phase 5 workflow brief: "safe on non-repos"). */
  "git.status": channel(z.object({ projectId: z.string().min(1) }), GitStatusSchema.nullable()),
  "git.diff": channel(
    z.object({
      projectId: z.string().min(1),
      path: z.string().min(1).optional(),
      staged: z.boolean().default(false),
    }),
    z.array(GitDiffSchema),
  ),
  /** Commit an explicit, nonempty selection of literal paths. */
  "git.commit": channel(
    z.object({
      projectId: z.string().min(1),
      message: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    }),
    z.object({ ok: z.boolean(), sha: z.string().optional() }),
  ),

  "terminal.create": channel(
    z.object({
      projectId: z.string().min(1),
      sessionId: z.string().min(1).nullable().default(null),
      cwd: z.string().min(1).optional(),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
    TerminalInfoSchema,
  ),
  "terminal.write": channel(z.object({ id: z.string().min(1), data: z.string() }), OkSchema),
  "terminal.resize": channel(
    z.object({ id: z.string().min(1), cols: z.number().int().positive(), rows: z.number().int().positive() }),
    OkSchema,
  ),
  "terminal.kill": channel(z.object({ id: z.string().min(1) }), OkSchema),
  /** Answered from `TerminalService`'s in-memory registry, not SQL — see
   *  `TerminalInfoSchema`'s doc comment for why nothing persists a terminal. */
  "terminal.list": channel(z.object({ projectId: z.string().min(1) }), z.array(TerminalInfoSchema)),

  /** Re-scan the four detectors (R18) and persist anything new; returns the
   *  same shape as `servers.list` so the pane can render straight from
   *  either call. */
  "servers.detect": channel(
    z.object({ projectId: z.string().min(1) }),
    z.array(DevServerWithRunSchema),
  ),
  "servers.list": channel(
    z.object({ projectId: z.string().min(1) }),
    z.array(DevServerWithRunSchema),
  ),
  "servers.start": channel(z.object({ serverId: z.string().min(1) }), DevServerRunSchema),
  "servers.stop": channel(z.object({ serverId: z.string().min(1) }), DevServerRunSchema),
  "servers.logs": channel(
    z.object({ serverId: z.string().min(1), tail: z.number().int().positive().optional() }),
    z.object({ lines: z.array(z.string()) }),
  ),
  "servers.saveCustom": channel(
    z.object({ projectId: z.string().min(1), server: DevServerDraftSchema }),
    DevServerSchema,
  ),
  "servers.remove": channel(z.object({ serverId: z.string().min(1) }), OkSchema),

  /**
   * A manually-typed task (the Tasks pane's "add" row). Mirrors
   * `TasksRepo.create`'s input shape — everything but `title` is optional and
   * defaulted by the repo — because `tasks.update` is a merge-patch that
   * throws `unknown task: <id>` for a row that does not exist yet, so there is
   * no upsert to lean on. `sessionId` is required here even though the column
   * is nullable: every caller is a pane scoped to one session, and a row with
   * no session would never reach the `tasks.updated` broadcast.
   */
  "tasks.create": channel(
    z.object({
      sessionId: z.string().min(1),
      agentId: z.string().min(1).nullable().optional(),
      title: z.string().min(1),
      status: TaskStatusSchema.optional(),
      source: TaskSourceSchema.optional(),
      order: z.number().int().nonnegative().optional(),
    }),
    TaskSchema,
  ),
  "tasks.list": channel(
    z.object({
      sessionId: z.string().min(1).optional(),
      projectId: z.string().min(1).optional(),
    }),
    z.array(TaskSchema),
  ),
  "tasks.update": channel(
    z.object({ id: z.string().min(1), patch: TaskPatchSchema }),
    TaskSchema,
  ),

  /**
   * A native `WebContentsView` overlaying the renderer's placeholder box
   * (Omnigent's pattern — never a deprecated `<webview>`). `viewId` is the
   * Browser pane instance's own id, minted by the renderer, so more than one
   * tab/pane can exist without the main process guessing which is which.
   */
  "browser.attach": channel(
    z.object({ viewId: z.string().min(1), bounds: BoundsSchema, url: z.string().min(1).optional() }),
    OkSchema,
  ),
  "browser.detach": channel(z.object({ viewId: z.string().min(1) }), OkSchema),
  /** `url` carries either an address to load or the literal control words
   *  `"back"` / `"forward"` / `"reload"` — the Browser pane's own toolbar
   *  actions, kept on this one channel rather than four. */
  "browser.navigate": channel(
    z.object({ viewId: z.string().min(1), url: z.string().min(1) }),
    OkSchema,
  ),
  "browser.setBounds": channel(
    z.object({ viewId: z.string().min(1), bounds: BoundsSchema }),
    OkSchema,
  ),
  "browser.devtools": channel(z.object({ viewId: z.string().min(1) }), OkSchema),
} as const satisfies Record<string, ChannelDef>;

export type InvokeChannels = typeof INVOKE_CHANNELS;
export type InvokeChannel = keyof InvokeChannels;
/** What the caller passes (pre-defaults). */
export type InvokeInput<C extends InvokeChannel> = z.input<InvokeChannels[C]["input"]>;
/** What a handler receives (post-defaults). */
export type InvokeArgs<C extends InvokeChannel> = z.output<InvokeChannels[C]["input"]>;
export type InvokeResult<C extends InvokeChannel> = z.output<InvokeChannels[C]["output"]>;

export const INVOKE_CHANNEL_NAMES = Object.keys(INVOKE_CHANNELS) as InvokeChannel[];

// ---------------------------------------------------------------------------
// main → renderer (events)
// ---------------------------------------------------------------------------

export const EVENT_CHANNELS = {
  /** Upsert by `block.id` — the same block is re-sent as it streams and settles. */
  "chat.block": BlockSchema,
  "chat.turnStatus": z.object({
    sessionId: z.string(),
    turnId: z.string(),
    status: TurnStatusSchema,
    error: z.string().optional(),
  }),
  "session.updated": SessionSchema,
  /** A session's agent roster changed (add/update/remove/setLead) — the
   *  whole roster, in `order`, so the agent tree replaces rather than merges. */
  "agents.updated": z.object({ sessionId: z.string(), agents: z.array(AgentSchema) }),
  /** [7-P1] One agent's live harness changed state: a model/config edit is
   *  waiting for the current turn to end (`restartPending: true`), or it has
   *  been applied (`false`). Carries no configuration — read the details with
   *  `agents.runtime`. */
  "agent.runtime": z.object({
    agentId: z.string().min(1),
    restartPending: z.boolean(),
  }),
  /** The dispatcher stopped an agent-to-agent chain at the hop cap, or on an
   *  error mid-chain (ADR-0002, SPEC R11); `chat.continue` resumes it. */
  "chat.chainStopped": z.object({
    sessionId: z.string(),
    turnId: z.string(),
    reason: z.enum(["hop_cap", "error"]),
  }),
  "permission.request": z.object({
    sessionId: z.string(),
    turnId: z.string(),
    blockId: z.string(),
    request: PermissionRequestSchema,
  }),
  "question.request": z.object({
    sessionId: z.string(),
    turnId: z.string(),
    blockId: z.string(),
    requestId: z.string(),
    questions: z.array(QuestionSchema),
  }),
  /** MCP `elicitation/create` or a Codex user-input request (R32). */
  "elicitation.request": z.object({
    sessionId: z.string(),
    turnId: z.string(),
    blockId: z.string(),
    requestId: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    schema: z.unknown(),
  }),
  /** Shell-level notices: engine readiness, update state, backend errors. */
  "app.status": z.object({
    level: z.enum(["info", "warn", "error"]).default("info"),
    kind: z.string(),
    message: z.string(),
    ts: TimestampSchema,
  }),

  /** Debounced batch from the project's chokidar watcher (R23: never raw
   *  per-event noise) — fires only while `fs.watch` is active for `projectId`. */
  "fs.changed": z.object({
    projectId: z.string(),
    changes: z.array(FileChangeSchema),
  }),
  /** One chunk of a terminal's output (ConPTY), unthrottled at this layer —
   *  `TerminalService` owns any coalescing before it reaches here. */
  "terminal.data": z.object({ id: z.string(), data: z.string() }),
  /** `exitCode` is `null` when the process was killed rather than exiting on
   *  its own (e.g. `terminal.kill`, or the app closing). */
  "terminal.exit": z.object({ id: z.string(), exitCode: z.number().int().nullable() }),
  /** A dev server's run state changed (starting/running/stopped/failed, a
   *  discovered URL, an exit code) — one event per transition. */
  "servers.status": z.object({ run: DevServerRunSchema }),
  /** One ring-buffered log line (R23: capped, never the whole history). */
  "servers.log": z.object({ serverId: z.string(), line: z.string() }),
  /** The Tasks pane replaces its list wholesale on this event, the same
   *  "whole roster" pattern `agents.updated` uses, for the same reason: a
   *  derived task's status can change out from under an id the renderer
   *  never had a chance to diff against. */
  "tasks.updated": z.object({ sessionId: z.string(), tasks: z.array(TaskSchema) }),
  /** The Browser pane's toolbar state, pushed after every navigation. */
  "browser.state": z.object({
    viewId: z.string(),
    url: z.string(),
    title: z.string(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    loading: z.boolean(),
  }),

  /** Fired after `settings.patch`/`.reset` (Phase 6, SPEC R30) so every
   *  window's Settings hub stays in sync without polling. */
  "settings.changed": z.object({ settings: GlobalSettingsSchema }),
  /** One backend's integrations changed — either `integrations.refresh` ran,
   *  an app edit (`.mcp.*`/`.plugin.*`/`.skill.*`/`.tools.*`) landed, or a
   *  file watcher on the backend's own config noticed an outside edit (R29:
   *  two-way sync). `kinds` names which of `mcpServers`/`plugins`/`skills`/
   *  `tools` actually moved, so a listener need not re-fetch all four. */
  "integrations.changed": z.object({
    backend: BackendSchema,
    kinds: z.array(z.string()),
    /** The scope that moved: a project id, or `null` for the global files. */
    projectId: z.string().nullable(),
  }),
  /** The setup panel's steps changed (a step finished, or a fresh probe
   *  found something newly detected). */
  "prereqs.changed": z.object({ steps: z.array(PrereqStepSchema) }),
} as const satisfies Record<string, z.ZodTypeAny>;

export type EventChannels = typeof EVENT_CHANNELS;
export type EventChannel = keyof EventChannels;
export type EventPayload<E extends EventChannel> = z.output<EventChannels[E]>;
export type EventInput<E extends EventChannel> = z.input<EventChannels[E]>;

export const EVENT_CHANNEL_NAMES = Object.keys(EVENT_CHANNELS) as EventChannel[];

/** True when `name` is a channel this build knows — used to gate the bridge. */
export function isInvokeChannel(name: string): name is InvokeChannel {
  return Object.prototype.hasOwnProperty.call(INVOKE_CHANNELS, name);
}

export function isEventChannel(name: string): name is EventChannel {
  return Object.prototype.hasOwnProperty.call(EVENT_CHANNELS, name);
}

/** The name the preload puts on `window`. One place, both sides. */
export const IPC_BRIDGE_KEY = "capygen" as const;
