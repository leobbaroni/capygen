/**
 * Port probing and "who already owns this port?", for the Servers pane.
 *
 * Two jobs, both Windows-shaped:
 *
 *   - `probePort` is how a start decides a server is actually *up*. A dev
 *     server prints its banner before it binds as often as after, so the
 *     honest signal is a TCP connect that succeeds, not a log line.
 *   - `findListenerPid` answers "port 3000 is taken — by what?". Reporting a
 *     bare EADDRINUSE leaves the user to open a terminal and run `netstat`
 *     themselves; reporting the PID (and offering the URL that is already
 *     answering) is the difference between an error and an answer.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";

/** How long one connect attempt waits before calling the port closed. */
export const PROBE_TIMEOUT_MS = 500;
/** Gap between probes while waiting for a starting server (R23: bounded). */
export const PROBE_INTERVAL_MS = 500;
/** Total time a start waits for its port to answer before giving up. */
export const PROBE_WINDOW_MS = 60_000;

/** True when something accepts a TCP connection on `port` right now. */
export function probePort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Poll until the port answers or the window closes. `shouldStop` lets the
 * caller abandon the wait the moment the child process dies — otherwise a
 * server that crashed on line one keeps the pane on "starting" for a minute.
 */
export async function waitForPort(
  port: number,
  options: {
    windowMs?: number;
    intervalMs?: number;
    shouldStop?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    probe?: (port: number) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const windowMs = options.windowMs ?? PROBE_WINDOW_MS;
  const intervalMs = options.intervalMs ?? PROBE_INTERVAL_MS;
  const probe = options.probe ?? probePort;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    if (options.shouldStop?.()) return false;
    if (await probe(port)) return true;
    await sleep(intervalMs);
  }
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * The PID listening on `port`, or `null`.
 *
 * `netstat -ano` rather than a native call: it ships with Windows, needs no
 * elevation for the PID column, and its output format has been stable for two
 * decades. Lines look like
 *
 *     TCP    0.0.0.0:3000     0.0.0.0:0     LISTENING       12345
 *
 * and the local-address column is matched on its `:port` suffix so `13000`
 * cannot answer for `3000`.
 */
export function findListenerPid(
  port: number,
  run: (cmd: string, args: string[]) => string | null = defaultNetstat,
): number | null {
  if (process.platform !== "win32") return null;
  const output = run("netstat", ["-ano", "-p", "tcp"]);
  if (!output) return null;
  return parseNetstatListener(output, port);
}

export function parseNetstatListener(output: string, port: number): number | null {
  const suffix = `:${port}`;
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const [proto, local, , state, pid] = parts;
    if (!proto || !local || !pid) continue;
    if (!proto.toUpperCase().startsWith("TCP")) continue;
    if ((state ?? "").toUpperCase() !== "LISTENING") continue;
    if (!local.endsWith(suffix)) continue;
    const parsed = Number(pid);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function defaultNetstat(cmd: string, args: string[]): string | null {
  try {
    const result = spawnSync(cmd, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    });
    return result.stdout ?? null;
  } catch {
    return null;
  }
}

/**
 * The first http(s) URL a dev server printed. Trailing punctuation is stripped
 * because banners write `Local:   http://localhost:5173/` and ANSI-styled
 * output leaves stray escapes around it.
 */
export function urlFromLogLine(line: string): string | null {
  // eslint-disable-next-line no-control-regex -- stripping ANSI is the point
  const plain = line.replace(/\[[0-9;]*[A-Za-z]/g, "");
  const match = /https?:\/\/[^\s"'<>()\\]+/.exec(plain);
  if (!match) return null;
  const url = match[0].replace(/[.,;:]+$/, "");
  // `0.0.0.0` is a bind address, not something a browser can open.
  return url.replace("://0.0.0.0", "://localhost").replace("://[::]", "://localhost");
}
