/**
 * One-click dev servers (SPEC R18, G6). Detection lives in `detectors.ts`;
 * this file owns everything that has a process attached to it.
 *
 * The shape of a start, in order:
 *
 *   1. if the server declares a port and that port is **already answering**,
 *      capygen does not start a second one. It adopts the existing server:
 *      the run reports `running` with the owning PID (from `netstat -ano`) and
 *      the URL that already works, and an `app.status` line says so. An
 *      EADDRINUSE crash three seconds later would tell the user less;
 *   2. otherwise spawn with `windowsHide` and the cleaned environment
 *      (`cleanEnv`, the same one every backend child gets), status `starting`;
 *   3. every output line goes into a 2000-line ring buffer and out as one
 *      `servers.log` event (R23: capped, never the whole history);
 *   4. the URL is discovered from stdout first (`urlFromLogLine`) because a
 *      dev server prints the address it actually bound, and only then by
 *      probing the declared port every 500 ms for up to 60 s;
 *   5. exit → `stopped` (we asked) or `failed` (it did not).
 *
 * Run state is never persisted (`DevServerRunSchema`): a pid from the last run
 * is meaningless after a restart. A *discovered* port or URL is, though — it
 * is written back onto the `dev_servers` row so the next `servers.list`
 * already knows where the server lives.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CapygenStore } from "@capygen/db";
import { cleanEnv } from "@capygen/engine";
import type { DevServer, DevServerRun, DevServerWithRun } from "@capygen/shared";
import { detectDevServers, mergeDetected } from "./detectors.js";
import { findListenerPid, probePort, urlFromLogLine, waitForPort } from "./ports.js";
import { projectRoot } from "./paths.js";
import { killProcessTree } from "./TerminalService.js";
import type { Broadcast, EngineLogger } from "../engine/types.js";

/** Ring-buffer depth, per server (SPEC R23-R26: "log ring buffers capped"). */
export const MAX_LOG_LINES = 2_000;
/** A single log line is truncated past this; one runaway line must not be a
 *  megabyte of IPC. */
export const MAX_LOG_LINE_CHARS = 4_000;
/** A port-less server is called `running` once it has survived this long —
 *  there is nothing to probe, and the process being alive is the only fact
 *  available. */
export const PORTLESS_RUNNING_MS = 3_000;

interface LiveRun {
  run: DevServerRun;
  child: ChildProcess | null;
  /** True when the port was already in use and capygen attached to what was
   *  there instead of starting a competing process. */
  adopted: boolean;
  /** Set by `stop` so the exit handler reports `stopped`, not `failed`. */
  stopping: boolean;
  log: string[];
  /** Partial trailing line between two stdout chunks. */
  partial: string;
}

export interface DevServerServiceDeps {
  store: CapygenStore;
  broadcast: Broadcast;
  log: EngineLogger;
  /** Overridable in tests; the default is `child_process.spawn`. */
  spawnProcess?: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
  ) => ChildProcess;
  /** Overridable in tests; the default probes a real TCP connect. */
  probe?: (port: number) => Promise<boolean>;
  /** Overridable in tests; the default parses `netstat -ano`. */
  listenerPid?: (port: number) => number | null;
  /** Overridable in tests; the default is `taskkill /T /F`. */
  killTree?: (pid: number) => void;
  /** Overridable in tests, to keep the port wait short. */
  probeWindowMs?: number;
  probeIntervalMs?: number;
  now?: () => number;
}

export class DevServerService {
  private readonly runs = new Map<string, LiveRun>();

  constructor(private readonly deps: DevServerServiceDeps) {}

  // -------------------------------------------------------------------------
  // detect / list
  // -------------------------------------------------------------------------

  /** Re-scan the four detectors and persist what they found (upsert by the
   *  detector's deterministic id, so nothing duplicates), then answer the same
   *  shape `list` does. */
  detect(args: { projectId: string }): DevServerWithRun[] {
    const { root } = projectRoot(this.deps.store, args.projectId);
    const now = (this.deps.now ?? Date.now)();
    const found = detectDevServers({ projectId: args.projectId, root, now });
    for (const detected of found) {
      const existing = this.deps.store.devServers.get(detected.id);
      this.deps.store.devServers.upsert(mergeDetected(existing, detected));
    }
    this.deps.log.info(`[servers] detected ${found.length} in ${root}`);
    return this.list(args);
  }

  list(args: { projectId: string }): DevServerWithRun[] {
    return this.deps.store.devServers
      .listByProject(args.projectId)
      .map((server) => ({ server, run: this.runs.get(server.id)?.run ?? null }));
  }

