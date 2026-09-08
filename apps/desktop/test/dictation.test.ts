import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationService, runWindowsSpeech } from "../src/workspace/DictationService.js";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("local dictation", () => {
  it("uses a read-only availability script and reports unsupported platforms without starting anything", async () => {
    const run = vi.fn(async () => JSON.stringify({ available: true, languages: ["en-US"] }));
    const service = new DictationService({ platform: "win32", run });
    expect(await service.availability()).toEqual({ available: true, languages: ["en-US"], message: null });
    run.mockClear();
    expect((await new DictationService({ platform: "linux", run }).recognize("en-GB")).error).toBeTruthy();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns a Unicode phrase and rejects oversized or invalid output with a safe message", async () => {
    const run = vi.fn().mockResolvedValueOnce('{"text":"  Olá, café!  "}')
      .mockResolvedValueOnce(JSON.stringify({ text: "x".repeat(16_001) }))
      .mockRejectedValueOnce(new Error("private machine path or diagnostic"));
    const service = new DictationService({ platform: "win32", run });
    expect(await service.recognize("en-GB")).toEqual({ text: "Olá, café!", error: null, cancelled: false });
    expect((await service.recognize("en-GB")).text).toBe("");
    expect(JSON.stringify(await service.recognize("en-GB"))).not.toContain("private machine");
  });

  it("allows one recording and discards a late transcript after cancel/disposal", async () => {
    let resolve!: (text: string) => void;
    let signal!: AbortSignal;
    const run = vi.fn((_mode, captureSignal: AbortSignal) => {
      signal = captureSignal;
      return new Promise<string>(done => { resolve = done; });
    });
    const service = new DictationService({ platform: "win32", run });
    const recording = service.recognize("en-GB");
    expect((await service.recognize("en-GB")).error).toMatch(/already listening/);
    expect(service.cancel()).toEqual({ ok: true });
    expect(signal.aborted).toBe(true);
    resolve('{"text":"late phrase"}');
    expect(await recording).toEqual({ text: "", error: null, cancelled: true });
    service.dispose();
    await service.recognize("en-GB");
    expect(run).toHaveBeenCalledOnce();
  });

  it("spawns the compiled helper without a shell, sends bounded NDJSON, and closes it on cancellation", async () => {
    vi.stubEnv("CLAUDECODE", "nested");
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcess);
    const controller = new AbortController();
    const pending = runWindowsSpeech("recognize", controller.signal, "en-GB", "C:\\app\\speech.exe");
    const rejected = expect(pending).rejects.toThrow("cancelled");
    expect(child.stdin.read().toString()).toBe('{"command":"recognize","language":"en-GB"}\n');
    expect(child.stdin.writableEnded).toBe(false);
    expect(spawn).toHaveBeenCalledWith("C:\\app\\speech.exe", [], expect.objectContaining({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: expect.objectContaining({ PYTHONUTF8: "1" }) }));
    const options = vi.mocked(spawn).mock.calls[0]?.[2];
    expect(options?.env?.CLAUDECODE).toBeUndefined();
    controller.abort();
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdin.writableEnded).toBe(true);
  });
});
