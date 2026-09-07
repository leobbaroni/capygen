/**
 * The workspace half of the IPC surface (SPEC R16-R18): files, git, terminals,
 * dev servers, tasks and the Browser pane's native view.
 *
 * It exists as its own module for the same reason `widgets.ts` does — so
 * `handlers.ts` stays a thin, Electron-free map from channel to behaviour and
 * gains five registration lines rather than five services.
 *
 * Two dependencies are optional and for the same reason: `browser` needs
 * Electron's `WebContentsView` (so only `main.ts` can build one) and is absent
 * in tests, where the five `browser.*` channels then answer loudly instead of
 * pretending a view exists.
 *
 * `observeBlock` is the Tasks pane's only input. It is called from the
 * broadcast tap in `handlers.ts`, so a `TodoWrite` an agent writes becomes a
 * task row without the Tasks pane ever asking a model anything (R26: no pane
 * IPC enters a model's context, and no derivation costs a token).
 */
import type { CapygenStore } from "@capygen/db";
import type {
  Block,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  WorktreeBranchChoice,
} from "@capygen/shared";
import { DevServerService } from "../workspace/DevServerService.js";
import { FsService } from "../workspace/FsService.js";
import { GitService } from "../workspace/GitService.js";
import { TasksService } from "../workspace/TasksService.js";
import { TerminalService } from "../workspace/TerminalService.js";
import {
  WorktreeService,
  type WorktreeRemovalRisk,
} from "../workspace/WorktreeService.js";
import type { BrowserViewHandlers } from "../workspace/BrowserViewService.js";
import type { Broadcast, EngineLogger } from "../engine/types.js";

/** Every channel this module answers. Listed rather than inferred so adding a
 *  workspace channel to the shared contract fails here, loudly, instead of
 *  falling through to a stub nobody notices. */
export const WORKSPACE_CHANNELS = [
  "layout.get",
  "layout.set",
  "fs.list",
  "fs.read",
  "fs.write",
  "fs.search",
  "fs.watch",
  "fs.unwatch",
  "git.status",
  "git.diff",
  "git.commit",
  "worktrees.list",
  "worktrees.create",
  "worktrees.register",
  "worktrees.remove",
  "terminal.create",
  "terminal.write",
  "terminal.resize",
  "terminal.kill",
  "terminal.list",
  "servers.detect",
  "servers.list",
  "servers.start",
  "servers.stop",
  "servers.logs",
  "servers.saveCustom",
  "servers.remove",
  "tasks.create",
  "tasks.list",
  "tasks.update",
  "browser.attach",
  "browser.detach",
  "browser.navigate",
  "browser.setBounds",
  "browser.devtools",
] as const satisfies readonly InvokeChannel[];

export type WorkspaceChannel = (typeof WORKSPACE_CHANNELS)[number];

export type WorkspaceHandlers = {
  [C in WorkspaceChannel]: (args: InvokeArgs<C>) => Promise<InvokeResult<C>> | InvokeResult<C>;
};

export interface WorkspaceIpcDeps {
  store: CapygenStore;
  broadcast: Broadcast;
  log: EngineLogger;
  /** Built in `main.ts` (it needs Electron); absent in tests. */
  browser?: BrowserViewHandlers;
  /** Test seams, forwarded to the individual services. */
  fs?: FsOverrides;
  git?: GitOverrides;
  worktrees?: WorktreeOverrides;
  terminal?: TerminalOverrides;
  servers?: ServerOverrides;
}

type FsOverrides = Pick<
  ConstructorParameters<typeof FsService>[0],
  "createWatcher" | "ripgrepPath"
>;
type GitOverrides = Pick<ConstructorParameters<typeof GitService>[0], "createClient">;
export interface WorktreeOverrides {
  /** Main's native destination chooser; the renderer never supplies a path. */
  pickDestination?: (args: {
    sourceProjectId: string;
    branch: WorktreeBranchChoice;
  }) => Promise<string | null>;
  /** Main's native destructive dialog; it names the exact canonical path. */
  confirmRemoval?: (risk: WorktreeRemovalRisk) => boolean | Promise<boolean>;
  /** Live runner activity that may not yet be reflected in a session row. */
  isActive?: (path: string) => boolean | Promise<boolean>;
  /** Test seams for the Git child boundary. */
  runGit?: ConstructorParameters<typeof WorktreeService>[0]["runGit"];
  env?: ConstructorParameters<typeof WorktreeService>[0]["env"];
}
type TerminalOverrides = Pick<
  ConstructorParameters<typeof TerminalService>[0],
  "spawnPty" | "resolveShell" | "env" | "killTree"
>;
type ServerOverrides = Pick<
  ConstructorParameters<typeof DevServerService>[0],
  "spawnProcess" | "probe" | "listenerPid" | "killTree" | "probeWindowMs" | "probeIntervalMs" | "now"
>;