  logs(args: { serverId: string; tail?: number }): { lines: string[] } {
    const live = this.runs.get(args.serverId);
    if (!live) return { lines: [] };
    const tail = args.tail ?? MAX_LOG_LINES;
    return { lines: live.log.slice(-tail) };
  }

  // -------------------------------------------------------------------------
  // start / stop
  // -------------------------------------------------------------------------

  async start(args: { serverId: string }): Promise<DevServerRun> {
    const server = this.deps.store.devServers.get(args.serverId);
    if (!server) throw new Error(`unknown dev server: ${args.serverId}`);

    const existing = this.runs.get(server.id);
    if (existing && (existing.run.status === "running" || existing.run.status === "starting")) {
      return existing.run;
    }

    const adopted = await this.adoptIfPortBusy(server);
    if (adopted) return adopted;

    return this.spawnServer(server);
  }

  /**
   * "The port is taken" is only an error if we cannot say by what. When the
   * declared port already answers, capygen reports the owning PID and hands
   * back the URL that is already live rather than spawning a process that
   * would die on EADDRINUSE.
   */
  private async adoptIfPortBusy(server: DevServer): Promise<DevServerRun | null> {
    if (server.port === undefined) return null;
    const busy = await (this.deps.probe ?? probePort)(server.port);
    if (!busy) return null;
    const pid = (this.deps.listenerPid ?? findListenerPid)(server.port);
    const url = server.url ?? `http://localhost:${server.port}`;
    const run: DevServerRun = {
      serverId: server.id,
      status: "running",
      url,
      startedAt: (this.deps.now ?? Date.now)(),
      ...(pid !== null ? { pid } : {}),
    };
    this.runs.set(server.id, {
      run,
      child: null,
      adopted: true,
      stopping: false,
      log: [],
      partial: "",
    });
    const owner = pid !== null ? `PID ${pid}` : "another process";
    this.deps.broadcast("app.status", {
      level: "warn",
      kind: "servers.portInUse",
      message:
        `Port ${server.port} is already in use by ${owner} — capygen did not start ` +
        `a second "${server.name}". Using ${url}.`,
      ts: (this.deps.now ?? Date.now)(),
    });
    this.emit(run);
    return run;
  }

  private spawnServer(server: DevServer): DevServerRun {
    const env = { ...toStringRecord(cleanEnv(process.env)), ...(server.env ?? {}) };
    if (server.port !== undefined) env.PORT = env.PORT ?? String(server.port);

    const spawner = this.deps.spawnProcess ?? defaultSpawn;
    const child = spawner(server.command, server.args, { cwd: server.cwd, env });

    const run: DevServerRun = {
      serverId: server.id,
      status: "starting",
      startedAt: (this.deps.now ?? Date.now)(),
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      ...(server.url !== undefined ? { url: server.url } : {}),
    };
    const live: LiveRun = {
      run,
      child,
      adopted: false,
      stopping: false,
      log: [],
      partial: "",
    };
    this.runs.set(server.id, live);
    this.deps.log.info(
      `[servers] start ${server.name} (${server.command} ${server.args.join(" ")}) pid=${child.pid}`,
    );
    this.emit(run);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onOutput(server, live, chunk));
    child.stderr?.on("data", (chunk: string) => this.onOutput(server, live, chunk));

    child.on("error", (err: Error) => {
      this.append(server.id, live, `[capygen] spawn failed: ${err.message}`);
      this.transition(live, { status: "failed" });
    });

    child.on("exit", (code: number | null) => {
      this.flushPartial(server, live);
      const failed = !live.stopping && code !== null && code !== 0;
      this.transition(live, {
        status: failed ? "failed" : "stopped",
        ...(code !== null ? { exitCode: code } : {}),
        url: undefined,
        pid: undefined,
      });
      this.deps.log.info(`[servers] ${server.name} exited code=${String(code)}`);
    });

