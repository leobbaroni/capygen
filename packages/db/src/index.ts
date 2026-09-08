/**
 * `@capygen/db` — SQLite storage for the main process (and tests).
 *
 * Driver decision: `node:sqlite` (docs/adr/0003-sqlite-driver.md).
 * Only the Electron main process opens the real database; renderers reach it
 * through the IPC contract in `@capygen/shared`.
 */
import type { ModelCatalogue } from "@capygen/shared";
import { openDatabase, type OpenDatabaseOptions } from "./migrate.js";
import type { Database } from "./driver.js";
import { AutomationsRepo, InboxRepo } from "./persistence.js";
import { LocalNotesRepo } from "./localNotes.js";
import {
  LocalMembersRepo,
  LocalPolicyAuditRepo,
  LocalPolicyRulesRepo,
  SessionMembersRepo,
} from "./localPolicies.js";
import {
  BlocksRepo,
  DevServersRepo,
  GlobalSettingsRepo,
  ImportsRepo,
  McpServersRepo,
  PluginsRepo,
  ProjectsRepo,
  SessionsRepo,
  SettingsRepo,
  SharesRepo,
  SkillsRepo,
  TasksRepo,
  ToolOutputsRepo,
  ToolPoliciesRepo,
  TurnsRepo,
  UsageRepo,
  WorkspaceLayoutsRepo,
} from "./repos.js";

export * from "./canonicalJson.js";
export * from "./driver.js";
export * from "./migrate.js";
export * from "./repos.js";
export * from "./persistence.js";
export * from "./localPolicies.js";
export * from "./localNotes.js";

/** Every repository over one connection. */
export interface CapygenStore {
  db: Database;
  projects: ProjectsRepo;
  sessions: SessionsRepo;
  /** Read-only transcript artifacts and fresh-session continuation provenance. */
  imports: ImportsRepo;
  /** Read-only shared-bundle artifacts (migration 0009, Phase 9 / P15) — the
   *  sibling of `imports`, told apart by `sessions.artifact_kind`. */
  shares: SharesRepo;
  turns: TurnsRepo;
  blocks: BlocksRepo;
  toolOutputs: ToolOutputsRepo;
  usage: UsageRepo;
  settings: SettingsRepo;
  /** Per-project dockview layout (migration 0004, SPEC R17). */
  workspaceLayouts: WorkspaceLayoutsRepo;
  /** Detected/custom dev server definitions (migration 0004, SPEC R18) — the
   *  live run state is never persisted; see `DevServerRunSchema`. */
  devServers: DevServersRepo;
  /** Agent-derived and manual tasks (migration 0004, SPEC R16/P10). */
  tasks: TasksRepo;
  /** Persisted schedules, runs and non-expiring execution leases (Phase 8). */
  automations: AutomationsRepo;
  /** Restart-safe event projection with stable deduplication keys (Phase 8). */
  inbox: InboxRepo;
  /** The sectioned Settings hub object (Phase 6, SPEC R19/R30) — one more
   *  row in `settings`, and, since 7-P1, the **canonical** home of every
   *  preference the flat `settings` repo above also shows. */
  globalSettings: GlobalSettingsRepo;
  /**
   * [7-P1] Tell the flat compatibility view each backend's own catalogue
   * default, so `settings.all().defaultModel` agrees with what a harness would
   * actually run. Set once by the desktop from the same cached `harness.list`
   * the picker uses; without it the built-in defaults still apply
   * (`BUILTIN_BACKEND_DEFAULT_MODEL`), so nothing here ever probes.
   */
  setModelCatalogue(catalogue: ModelCatalogue | undefined): void;
  /** Integrations caches (Phase 6, SPEC R28-R29): MCP servers, plugins,
   *  skills, per-tool policies — migration 0001's tables, migration 0005's
   *  `backend` column. */
  mcpServers: McpServersRepo;
  plugins: PluginsRepo;
  skills: SkillsRepo;
  toolPolicies: ToolPoliciesRepo;
  /** Local execution policy state (migration 0010, ADR-0007) — capygen's own
   *  additional restrictions, never a copy of a backend's native rules, and a
   *  different store from the `toolPolicies` cache above. Grants are absent by
   *  design: they are bound to a live lifecycle token and stay in memory. */
  localMembers: LocalMembersRepo;
  sessionMembers: SessionMembersRepo;
  localPolicyRules: LocalPolicyRulesRepo;
  localPolicyAudit: LocalPolicyAuditRepo;
  /** Locally authored notes on any session (migration 0011, P15) — kept apart
   *  from a received bundle's own comments so an artifact stays immutable. */
  localNotes: LocalNotesRepo;
  /** Migrations applied by this open, and the backup taken beforehand. */
  migration: { applied: string[]; backupFile: string | null };
  /** Turns/sessions this open had to close because the last run did not. */
  reconciled: { turns: number; sessions: number };
  close(): void;
}

/**
 * Close out anything the previous run left mid-flight.
 *
 * Nothing in the process can still be streaming into a turn the moment the
 * database is opened, so a `streaming` row is the fingerprint of a crash or a
 * quit during a turn. Left alone it locks that session's composer forever: the
 * renderer seeds `turnStatus` from these rows, `isBusy` stays true, and
 * `chat.interrupt` has no live turn to stop.
 */
function reconcileInFlight(db: Database): { turns: number; sessions: number } {
  const turns = db.run("UPDATE turns SET status = 'interrupted' WHERE status = 'streaming'");
  const sessions = db.run(
    "UPDATE sessions SET status = 'idle' WHERE status IN ('running', 'waiting')",
  );
  return { turns, sessions };
}

export function openStore(file: string, options: OpenDatabaseOptions = {}): CapygenStore {
  const { db, result } = openDatabase(file, options);
  const reconciled = reconcileInFlight(db);
  const globalSettings = new GlobalSettingsRepo(db);
  const localMembers = new LocalMembersRepo(db);
  let catalogue: ModelCatalogue | undefined;
  return {
    setModelCatalogue: (next) => {
      catalogue = next;
    },
    reconciled,
    db,
    projects: new ProjectsRepo(db),
    sessions: new SessionsRepo(db),
    imports: new ImportsRepo(db),
    shares: new SharesRepo(db),
    turns: new TurnsRepo(db),
    blocks: new BlocksRepo(db),
    toolOutputs: new ToolOutputsRepo(db),
    usage: new UsageRepo(db),
    settings: new SettingsRepo(db, globalSettings, () => catalogue),
    workspaceLayouts: new WorkspaceLayoutsRepo(db),
    devServers: new DevServersRepo(db),
    tasks: new TasksRepo(db),
    automations: new AutomationsRepo(db),
    inbox: new InboxRepo(db),
    globalSettings,
    mcpServers: new McpServersRepo(db),
    plugins: new PluginsRepo(db),
    skills: new SkillsRepo(db),
    toolPolicies: new ToolPoliciesRepo(db),
    localMembers,
    sessionMembers: new SessionMembersRepo(db, localMembers),
    localPolicyRules: new LocalPolicyRulesRepo(db),
    localPolicyAudit: new LocalPolicyAuditRepo(db),
    localNotes: new LocalNotesRepo(db),
    migration: result,
    close: () => db.close(),
  };
}
