/**
 * `TerminalService` (SPEC R16).
 *
 * Two halves, on purpose:
 *
 *   - the *coalescing, registry and kill* logic runs against a fake pty, so it
 *     is deterministic and fast;
 *   - one test spawns a **real** node-pty and reads a real `echo` back,
 *     because that is the only thing that proves the native module loads in
 *     this runtime at all (docs/adr/0005-terminal-node-pty.md measured it in
 *     Electron 44 and Node 22.16; this keeps it measured). It skips with a
 *     printed reason where there is no ConPTY (non-Windows CI, an old build
 *     agent), rather than silently passing.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OUTPUT_FLUSH_MS,
  TerminalService,
  resolveDefaultShell,
  shellArgs,
  type PtyLike,
  type PtySpawner,
} from "../src/workspace/TerminalService.js";
import { makeHarness, sleep, waitFor, type Harness } from "./workspaceHarness.js";

/** A pty double: records what was written, and lets a test push output back. */
class FakePty implements PtyLike {
  readonly pid = 4321;
  readonly written: string[] = [];
  resized: [number, number] | null = null;
  killed = false;
  private data: ((d: string) => void) | null = null;
  private exit: ((e: { exitCode: number }) => void) | null = null;

  onData(listener: (data: string) => void): void {
    this.data = listener;
  }
  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exit = listener;
  }
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resized = [cols, rows];
  }
  kill(): void {
    this.killed = true;
  }
  emit(data: string): void {
    this.data?.(data);
  }
  finish(exitCode: number): void {
    this.exit?.({ exitCode });
  }
}

let h: Harness;
let fake: FakePty;
let service: TerminalService;
let killedPids: number[];

beforeEach(() => {
  h = makeHarness({ prefix: "capygen-term-" });
  fake = new FakePty();
  killedPids = [];
  const spawner: PtySpawner = () => fake;
  service = new TerminalService({
    store: h.store,
    broadcast: h.broadcast,
    log: h.log,
    spawnPty: () => spawner,
    resolveShell: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    env: () => ({ TERM: "xterm-256color" }),
    killTree: (pid) => void killedPids.push(pid),
  });
});

afterEach(async () => {
  await service.dispose();
  h.close();
});

describe("create / list", () => {
  it("returns the shell, the project cwd and the requested size", async () => {
    const info = await service.create({
      projectId: h.projectId,
      sessionId: null,
      cols: 100,
      rows: 30,
    });
    expect(info.id.startsWith("term_")).toBe(true);
    expect(info.cwd).toBe(h.root);
    expect(info.title).toBe("powershell.exe");
    expect([info.cols, info.rows]).toEqual([100, 30]);
    expect(service.list({ projectId: h.projectId })).toEqual([info]);
  });

  it("refuses a cwd outside the project", async () => {
    await expect(
      service.create({ projectId: h.projectId, sessionId: null, cwd: "../..", cols: 80, rows: 24 }),
    ).rejects.toThrow(/escapes/);
  });

  it("lists only this project's terminals", async () => {
    const other = h.store.projects.upsertByPath({ path: path.join(h.dir, "other") });
    const mine = await service.create({ projectId: h.projectId, sessionId: null, cols: 80, rows: 24 });
    expect(service.list({ projectId: other.id })).toEqual([]);
    expect(service.list({ projectId: h.projectId }).map((t) => t.id)).toEqual([mine.id]);
  });
});

