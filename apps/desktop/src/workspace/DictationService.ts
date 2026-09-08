/** Local Windows .NET speech recognition. No cloud service, audio file, or model context. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { cleanEnv } from "@capygen/engine";

export interface DictationAvailability {
  available: boolean;
  languages: string[];
  message: string | null;
}
export interface DictationResult { text: string; error: string | null; cancelled: boolean }
type SpeechMode = "availability" | "recognize";
export interface DictationServiceDeps {
  platform?: NodeJS.Platform;
  /** Test seam: never open the microphone from a test. */
  run?: (mode: SpeechMode, signal: AbortSignal, language?: string) => Promise<string>;
  helperPath?: string;
}

const UNAVAILABLE = "Local Windows Speech is unavailable. Check installed speech languages and desktop microphone access in Windows Settings.";
const FAILED = "Could not hear a phrase. Check your microphone and Windows desktop microphone permission, then try again.";
const MAX_TEXT = 16_000;

/** The caller must invoke recognize only after an explicit mic-button action.
 * Windows controls device access; this does not bypass OS microphone settings.
 * Cancel/dispose discards late transcripts and kills the recognition subprocess. */
export class DictationService {
  private active: AbortController | null = null;
  private readonly probes = new Set<AbortController>();
  private disposed = false;
  constructor(private readonly deps: DictationServiceDeps = {}) {}

  async availability(): Promise<DictationAvailability> {
    if (this.disposed || (this.deps.platform ?? process.platform) !== "win32") {
      return { available: false, languages: [], message: UNAVAILABLE };
    }
    const controller = new AbortController();
    this.probes.add(controller);
    try {
      const result = parseResult(await this.run("availability", controller.signal));
      if (controller.signal.aborted) throw new Error("cancelled");
      const languages = Array.isArray(result.languages)
        ? result.languages.filter((v): v is string => typeof v === "string" && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(v)).slice(0, 64)
        : [];
      const available = result.available === true && languages.length > 0;
      return { available, languages, message: available ? null : UNAVAILABLE };
    } catch {
      return { available: false, languages: [], message: UNAVAILABLE };
    } finally {
      this.probes.delete(controller);
    }
  }

  async recognize(language: string): Promise<DictationResult> {
    if (this.disposed || (this.deps.platform ?? process.platform) !== "win32") {
      return { text: "", error: UNAVAILABLE, cancelled: false };
    }
    if (!/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(language)) return { text: "", error: "Choose an installed speech language.", cancelled: false };
    if (this.active) return { text: "", error: "Dictation is already listening.", cancelled: false };
    const controller = new AbortController();
    this.active = controller;
    try {
      const result = parseResult(await this.run("recognize", controller.signal, language));
      if (controller.signal.aborted) return { text: "", error: null, cancelled: true };
      if (result.error === "no_recognizer") return { text: "", error: "The selected speech language is not installed. Choose an available language.", cancelled: false };
      if (typeof result.text !== "string" || result.text.length > MAX_TEXT || result.error) {
        return { text: "", error: FAILED, cancelled: false };
      }
      const text = result.text.trim();
      return { text, error: text ? null : "No speech was recognized. Try again.", cancelled: false };
    } catch {
      return { text: "", error: controller.signal.aborted ? null : FAILED, cancelled: controller.signal.aborted };
    } finally {
      if (this.active === controller) this.active = null;
    }
  }

  cancel(): { ok: boolean } {
    const active = this.active;
    active?.abort();
    return { ok: active !== null };
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    for (const probe of this.probes) probe.abort();
  }

  private run(mode: SpeechMode, signal: AbortSignal, language?: string): Promise<string> {
    return this.deps.run ? this.deps.run(mode, signal, language) : runWindowsSpeech(mode, signal, language, this.deps.helperPath);
  }
}

function parseResult(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("Oversized speech output");
  const result: unknown = JSON.parse(raw.replace(/^\uFEFF/, "").trim());
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid speech output");
  return result as Record<string, unknown>;
}

/** Fixed NDJSON commands to the packaged C#5 helper; no shell or runtime compiler. */
export function runWindowsSpeech(mode: SpeechMode, signal: AbortSignal, language?: string, helperPath?: string): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  const executable = helperPath ?? (typeof __dirname === "string"
    ? path.join(__dirname, "speech", "capygen-speech.exe")
    : fileURLToPath(new URL("../../dist/speech/capygen-speech.exe", import.meta.url)));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { windowsHide: true, env: cleanEnv(process.env), stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      child.stdin.end();
      if (error) { child.kill(); reject(error); }
      else resolve(output);
    };
    const abort = () => finish(new Error("cancelled"));
    const timer = setTimeout(() => finish(new Error("Windows speech timed out")), mode === "availability" ? 10_000 : 30_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      bytes += Buffer.byteLength(data, "utf8");
      if (bytes > 64 * 1024) { finish(new Error("Oversized speech output")); return; }
      output += data;
    });
    // Never retain raw helper diagnostics, audio or transcripts in logs.
    child.stderr.resume();
    child.stdin.on("error", () => finish(new Error("Windows speech process unavailable")));
    child.on("error", () => finish(new Error("Windows speech process unavailable")));
    child.on("close", (code) => {
      const lines = output.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
      finish(code === 0 && lines.length === 1 ? undefined : new Error("Invalid speech response"));
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    child.stdin.write(JSON.stringify({ command: mode, ...(mode === "recognize" ? { language } : {}) }) + "\n");
    // Keep stdin open while recording. EOF is the helper's parent-death signal.
  });
}