    void this.awaitReady(server, live);
    return run;
  }

  /**
   * Wait for the server to be usable. A URL printed on stdout wins outright
   * (it is the address the server *actually* bound); a declared port is probed
   * every 500 ms for up to 60 s behind it; a server that declares neither is
   * called running once it has simply survived `PORTLESS_RUNNING_MS`, because
   * there is nothing else to wait for.
   */
  private async awaitReady(server: DevServer, live: LiveRun): Promise<void> {
    const alive = (): boolean => this.runs.get(server.id) === live && !live.stopping;

    if (server.port === undefined) {
      await sleep(PORTLESS_RUNNING_MS);
      if (alive() && live.run.status === "starting") this.transition(live, { status: "running" });
      return;
    }

    const answered = await waitForPort(server.port, {
      ...(this.deps.probeWindowMs !== undefined ? { windowMs: this.deps.probeWindowMs } : {}),
      ...(this.deps.probeIntervalMs !== undefined ? { intervalMs: this.deps.probeIntervalMs } : {}),
      shouldStop: () => !alive(),
      ...(this.deps.probe ? { probe: this.deps.probe } : {}),
    });
    if (!alive()) return;
    if (answered) {
      const url = live.run.url ?? `http://localhost:${server.port}`;
      this.rememberUrl(server, url, server.port);
      this.transition(live, { status: "running", url });
      return;
    }
    // The window closed with nothing on the port. The process is still up, so
    // "running" is the honest status — it just has no URL to open.
    if (live.run.status === "starting") this.transition(live, { status: "running" });
  }

  async stop(args: { serverId: string }): Promise<DevServerRun> {
    const live = this.runs.get(args.serverId);
    if (!live) return { serverId: args.serverId, status: "stopped" };

    if (live.adopted) {
      // capygen never started this process, so it must never kill it: the
      // owner is somebody else's terminal (or another capygen window).
      this.runs.delete(args.serverId);
      const run: DevServerRun = { serverId: args.serverId, status: "stopped" };
      this.deps.broadcast("app.status", {
        level: "info",
        kind: "servers.detached",
        message:
          "capygen did not start that server, so nothing was killed — it detached from " +
          "the process already on the port.",
        ts: (this.deps.now ?? Date.now)(),
      });
      this.emit(run);
      return run;
    }

    live.stopping = true;
    const pid = live.child?.pid;
    if (pid !== undefined) {
      try {
        (this.deps.killTree ?? killProcessTree)(pid);
      } catch (err) {
        this.deps.log.warn(`[servers] tree kill ${pid}: ${(err as Error).message}`);
      }
    }
    // `child.kill()` is the *fallback*, not the primary: on Windows it stops
    // the shell and orphans everything below it, which is the opposite of what
    // stopping a dev server means. It only runs when there was no pid to kill
    // a tree from.
    if (pid === undefined) {
      try {
        live.child?.kill();
      } catch {
        /* already gone */
      }
    }
    const run: DevServerRun = { serverId: args.serverId, status: "stopped" };
    live.run = run;
    this.runs.delete(args.serverId);
    this.emit(run);
    return run;
  }

  async dispose(): Promise<void> {
    for (const serverId of [...this.runs.keys()]) await this.stop({ serverId });
  }

  // -------------------------------------------------------------------------

  private onOutput(server: DevServer, live: LiveRun, chunk: string): void {
    const text = live.partial + chunk;
    const lines = text.split(/\r?\n/);
    live.partial = lines.pop() ?? "";
    for (const line of lines) this.onLine(server, live, line);
    // A dev server that prints its banner without a trailing newline (a
    // progress line, a prompt) would otherwise never be scanned for a URL.
    if (live.partial.length > MAX_LOG_LINE_CHARS) {
      this.onLine(server, live, live.partial);
      live.partial = "";
    } else if (live.run.url === undefined && live.partial !== "") {
      this.maybeAdoptUrl(server, live, live.partial);
    }
  }

  private flushPartial(server: DevServer, live: LiveRun): void {
    if (live.partial === "") return;
    const line = live.partial;
    live.partial = "";
    this.onLine(server, live, line);
  }

  private onLine(server: DevServer, live: LiveRun, line: string): void {
    this.append(server.id, live, line);
    this.maybeAdoptUrl(server, live, line);
  }

  private maybeAdoptUrl(server: DevServer, live: LiveRun, line: string): void {
    if (live.run.url !== undefined && live.run.status === "running") return;
    const url = urlFromLogLine(line);
    if (!url) return;
    const port = portOfUrl(url) ?? server.port;
    this.rememberUrl(server, url, port);
    this.transition(live, { status: "running", url });
  }

  /** Write a discovered address back onto the definition, so the next
   *  `servers.list` (and the next app launch) already knows it. */
  private rememberUrl(server: DevServer, url: string, port: number | undefined): void {
    if (server.url === url && server.port === port) return;
    try {
      this.deps.store.devServers.update(server.id, {
        url,
        ...(port !== undefined ? { port } : {}),
      });
    } catch (err) {
      this.deps.log.warn(`[servers] could not persist ${url}: ${(err as Error).message}`);
    }
  }

  private append(serverId: string, live: LiveRun, raw: string): void {
    const line = raw.length > MAX_LOG_LINE_CHARS ? `${raw.slice(0, MAX_LOG_LINE_CHARS)}…` : raw;
    live.log.push(line);
    if (live.log.length > MAX_LOG_LINES) live.log.splice(0, live.log.length - MAX_LOG_LINES);
    this.deps.broadcast("servers.log", { serverId, line });
  }

  private transition(live: LiveRun, patch: Partial<DevServerRun>): void {
    const next: DevServerRun = { ...live.run, ...patch, serverId: live.run.serverId };
    // `undefined` in the patch clears the field rather than merging over it.
    if (patch.url === undefined && "url" in patch) delete next.url;
    if (patch.pid === undefined && "pid" in patch) delete next.pid;
    if (sameRun(live.run, next)) return;
    live.run = next;
    this.emit(next);
  }

  private emit(run: DevServerRun): void {
    this.deps.broadcast("servers.status", { run });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sameRun(a: DevServerRun, b: DevServerRun): boolean {
  return (
    a.status === b.status && a.url === b.url && a.pid === b.pid && a.exitCode === b.exitCode
  );
}

function portOfUrl(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.port === "") return parsed.protocol === "https:" ? 443 : 80;
    const port = Number(parsed.port);
    return Number.isInteger(port) ? port : undefined;
  } catch {
    return undefined;
  }
}