export interface WorkspaceIpc {
  handlers: WorkspaceHandlers;
  /** Feed one persisted block to the Tasks derivation (`TasksService`). */
  observeBlock(block: Block): void;
  /** Also reachable directly, for the handful of places that want a service
   *  rather than a channel (tests, and `main.ts`'s shutdown). */
  readonly fs: FsService;
  readonly git: GitService;
  readonly worktrees: WorktreeService;
  readonly terminals: TerminalService;
  readonly servers: DevServerService;
  readonly tasks: TasksService;
  dispose(): Promise<void>;
}

export function createWorkspaceIpc(deps: WorkspaceIpcDeps): WorkspaceIpc {
  const { store, broadcast, log } = deps;

  const fs = new FsService({ store, broadcast, log, ...(deps.fs ?? {}) });
  const git = new GitService({ store, log, ...(deps.git ?? {}) });
  const worktrees = new WorktreeService({
    store,
    log,
    ...(deps.worktrees?.runGit ? { runGit: deps.worktrees.runGit } : {}),
    ...(deps.worktrees?.env ? { env: deps.worktrees.env } : {}),
    isActive: deps.worktrees?.isActive ?? (() => false),
    confirmRemove: (risk) => {
      if (!deps.worktrees?.confirmRemoval) {
        throw new Error("worktrees.remove: no native destructive confirmation is wired");
      }
      return deps.worktrees.confirmRemoval(risk);
    },
  });
  const terminals = new TerminalService({ store, broadcast, log, ...(deps.terminal ?? {}) });
  const servers = new DevServerService({ store, broadcast, log, ...(deps.servers ?? {}) });
  const tasks = new TasksService({ store, broadcast, log });

  /** The five `browser.*` channels are the only ones that need Electron, so
   *  they are the only ones that can be missing. Failing loudly beats a
   *  silent `{ok:false}` that looks like a view that just would not load. */
  function browser(): BrowserViewHandlers {
    if (!deps.browser) throw new Error("browser.*: no WebContentsView host is wired");
    return deps.browser;
  }

  const handlers: WorkspaceHandlers = {
    "layout.get": (args) => store.workspaceLayouts.get(args.projectId),
    "layout.set": (args) => store.workspaceLayouts.set(args.projectId, args.layoutJson),

    "fs.list": (args) => fs.list(args),
    "fs.read": (args) => fs.read(args),
    "fs.write": (args) => fs.write(args),
    "fs.search": (args) => fs.search(args),
    "fs.watch": (args) => fs.watch(args),
    "fs.unwatch": (args) => fs.unwatch(args),

    "git.status": (args) => git.status(args),
    "git.diff": (args) => git.diff(args),
    "git.commit": (args) => git.commit(args),

    "worktrees.list": (args) => worktrees.list(args),
    "worktrees.create": async (args) => {
      if (!deps.worktrees?.pickDestination) {
        throw new Error("worktrees.create: no native destination picker is wired");
      }
      // Validate source/ref before opening native UI, then `create` repeats the
      // checks after the awaited dialog to close the branch-occupancy race.
      await worktrees.validateCreate(args);
      const destinationPath = await deps.worktrees.pickDestination(args);
      if (destinationPath === null) return null;
      return worktrees.create({ ...args, destinationPath });
    },
    "worktrees.register": (args) => worktrees.register(args),
    "worktrees.remove": (args) => worktrees.remove(args),

    "terminal.create": (args) => terminals.create(args),
    "terminal.write": (args) => terminals.write(args),
    "terminal.resize": (args) => terminals.resize(args),
    "terminal.kill": (args) => terminals.kill(args),
    "terminal.list": (args) => terminals.list(args),

    "servers.detect": (args) => servers.detect(args),
    "servers.list": (args) => servers.list(args),
    "servers.start": (args) => servers.start(args),
    "servers.stop": (args) => servers.stop(args),
    "servers.logs": (args) => servers.logs(args),
    "servers.saveCustom": (args) =>
      store.devServers.create({ projectId: args.projectId, server: args.server }),
    "servers.remove": (args) => ({ ok: store.devServers.remove(args.serverId) }),

    "tasks.create": (args) => tasks.create(args),
    "tasks.list": (args) => tasks.list(args),
    "tasks.update": (args) => tasks.update(args),

    "browser.attach": (args) => browser().attach(args),
    "browser.detach": (args) => browser().detach(args),
    "browser.navigate": (args) => browser().navigate(args),
    "browser.setBounds": (args) => browser().setBounds(args),
    "browser.devtools": (args) => browser().devtools(args),
  };

  return {
    handlers,
    observeBlock: (block) => tasks.observeBlock(block),
    fs,
    git,
    worktrees,
    terminals,
    servers,
    tasks,
    dispose: async () => {
      // Order matters only in that the child processes go first: a watcher
      // firing on a directory a dying dev server is still writing to is noise
      // nobody is listening for any more.
      await servers.dispose();
      await terminals.dispose();
      await fs.dispose();
      deps.browser?.dispose();
    },
  };
}
