/**
 * `DevServerService` — start, discover, stop (SPEC R18, G6: "one click starts
 * it, shows status + log tail, and opens it in the browser pane").
 *
 * These tests spawn **real processes**: `tests/fixtures/servers/httpserver` is
 * a 20-line node http server that prints the URL it bound, exactly like a real
 * dev server does. Both discovery paths are exercised for real — the stdout
 * URL, and (with the banner suppressed) the port probe — because those two are
 * where a mocked child process would prove nothing.
 */
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DevServer, DevServerRun } from "@capygen/shared";
import {
  DevServerService,
  MAX_LOG_LINES,
  quoteForCmd,
  resolveWindowsCommand,
} from "../src/workspace/DevServerService.js";
import { parseNetstatListener, probePort, urlFromLogLine } from "../src/workspace/ports.js";
import { FIXTURES_DIR, makeHarness, sleep, waitFor, type Harness } from "./workspaceHarness.js";

const FIXTURE_SERVER = path.join(FIXTURES_DIR, "httpserver", "server.mjs");

let h: Harness;
let service: DevServerService;

/** An unused TCP port, by binding one and letting go. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function saveServer(input: Partial<DevServer> & { name: string }): DevServer {
  return h.store.devServers.create({
    projectId: h.projectId,
    server: {
      name: input.name,
      source: "custom",
      command: input.command ?? "node",
      args: input.args ?? [FIXTURE_SERVER],
      cwd: input.cwd ?? h.root,
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
    },
  });
}

function runs(): DevServerRun[] {
  return h.eventsOn("servers.status").map((e) => (e as { run: DevServerRun }).run);
}

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-srv-" });
  service = new DevServerService({
    store: h.store,
    broadcast: h.broadcast,
    log: h.log,
    probeWindowMs: 25_000,
    probeIntervalMs: 150,
  });
});

afterEach(async () => {
  await service.dispose();
  h.close();
});

describe("start → URL discovered on stdout", () => {
  it("goes starting → running with the URL the server printed", async () => {
    const server = saveServer({ name: "fixture (stdout)" });

    const first = await service.start({ serverId: server.id });
    expect(first.status).toBe("starting");
    expect(first.pid).toBeGreaterThan(0);

    const ready = await waitFor(() => runs().some((r) => r.status === "running" && !!r.url));
    expect(ready).toBe(true);

    const running = runs().find((r) => r.status === "running");
    expect(running?.url).toMatch(/^http:\/\/localhost:\d+\/?$/);

    // The address is written back onto the definition, so the next
    // `servers.list` (and the next launch) already knows it.
    const saved = h.store.devServers.get(server.id);
    expect(saved?.url).toBe(running?.url);
    expect(saved?.port).toBeGreaterThan(0);

    // ...and `servers.list` pairs the definition with the live run.
    const listed = service.list({ projectId: h.projectId });
    expect(listed[0]?.run?.status).toBe("running");
  }, 40_000);

  it("streams the output as servers.log lines and keeps them for servers.logs", async () => {
    const server = saveServer({ name: "fixture (logs)" });
    await service.start({ serverId: server.id });
    await waitFor(() => runs().some((r) => r.status === "running"));

    const lines = h.eventsOn("servers.log") as { serverId: string; line: string }[];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.serverId === server.id)).toBe(true);
    expect(lines.some((l) => l.line.includes("http://localhost:"))).toBe(true);

    const tailed = service.logs({ serverId: server.id, tail: 1 });
    expect(tailed.lines).toHaveLength(1);
    expect(service.logs({ serverId: server.id }).lines.length).toBeLessThanOrEqual(MAX_LOG_LINES);
  }, 40_000);
});

describe("start → port probe", () => {
  it("reaches running by probing the declared port when nothing prints a URL", async () => {
    const port = await freePort();
    const server = saveServer({
      name: "fixture (silent)",
      port,
      env: { CAPYGEN_FIXTURE_SILENT: "1" },
    });

    await service.start({ serverId: server.id });
    const ready = await waitFor(() => runs().some((r) => r.status === "running"));
    expect(ready).toBe(true);

    const running = runs().find((r) => r.status === "running");
    expect(running?.url).toBe(`http://localhost:${port}`);
    expect(await probePort(port)).toBe(true);
  }, 40_000);
});

describe("stop", () => {
  it("tree-kills the process so the port stops answering", async () => {
    const port = await freePort();
    const server = saveServer({
      name: "fixture (stop)",
      port,
      env: { CAPYGEN_FIXTURE_SILENT: "1" },
    });
    await service.start({ serverId: server.id });
    expect(await waitFor(() => runs().some((r) => r.status === "running"))).toBe(true);

    const stopped = await service.stop({ serverId: server.id });
    expect(stopped.status).toBe("stopped");

    // The spawn goes through `cmd.exe /c`, so the pid capygen holds is the
    // shell's — only a *tree* kill reaches the node process behind it.
    let stillAnswering = true;
    for (let attempt = 0; attempt < 60 && stillAnswering; attempt += 1) {
      stillAnswering = await probePort(port);
      if (stillAnswering) await sleep(250);
    }
    expect(stillAnswering).toBe(false);
    expect(service.list({ projectId: h.projectId })[0]?.run).toBeNull();
  }, 40_000);

  it("stopping something that was never started is not an error", async () => {
    const server = saveServer({ name: "never started" });
    await expect(service.stop({ serverId: server.id })).resolves.toEqual({
      serverId: server.id,
      status: "stopped",
    });
  });

  /**
   * A tree kill can *throw* (no `taskkill.exe`, a policy that blocks it), not
   * merely fail quietly. `stop()` still deletes the run and broadcasts
   * `status: "stopped"` as fact, so the direct `child.kill()` has to run
   * anyway — `TerminalService.kill()` has always done it unconditionally, and
   * this is that same rule.
   */
  it("still kills the child directly when the tree kill throws", async () => {
    let directKills = 0;
    const fakeChild = {
      pid: 31337,
      stdout: { on: () => undefined, setEncoding: () => undefined },
      stderr: { on: () => undefined, setEncoding: () => undefined },
      on: () => undefined,
      kill: () => {
        directKills += 1;
        return true;
      },
    };
    const service2 = new DevServerService({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      probe: async () => false,
      probeWindowMs: 10,
      probeIntervalMs: 5,
      spawnProcess: () => fakeChild as never,
      killTree: () => {
        throw new Error("taskkill.exe is not available");
      },
    });
    const server = saveServer({ name: "kill throws", port: 65_123 });
    await service2.start({ serverId: server.id });

    const stopped = await service2.stop({ serverId: server.id });
    expect(stopped.status).toBe("stopped");
    // The tree kill threw and was swallowed; the direct kill must still have
    // been attempted, or "stopped" is a claim about a process that is alive.
    expect(directKills).toBe(1);
  });
});

