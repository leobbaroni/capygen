/** Pinned, explicitly installed local recognition; PCM never reaches disk or renderer. */
import fs from "node:fs";
import path from "node:path";
import { availableParallelism } from "node:os";
import { spawn } from "node:child_process";
import { cleanEnv } from "@capygen/engine";

export const WHISPER_REVISION = "b4938-small-q5_1";
export function whisperPaths(directory: string) {
  const root = path.join(directory, WHISPER_REVISION);
  return { root, executable: path.join(root, "whisper-cli.exe"), model: path.join(root, "ggml-small-q5_1.bin"), marker: path.join(root, "installed.txt") };
}
export function whisperInstalled(directory: string): boolean {
  try {
    const files = whisperPaths(directory);
    return fs.readFileSync(files.marker, "utf8").trim() === WHISPER_REVISION &&
      fs.statSync(files.executable).isFile() && fs.statSync(files.model).size === 190085487;
  } catch { return false; }
}

/** Bounded subprocess transport. Capture owns an open stdin until exit so parent death
 * releases the device; inference reads the owned WAV from stdin through EOF. */
export function speechProcess(file: string, args: string[], input: Buffer, signal: AbortSignal, options: {
  capture?: boolean; timeout: number; maxOutput: number;
}): Promise<Buffer> {
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise((resolve, reject) => {
    const env = cleanEnv(process.env);
    for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("WHISPER_")) delete env[key];
    const child = spawn(file, args, { cwd: path.dirname(file), windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
    let settled = false; let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      child.stdin.end();
      if (error) { child.kill(); reject(error); } else resolve(Buffer.concat(chunks));
    };
    const abort = () => finish(new Error("cancelled"));
    const timer = setTimeout(() => finish(new Error("Local speech timed out")), options.timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxOutput) { finish(new Error("Oversized local speech output")); return; }
      chunks.push(chunk);
    });
    child.stderr.resume(); // No audio, transcripts, or native diagnostics in logs.
    child.on("error", () => finish(new Error("Local speech process unavailable")));
    child.stdin.on("error", () => finish(new Error("Local speech input failed")));
    child.on("close", code => finish(code === 0 ? undefined : new Error("Local speech failed")));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    if (options.capture) child.stdin.write(input); else child.stdin.end(input);
  });
}

export function validateCapturedWav(audio: Buffer): void {
  if (audio.length < 44 + 8000 || audio.length > 800044 || audio.toString("ascii", 0, 4) !== "RIFF" ||
      audio.toString("ascii", 8, 16) !== "WAVEfmt " || audio.readUInt32LE(16) !== 16 ||
      audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000 ||
      audio.readUInt32LE(28) !== 32000 || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16 ||
      audio.toString("ascii", 36, 40) !== "data" || audio.readUInt32LE(40) !== audio.length - 44 ||
      audio.readUInt32LE(4) !== audio.length - 8 || audio.length % 2 !== 0) throw new Error("No usable microphone audio");
}

export async function transcribeWav(directory: string, audio: Buffer, signal: AbortSignal): Promise<string> {
  validateCapturedWav(audio);
  const files = whisperPaths(directory);
  // b4938 disables the segment stdout callback when the inferred output name is
  // "-"; its explicit stdout-file mode opens Windows CON instead of the pipe.
  // A nominal output name enables the callback. No output-format flag is set,
  // so the CLI opens no output file and the transcript stays on the stdout pipe.
  // Bound CPU use and leave capacity for Electron. The native default is four;
  // twelve reduced the same local sample from 7.7s to 4.6s on an 8-core host.
  const threads = Math.max(1, Math.min(12, availableParallelism() - 2));
  const output = await speechProcess(files.executable, ["-m", files.model, "-l", "auto", "-nt", "-np", "-ng", "-sns", "-t", String(threads), "-f", "-", "-of", "capygen-stdout"], audio, signal,
    { timeout: 120_000, maxOutput: 64 * 1024 });
  const text = output.toString("utf8").trim();
  if (text.length > 16000 || text.includes("\uFFFD")) throw new Error("Invalid local transcript");
  return text;
}

export async function recognizeWhisper(directory: string, helper: string, signal: AbortSignal, onTranscribing?: () => void): Promise<string> {
  if (!whisperInstalled(directory)) throw new Error("Install local speech first");
  const audio = await speechProcess(helper, [], Buffer.from('{"command":"capture"}\n'), signal,
    { capture: true, timeout: 30_000, maxOutput: 800044 });
  try { onTranscribing?.(); return await transcribeWav(directory, audio, signal); }
  finally { audio.fill(0); }
}
