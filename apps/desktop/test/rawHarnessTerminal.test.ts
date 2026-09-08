import { describe, expect, it, vi } from "vitest";
import { TerminalService, type PtyLike } from "../src/workspace/TerminalService.js";
import { rawHarnessShellArgs } from "../src/workspace/rawHarnessTerminal.js";
import { makeHarness } from "./workspaceHarness.js";

describe("raw CLI attachment", () => {
  it("opens a dedicated named PTY with one literal command path instead of writing into a running terminal", async () => {
    const h = makeHarness({ prefix: "capygen-raw-terminal-" });
    const write = vi.fn();
    const pty: PtyLike = { pid: 42, onData() {}, onExit() {}, write, resize() {}, kill() {} };
    const spawnPty = vi.fn(() => pty);
    const service = new TerminalService({
      store: h.store, broadcast: h.broadcast, log: h.log, spawnPty: () => spawnPty,
      resolveShell: () => "powershell.exe", killTree() {},
      env: () => ({ CODEX_HOME: "C:\\isolated fixture", PYTHONUTF8: "1" }),
      resolveHarnessCommand: () => "C:\\O'Brien café\\codex.exe",
    });
    try {
      const info = await service.attach({ projectId: h.projectId, sessionId: null, backend: "codex", cols: 80, rows: 24 });
      expect(info.title).toBe("codex CLI");
      expect(spawnPty).toHaveBeenCalledWith("powershell.exe", ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "& 'C:\\O''Brien café\\codex.exe'"], expect.objectContaining({ cwd: h.root, env: { CODEX_HOME: "C:\\isolated fixture", PYTHONUTF8: "1" }, useConpty: true }));
      expect(write).not.toHaveBeenCalled();
    } finally { await service.dispose(); h.close(); }
  });

  it("does not evaluate PowerShell metacharacters inside the executable path", () => {
    expect(rawHarnessShellArgs("pwsh.exe", "C:\\$(echo surprise);`x'\\claude.cmd").at(-1))
      .toBe("& 'C:\\$(echo surprise);`x''\\claude.cmd'");
    expect(() => rawHarnessShellArgs("powershell.exe", "claude\r\necho bad")).toThrow();
  });
});