describe("port already in use", () => {
  it("adopts the running server, names the owning PID and offers its URL", async () => {
    const port = await freePort();
    const service2 = new DevServerService({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      probe: async (p) => p === port,
      listenerPid: () => 4242,
      // If this ever spawned, the test would hang rather than pass quietly.
      spawnProcess: () => {
        throw new Error("must not spawn when the port is already in use");
      },
    });
    const server = saveServer({ name: "taken", port });

    const run = await service2.start({ serverId: server.id });
    expect(run.status).toBe("running");
    expect(run.pid).toBe(4242);
    expect(run.url).toBe(`http://localhost:${port}`);

    const notice = h.eventsOn("app.status").at(-1) as { level: string; message: string };
    expect(notice.level).toBe("warn");
    expect(notice.message).toContain("PID 4242");
    expect(notice.message).toContain(String(port));
  });

  it("stopping an adopted server kills nothing — capygen did not start it", async () => {
    const port = await freePort();
    let killed = 0;
    const service2 = new DevServerService({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      probe: async () => true,
      listenerPid: () => 99,
      killTree: () => {
        killed += 1;
      },
    });
    const server = saveServer({ name: "adopted", port });
    await service2.start({ serverId: server.id });

    const stopped = await service2.stop({ serverId: server.id });
    expect(stopped.status).toBe("stopped");
    expect(killed).toBe(0);
    const notice = h.eventsOn("app.status").at(-1) as { kind: string };
    expect(notice.kind).toBe("servers.detached");
  });
});

describe("failure", () => {
  it("an exit with a non-zero code is failed, with the code", async () => {
    const server = saveServer({
      name: "exits 3",
      command: "node",
      args: ["-e", "process.exit(3)"],
    });
    await service.start({ serverId: server.id });
    expect(await waitFor(() => runs().some((r) => r.status === "failed"))).toBe(true);
    expect(runs().find((r) => r.status === "failed")?.exitCode).toBe(3);
  }, 30_000);

  it("an unknown server id throws rather than starting nothing quietly", async () => {
    await expect(service.start({ serverId: "srv_missing" })).rejects.toThrow(
      /unknown dev server/,
    );
  });
});

describe("helpers", () => {
  it("urlFromLogLine finds the address in a real banner and normalises binds", () => {
    expect(urlFromLogLine("  ➜  Local:   http://localhost:5173/")).toBe("http://localhost:5173/");
    expect(urlFromLogLine("Listening on http://0.0.0.0:3000")).toBe("http://localhost:3000");
    expect(urlFromLogLine("ready in 421 ms")).toBeNull();
  });

  it("parseNetstatListener matches the exact port, not a suffix", () => {
    const output = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:13000          0.0.0.0:0              LISTENING       111",
      "  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       222",
      "  TCP    127.0.0.1:3000         127.0.0.1:5000         ESTABLISHED     333",
    ].join("\n");
    expect(parseNetstatListener(output, 3000)).toBe(222);
    expect(parseNetstatListener(output, 9999)).toBeNull();
  });

  it("resolveWindowsCommand sends a .exe straight to CreateProcess and a .cmd to cmd", () => {
    const env = { PATH: "C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    // A named extension answers without touching the disk.
    expect(resolveWindowsCommand("node.exe", env)).toEqual({
      file: "node.exe",
      needsShell: false,
    });
    expect(resolveWindowsCommand("C:\\x\\npm.cmd", env)).toEqual({
      file: "C:\\x\\npm.cmd",
      needsShell: true,
    });
    // Nothing on this PATH: cmd's own "is not recognized" beats a bare ENOENT.
    expect(resolveWindowsCommand("definitely-not-installed", env)).toEqual({
      file: "definitely-not-installed",
      needsShell: true,
    });
    // ...and the real `node` on the real PATH is found as an executable, which
    // is what keeps `node -e "process.exit(3)"` from being mangled by cmd.
    if (process.platform === "win32") {
      const resolved = resolveWindowsCommand("node");
      expect(resolved.needsShell).toBe(false);
      expect(resolved.file.toLowerCase()).toContain("node.exe");
    }
  });

  it("quoteForCmd quotes what cmd would otherwise split", () => {
    expect(quoteForCmd("node")).toBe("node");
    expect(quoteForCmd("C:\\Program Files\\node.exe")).toBe('"C:\\Program Files\\node.exe"');
    expect(quoteForCmd("")).toBe('""');
    expect(quoteForCmd("a&b")).toBe('"a&b"');
  });
});
