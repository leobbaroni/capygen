import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationService } from "../src/workspace/DictationService.js";
import { speechProcess, transcribeWav, validateCapturedWav } from "../src/workspace/WhisperDictation.js";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

function child() {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValueOnce(process as unknown as ChildProcess);
  return process;
}
function wav(): Buffer {
  const audio = Buffer.alloc(44 + 16000);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}

describe("local Whisper boundary", () => {
  it("refuses malformed or unbounded WAV data before starting inference", async () => {
    expect(() => validateCapturedWav(wav())).not.toThrow();
    const invalid = wav(); invalid.writeUInt32LE(48000, 24);
    await expect(transcribeWav("C:\\test speech", invalid, new AbortController().signal)).rejects.toThrow("No usable");
    expect(() => validateCapturedWav(Buffer.alloc(800046))).toThrow();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("pipes PCM to local inference and returns Unicode text without shell or output files", async () => {
    vi.stubEnv("WHISPER_ARG_DEVICE", "untrusted-device");
    const process = child();
    const audio = wav();
    const pending = transcribeWav("C:\\test speech", audio, new AbortController().signal);
    expect(process.stdin.read()).toEqual(audio);
    expect(process.stdin.writableEnded).toBe(true);
    const [file, args, options] = vi.mocked(spawn).mock.calls[0]!;
    expect(file).toContain("whisper-cli.exe");
    expect(args).toEqual(expect.arrayContaining(["-l", "auto", "-f", "-"]));
    expect(args?.slice(-2)).toEqual(["-of", "capygen-stdout"]);
    expect(args).not.toContain("-otxt");
    expect(options).toMatchObject({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    expect(options?.shell).toBeUndefined();
    expect(options?.env?.WHISPER_ARG_DEVICE).toBeUndefined();
    process.stdout.write(Buffer.from("Olá, run the tests.\n")); process.emit("close", 0);
    expect(await pending).toBe("Olá, run the tests.");
  });

  it("keeps capture stdin open and terminates it on cancellation", async () => {
    const process = child(); const controller = new AbortController();
    const pending = speechProcess("C:\\speech.exe", [], Buffer.from('{"command":"capture"}\n'), controller.signal,
      { capture: true, timeout: 30000, maxOutput: 800044 });
    expect(process.stdin.writableEnded).toBe(false);
    const assertion = expect(pending).rejects.toThrow("cancelled");
    controller.abort(); await assertion;
    expect(process.kill).toHaveBeenCalledOnce();
    expect(process.stdin.writableEnded).toBe(true);
  });

  it("terminates inference on timeout or excessive output", async () => {
    vi.useFakeTimers();
    const timed = child();
    const timeout = speechProcess("C:\\speech.exe", [], Buffer.alloc(0), new AbortController().signal, { timeout: 100, maxOutput: 64 });
    const timedAssertion = expect(timeout).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100); await timedAssertion;
    expect(timed.kill).toHaveBeenCalledOnce();
    const noisy = child();
    const bounded = speechProcess("C:\\speech.exe", [], Buffer.alloc(0), new AbortController().signal, { timeout: 100, maxOutput: 64 });
    const boundedAssertion = expect(bounded).rejects.toThrow("Oversized");
    noisy.stdout.write(Buffer.alloc(65)); await boundedAssertion;
    expect(noisy.kill).toHaveBeenCalledOnce();
  });

  it("never downloads during availability and runs installation only after exact-command confirmation", async () => {
    const confirm = vi.fn(async (_options: unknown) => false); const openConsole = vi.fn(async (_argv: unknown) => ({ pid: 42 }));
    const service = new DictationService({ platform: "win32", whisperDirectory: "C:\\isolated nonexistent speech's folder",
      installScript: "C:\\owned app\\install-whisper.ps1", confirm, openConsole });
    expect(await service.availability()).toMatchObject({ available: false, setupAvailable: true, languages: [] });
    expect(confirm).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    expect(await service.setup()).toEqual({ ok: false }); expect(openConsole).not.toHaveBeenCalled();
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ detail: expect.stringContaining("-Destination 'C:\\isolated nonexistent speech''s folder'") });
    confirm.mockResolvedValueOnce(true);
    expect(await service.setup()).toEqual({ ok: true }); expect(openConsole).toHaveBeenCalledOnce();
    expect(openConsole.mock.calls[0]?.[0]).toMatchObject({ file: "powershell.exe", args: expect.arrayContaining(["-NoExit"]) });
    service.dispose(); await service.setup(); expect(openConsole).toHaveBeenCalledOnce();
  });
});