describe("data flow", () => {
  it("coalesces output into one debounced terminal.data event", async () => {
    const info = await service.create({ projectId: h.projectId, sessionId: null, cols: 80, rows: 24 });
    fake.emit("PS ");
    fake.emit("C:\\> ");
    expect(h.eventsOn("terminal.data")).toHaveLength(0);

    await sleep(OUTPUT_FLUSH_MS + 40);
    expect(h.eventsOn("terminal.data")).toEqual([{ id: info.id, data: "PS C:\\> " }]);
  });

  it("passes keystrokes straight through and resizes", async () => {
    const info = await service.create({ projectId: h.projectId, sessionId: null, cols: 80, rows: 24 });
    expect(service.write({ id: info.id, data: "ls\r" })).toEqual({ ok: true });
    expect(fake.written).toEqual(["ls\r"]);

    expect(service.resize({ id: info.id, cols: 120, rows: 40 })).toEqual({ ok: true });
    expect(fake.resized).toEqual([120, 40]);
    expect(service.list({ projectId: h.projectId })[0]?.cols).toBe(120);
  });

  it("a write to an unknown terminal is a false, not a throw", () => {
    expect(service.write({ id: "term_gone", data: "x" })).toEqual({ ok: false });
    expect(service.resize({ id: "term_gone", cols: 1, rows: 1 })).toEqual({ ok: false });
    expect(service.kill({ id: "term_gone" })).toEqual({ ok: false });
  });

  it("an exit flushes what was buffered, then reports the code", async () => {
    const info = await service.create({ projectId: h.projectId, sessionId: null, cols: 80, rows: 24 });
    fake.emit("goodbye");
    fake.finish(0);

    expect(h.eventsOn("terminal.data")).toEqual([{ id: info.id, data: "goodbye" }]);
    expect(h.eventsOn("terminal.exit")).toEqual([{ id: info.id, exitCode: 0 }]);
    expect(service.list({ projectId: h.projectId })).toEqual([]);
  });
});

describe("kill", () => {
  it("tree-kills and reports a null exit code (killed, not exited)", async () => {
    const info = await service.create({ projectId: h.projectId, sessionId: null, cols: 80, rows: 24 });
    expect(service.kill({ id: info.id })).toEqual({ ok: true });

    expect(killedPids).toEqual([fake.pid]);
    expect(fake.killed).toBe(true);
    expect(h.eventsOn("terminal.exit")).toEqual([{ id: info.id, exitCode: null }]);
    expect(service.list({ projectId: h.projectId })).toEqual([]);
  });

  it("dispose kills everything it still holds", async () => {
    await service.create({ projectId: h.projectId, sessionId: null, cols: 80, rows: 24 });
    await service.dispose();
    expect(killedPids).toEqual([fake.pid]);
    expect(service.list({ projectId: h.projectId })).toEqual([]);
  });
});

describe("shell resolution", () => {
  it("prefers pwsh.exe when it is on PATH", () => {
    // A PATH entry that cannot contain pwsh falls through to Windows PowerShell.
    const shell = resolveDefaultShell({ PATH: "", SystemRoot: "C:\\Windows" });
    expect(shell.toLowerCase()).toContain("powershell.exe");
  });

  it("passes -NoLogo to either PowerShell and nothing to another shell", () => {
    expect(shellArgs("C:\\x\\pwsh.exe")).toEqual(["-NoLogo"]);
    expect(shellArgs("C:\\x\\powershell.exe")).toEqual(["-NoLogo"]);
    expect(shellArgs("C:\\x\\cmd.exe")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------

const REAL_PTY = process.platform === "win32";

describe.skipIf(!REAL_PTY)("a real node-pty (ConPTY)", () => {
  it("spawns cmd, echoes a marker back, and exits", async () => {
    const real = new TerminalService({
      store: h.store,
      broadcast: h.broadcast,
      log: h.log,
      // The real node-pty, loaded the way the app loads it — this is the
      // regression check behind ADR-0005's "no rebuild needed" claim.
      resolveShell: () => process.env.ComSpec ?? "cmd.exe",
    });
    const info = await real.create({
      projectId: h.projectId,
      sessionId: null,
      cols: 80,
      rows: 24,
    });
    expect(info.shell.toLowerCase()).toContain("cmd.exe");

    real.write({ id: info.id, data: "echo capygen-terminal-ok\r\n" });
    const saw = await waitFor(() =>
      (h.eventsOn("terminal.data") as { data: string }[])
        .map((e) => e.data)
        .join("")
        .includes("capygen-terminal-ok"),
    );
    expect(saw).toBe(true);

    real.write({ id: info.id, data: "exit\r\n" });
    expect(await waitFor(() => h.eventsOn("terminal.exit").length > 0)).toBe(true);
    await real.dispose();
  }, 30_000);
});

if (!REAL_PTY) {
  // Not a silent skip: the reason is printed, per SPEC's "never swallow".
  console.warn("[workspaceTerminal] real node-pty test skipped: ConPTY is Windows-only");
}
