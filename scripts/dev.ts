/**
 * `corepack pnpm dev` — Vite dev server + Electron pointed at it.
 *
 * Order matters: the main bundle is rebuilt first (Electron loads
 * dist/main.cjs, not the TypeScript), then Vite is started and polled until it
 * answers, then Electron launches with CAPYGEN_DEV_URL set so it loads the dev
 * server instead of the built index.html. Killing this script kills both.
 *
 * The renderer hot-reloads; changing main or preload needs a restart.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEV_URL = "http://localhost:5273";
const children: ChildProcess[] = [];

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    // Windows: pnpm/electron resolve through .CMD shims, which need a shell.
    shell: process.platform === "win32",
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, ...options.env },
  });
  children.push(child);
  return child;
}

function shutdown(code = 0): never {
  for (const child of children) {
    if (child.pid && child.exitCode === null) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        /* already gone */
      }
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok || res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await delay(250);
  }
  throw new Error(`dev server did not answer at ${url} within ${timeoutMs}ms`);
}

console.log("[dev] building main + preload…");
await new Promise<void>((resolve, reject) => {
  const build = run("corepack", ["pnpm", "--filter", "@capygen/desktop", "build"]);
  build.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error(`desktop build failed (${code})`)),
  );
});

console.log("[dev] starting vite…");
run("corepack", ["pnpm", "--filter", "@capygen/renderer", "dev"]);
await waitForServer(DEV_URL);

console.log(`[dev] starting electron against ${DEV_URL}`);
const electron = run("corepack", ["pnpm", "--dir", "apps/desktop", "exec", "electron", "."], {
  env: { CAPYGEN_DEV_URL: DEV_URL },
});
electron.on("exit", (code) => shutdown(code ?? 0));
