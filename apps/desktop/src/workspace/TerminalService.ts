/**
 * The Terminal pane's processes (SPEC R16: "Terminal (node-pty + xterm, the
 * session's cwd)").
 *
 * node-pty 1.1.0 loads under Electron 44 with **no rebuild** — its prebuilds
 * are N-API (`node-addon-api` ^7), so the same `pty.node` answers Electron 44's
 * ABI 149 and Node 22.16's ABI 127. Measured both ways; see
 * `docs/adr/0005-terminal-node-pty.md`. That is also why the import here is a
 * lazy `import("node-pty")`: a profile that never opens a Terminal pane never
 * loads a native module, and the desktop bundle keeps node-pty **external**
 * (its loader does a relative `require("../build/Release/pty.node")`, which an
 * inlined copy could not resolve).
 *
 * Windows specifics, all of them deliberate:
 *   - the shell is `pwsh.exe` when it is on PATH, else `powershell.exe` — the
 *     app's own shell, never `cmd.exe`, and never the user's `SHELL`;
 *   - ConPTY, not winpty: `useConpty: true`, with node-pty's bundled
 *     `conpty.dll` (its post-install step puts one next to the binding);
 *   - the environment is `cleanEnv()` from `@capygen/engine` — the same
 *     nested-session scrub and UTF-8 forcing every backend child gets, so a
 *     terminal opened from inside a Claude Code session does not inherit
 *     `CLAUDECODE` and believe it is nested;
 *   - kill is a *tree* kill (`taskkill /T /F`), because killing a PowerShell
 *     host leaves its children — a dev server, a test watcher — orphaned.
 *
 * Nothing is persisted: a pty is a live OS handle, so a row surviving a
 * restart would describe a terminal that no longer exists (migration 0004 has
 * no `terminals` table on purpose). `terminal.list` answers from this
 * registry.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CapygenStore } from "@capygen/db";
import { cleanEnv } from "@capygen/engine";
import { newId, type TerminalInfo } from "@capygen/shared";
import { projectRoot, resolveExistingInside } from "./paths.js";
import type { Broadcast, EngineLogger } from "../engine/types.js";

/** Output is coalesced over this window before one `terminal.data` goes out —
 *  a build's output is thousands of tiny writes and each one is an IPC hop
 *  (R23-R26: pane chatter stays cheap and never reaches a model). */
export const OUTPUT_FLUSH_MS = 16;
/** A single flush never carries more than this; xterm renders it either way
 *  and an unbounded string is a main-process heap risk. */
export const MAX_FLUSH_BYTES = 256 * 1024;

/** The slice of node-pty's `IPty` used here. */
export interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  useConpty?: boolean;
}

export type PtySpawner = (file: string, args: string[], options: PtySpawnOptions) => PtyLike;

export interface TerminalServiceDeps {
  store: CapygenStore;
  broadcast: Broadcast;
  log: EngineLogger;
  /** Overridable in tests; the default lazily loads node-pty's `spawn`. */
  spawnPty?: () => Promise<PtySpawner> | PtySpawner;
  /** Overridable in tests; the default prefers `pwsh.exe` on PATH. */
  resolveShell?: () => string;
  /** Overridable in tests; the default is `cleanEnv(process.env)`. */
  env?: () => Record<string, string>;
  /** Overridable in tests; the default runs `taskkill /T /F /PID`. */
  killTree?: (pid: number) => void;
}

interface LiveTerminal {
  info: TerminalInfo;
  pty: PtyLike;
  buffer: string[];
  bufferedBytes: number;
  timer: NodeJS.Timeout | null;
  exited: boolean;
}

export class TerminalService {
  private readonly terminals = new Map<string, LiveTerminal>();
  private spawner: PtySpawner | null = null;

  constructor(private readonly deps: TerminalServiceDeps) {}

  async create(args: {
    projectId: string;
    sessionId: string | null;
    cwd?: string;
    cols: number;
    rows: number;
  }): Promise<TerminalInfo> {
    const { root } = projectRoot(this.deps.store, args.projectId);
    const cwd = args.cwd ? resolveExistingInside(root, args.cwd) : root;
    const shell = (this.deps.resolveShell ?? resolveDefaultShell)();
    const env = (this.deps.env ?? defaultEnv)();
    const spawner = await this.resolveSpawner();

    const id = newId("terminal");
    const pty = spawner(shell, shellArgs(shell), {
      name: "xterm-256color",
      cols: args.cols,
      rows: args.rows,
      cwd,
      env,
      useConpty: true,
    });

    const info: TerminalInfo = {
      id,
      projectId: args.projectId,
      sessionId: args.sessionId,
      title: path.basename(shell),
      cwd,
      shell,
      cols: args.cols,
      rows: args.rows,
    };
    const live: LiveTerminal = {
      info,
      pty,
      buffer: [],
      bufferedBytes: 0,
      timer: null,
      exited: false,
    };
    this.terminals.set(id, live);

    pty.onData((data) => this.queue(live, data));
    pty.onExit(({ exitCode }) => {
      live.exited = true;
      this.flush(live);
      this.terminals.delete(id);
      this.deps.broadcast("terminal.exit", { id, exitCode });
    });

    this.deps.log.info(`[terminal] ${id} ${shell} pid=${pty.pid} cwd=${cwd}`);
    return info;
  }

  write(args: { id: string; data: string }): { ok: boolean } {
    const live = this.terminals.get(args.id);
    if (!live) return { ok: false };
    live.pty.write(args.data);
    return { ok: true };
  }