function toStringRecord(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") out[key] = value;
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Windows spawning, in two paths — because there is no single one that is
 * both correct and safe.
 *
 * A real executable (`node.exe`, `python.exe`, `docker.exe`) is spawned
 * **directly**, with the argv array. Node then applies MSVCRT quoting, which
 * is what the child's own parser expects, and nothing else gets a say. Routing
 * that through `cmd /c` instead would put *two* parsers in the path — cmd's
 * and the child's — and node escapes an embedded quote as `\"`, which cmd does
 * not understand: `node -e "process.exit(3)"` arrives mangled and the process
 * never runs.
 *
 * A `.cmd` / `.bat` shim (`npm`, `corepack`, `yarn`, `docker` on some installs)
 * has no choice: `CreateProcess` cannot execute a batch file, and since
 * CVE-2024-27980 Node refuses to try. Those go through
 * `cmd.exe /d /s /c "<line>"` with the line quoted here and
 * `windowsVerbatimArguments`, so node does not re-escape what has already been
 * escaped for cmd.
 *
 * `windowsHide` on both (CLAUDE.md: "spawn children with `windowsHide`").
 */
function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): ChildProcess {
  if (process.platform !== "win32") {
    return spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a tree kill reaches the children.
      detached: true,
    });
  }
  const resolved = resolveWindowsCommand(command, options.env);
  if (!resolved.needsShell) {
    return spawn(resolved.file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const comspec = options.env.ComSpec ?? process.env.ComSpec ?? "cmd.exe";
  const line = [resolved.file, ...args].map(quoteForCmd).join(" ");
  return spawn(comspec, ["/d", "/s", "/c", `"${line}"`], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Where a bare command name actually lives, and whether running it needs cmd.
 * `PATHEXT` is consulted in its own order, so a machine that prefers `.bat`
 * over `.cmd` gets what it configured.
 */
export function resolveWindowsCommand(
  command: string,
  env: Record<string, string | undefined> = process.env,
): { file: string; needsShell: boolean } {
  const shellExtensions = new Set([".cmd", ".bat"]);
  const named = path.extname(command).toLowerCase();
  if (named !== "" || command.includes("/") || command.includes("\\")) {
    return { file: command, needsShell: shellExtensions.has(named) };
  }
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext !== "");
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      try {
        if (!fs.existsSync(candidate)) continue;
      } catch {
        continue;
      }
      return { file: candidate, needsShell: shellExtensions.has(ext) };
    }
  }
  // Not on PATH at all: hand it to cmd, whose "is not recognized" message is
  // a better error than a bare ENOENT with no command name in it.
  return { file: command, needsShell: true };
}

/** Quote one token for a `cmd /c` command line. Empty or whitespace-bearing
 *  tokens are quoted; embedded quotes are doubled, which is what cmd expects. */
export function quoteForCmd(token: string): string {
  if (token === "") return '""';
  if (!/[\s"^&|<>()]/.test(token)) return token;
  return `"${token.replace(/"/g, '""')}"`;
}
