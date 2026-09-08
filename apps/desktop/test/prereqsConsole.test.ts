import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { defaultOpenConsole } from "../src/prereqs/electronDefaults.js";
const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn, execFile: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); spawn.mockReset(); });

it("waits for native spawn, cleans nested session env and reports async launch failure", async () => {
  vi.stubEnv("CLAUDECODE", "1");
  const child = Object.assign(new EventEmitter(), { pid: 42, unref: vi.fn() });
  spawn.mockReturnValue(child);
  const pending = defaultOpenConsole({ file: "powershell.exe", args: ["-NoProfile"] });
  expect(child.unref).not.toHaveBeenCalled();
  expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true, windowsHide: false, env: { PYTHONUTF8: "1" } });
  expect(spawn.mock.calls[0]?.[2].env.CLAUDECODE).toBeUndefined();
  child.emit("spawn");
  await expect(pending).resolves.toEqual({ pid: 42 });
  expect(child.unref).toHaveBeenCalledOnce();
  const failed = defaultOpenConsole({ file: "missing.exe", args: [] });
  child.emit("error", new Error("ENOENT"));
  await expect(failed).rejects.toThrow("Could not open the setup console");
});