  resize(args: { id: string; cols: number; rows: number }): { ok: boolean } {
    const live = this.terminals.get(args.id);
    if (!live) return { ok: false };
    try {
      live.pty.resize(args.cols, args.rows);
    } catch (err) {
      // A pty that exited between the renderer's resize and this call throws;
      // that is a stale pane, not a failure worth surfacing.
      this.deps.log.warn(`[terminal] resize ${args.id}: ${(err as Error).message}`);
      return { ok: false };
    }
    live.info = { ...live.info, cols: args.cols, rows: args.rows };
    return { ok: true };
  }

  /**
   * Kill the shell *and its children*. `IPty.kill()` alone stops the
   * PowerShell host and leaves whatever it started running with no console —
   * on Windows an orphaned `node.exe` holding port 3000 is exactly the bug
   * the Servers pane then cannot explain.
   */
  kill(args: { id: string }): { ok: boolean } {
    const live = this.terminals.get(args.id);
    if (!live) return { ok: false };
    this.terminals.delete(args.id);
    const pid = live.pty.pid;
    try {
      (this.deps.killTree ?? killProcessTree)(pid);
    } catch (err) {
      this.deps.log.warn(`[terminal] tree kill ${pid}: ${(err as Error).message}`);
    }
    try {
      live.pty.kill();
    } catch {
      /* already gone — the tree kill above is what mattered */
    }
    if (live.timer) clearTimeout(live.timer);
    if (!live.exited) this.deps.broadcast("terminal.exit", { id: args.id, exitCode: null });
    return { ok: true };
  }

  list(args: { projectId: string }): TerminalInfo[] {
    return [...this.terminals.values()]
      .filter((live) => live.info.projectId === args.projectId)
      .map((live) => live.info);
  }

  async dispose(): Promise<void> {
    for (const id of [...this.terminals.keys()]) this.kill({ id });
  }

  // -------------------------------------------------------------------------

  private queue(live: LiveTerminal, data: string): void {
    live.buffer.push(data);
    live.bufferedBytes += data.length;
    if (live.bufferedBytes >= MAX_FLUSH_BYTES) {
      this.flush(live);
      return;
    }
    if (live.timer) return;
    const timer = setTimeout(() => this.flush(live), OUTPUT_FLUSH_MS);
    timer.unref?.();
    live.timer = timer;
  }

  private flush(live: LiveTerminal): void {
    if (live.timer) {
      clearTimeout(live.timer);
      live.timer = null;
    }
    if (live.buffer.length === 0) return;
    const data = live.buffer.join("");
    live.buffer = [];
    live.bufferedBytes = 0;
    this.deps.broadcast("terminal.data", { id: live.info.id, data });
  }

  private async resolveSpawner(): Promise<PtySpawner> {
    if (this.spawner) return this.spawner;
    const factory = this.deps.spawnPty ?? defaultSpawner;
    this.spawner = await factory();
    return this.spawner;
  }
}

// ---------------------------------------------------------------------------
// Windows shell + process-tree helpers
// ---------------------------------------------------------------------------

/**
 * PowerShell 7 when the user has it, Windows PowerShell otherwise. Resolved by
 * walking `PATH` rather than shelling out to `where.exe`, so opening a
 * terminal costs no extra process.
 */
export function resolveDefaultShell(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== "win32") return env.SHELL ?? "/bin/bash";
  const found = onPath("pwsh.exe", env);
  if (found) return found;
  const system32 = path.join(
    env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return fs.existsSync(system32) ? system32 : "powershell.exe";
}

function onPath(exe: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, exe);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* an unreadable PATH entry is not this function's problem */
    }
  }
  return null;
}

/** `-NoLogo` keeps the copyright banner out of the first frame; nothing else
 *  is passed, so the user's profile still loads (their prompt, their aliases). */
export function shellArgs(shell: string): string[] {
  const name = path.basename(shell).toLowerCase();
  if (name === "pwsh.exe" || name === "powershell.exe") return ["-NoLogo"];
  return [];
}

function defaultEnv(): Record<string, string> {
  const cleaned = cleanEnv(process.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(cleaned)) {
    if (typeof value === "string") env[key] = value;
  }
  // xterm.js is a 256-colour terminal; without this many CLIs fall back to
  // monochrome inside a pty they cannot probe.
  env.TERM = env.TERM ?? "xterm-256color";
  return env;
}

/**
 * `taskkill /T /F` on Windows, a process-group kill elsewhere. Never throws
 * for a process that is already gone.
 *
 * **Synchronous on purpose.** `taskkill /T` walks the process tree by parent
 * pid, so it must run while the parent is still alive: an asynchronous
 * `taskkill` followed immediately by `child.kill()` races, the shell dies
 * first, and every grandchild — the dev server actually holding the port — is
 * reparented and survives. That was a real bug, caught by the "port stops
 * answering" assertion in `apps/desktop/test/workspaceServers.test.ts`.
 */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 10_000,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function defaultSpawner(): Promise<PtySpawner> {
  const pty = (await import("node-pty")) as unknown as {
    spawn: PtySpawner;
    default?: { spawn: PtySpawner };
  };
  const spawnFn = pty.spawn ?? pty.default?.spawn;
  if (typeof spawnFn !== "function") {
    throw new Error("node-pty: no spawn export (is the native module built?)");
  }
  return spawnFn;
}
