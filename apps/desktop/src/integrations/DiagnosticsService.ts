/**
 * Settings ▸ Diagnostics (SPEC R19) — "here is what capygen sees", in a form
 * that can be pasted into a bug report.
 *
 * Which makes redaction the load-bearing part. `diagnostics.copy` puts this
 * text on the clipboard, and a clipboard is the easiest way in the world to
 * leak a key (SPEC R21: never write a key to a plain file *or a log*). So:
 *
 *  - no value here is ever read from the secrets store — API keys appear as
 *    "set" / "not set", never as bytes;
 *  - every value that *does* go in is passed through `redact`, which blanks
 *    anything shaped like a token (`sk-…`, a long base64-ish run, an
 *    `Authorization` header) wherever it appears, including inside a path;
 *  - the environment is not dumped at all. Only the four documented variables
 *    are reported, and only as present/absent.
 *
 * Nothing here is persisted: a diagnostics page that told you what was true
 * last week would be worse than none.
 */
import { resolveBackendHomes } from "@capygen/engine";
import type { DiagnosticsInfo, HarnessAvailability, HarnessInfo } from "@capygen/shared";
import { defaultCliProbe, type CliProbe } from "../ipc/harnessList.js";
import type { EngineLogger } from "../engine/types.js";

export interface DiagnosticsAppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  userDataDir: string;
  logFile: string;
  dbFile: string;
}

export interface DiagnosticsDeps {
  log: EngineLogger;
  appInfo: () => DiagnosticsAppInfo;
  /** `harness.list` — reused rather than re-probed (SPEC's own wording). */
  listHarnesses: () => Promise<HarnessInfo[]> | HarnessInfo[];
  /** Bytes on disk for the SQLite file; injected so tests need no real file. */
  fileSize?: (file: string) => number;
  /**
   * The same `CliProbe` `harness.list` and the setup panel use (`execFile`,
   * `windowsHide`, 5 s timeout) — reused rather than re-declared so the three
   * screens can never disagree about which `claude.exe` answered.
   */
  probe?: CliProbe;
  env?: Record<string, string | undefined>;
  home?: string;
  /** Injected: Electron's `clipboard.writeText`. */
  writeClipboard?: (text: string) => void;
}

/** Env vars reported as present/absent — never by value (R21). */
const REPORTED_ENV = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
] as const;

export class DiagnosticsService {
  constructor(private readonly deps: DiagnosticsDeps) {}

  /** `diagnostics.get`. */
  async get(): Promise<DiagnosticsInfo> {
    const app = this.deps.appInfo();
    const homes = resolveBackendHomes(this.deps.env ?? process.env, this.deps.home);
    const probe = this.deps.probe ?? defaultCliProbe;
    const version = async (command: string): Promise<string | null> => {
      const result = await probe(command, ["--version"]);
      return result.ok ? (result.version ?? "") : null;
    };
    const [claude, codex, node, git] = await Promise.all([
      version("claude"),
      version("codex"),
      version("node"),
      version("git"),
    ]);

    const harnesses = await this.deps.listHarnesses();
    const harnessAvailability: HarnessAvailability[] = harnesses.map((harness) => ({
      backend: harness.backend,
      available: harness.available,
      ...(harness.reason ? { reason: redact(harness.reason) } : {}),
    }));

    const versions: Record<string, string> = {
      app: `${app.name} ${app.version}`,
      electron: app.electron,
      chrome: app.chrome,
      node: app.node,
      "node (PATH)": node ?? "not found",
      claude: claude ?? "not found",
      codex: codex ?? "not found",
      git: git ?? "not found",
      platform: app.platform,
    };
    for (const key of REPORTED_ENV) {
      const value = (this.deps.env ?? process.env)[key];
      // Presence only. A key's *value* never enters this object, so it can
      // never reach the clipboard, a log line or a bug report.
      versions[`env.${key}`] = value ? "set" : "not set";
    }

    const paths: Record<string, string> = {
      userData: redact(app.userDataDir),
      database: redact(app.dbFile),
      logFile: redact(app.logFile),
      claudeHome: redact(homes.claude),
      codexHome: redact(homes.codex),
    };

    return {
      versions,
      paths,
      harnessAvailability,
      dbSizeBytes: this.sizeOf(app.dbFile),
      logDir: redact(dirNameOf(app.logFile)),
    };
  }

  /** `diagnostics.copy` — the same object, rendered, redacted, on the clipboard. */
  async copy(): Promise<{ ok: boolean }> {
    if (!this.deps.writeClipboard) throw new Error("diagnostics.copy: no clipboard is wired");
    const text = renderDiagnostics(await this.get());
    this.deps.writeClipboard(text);
    this.deps.log.info(`[diagnostics] ${text.length} characters copied`);
    return { ok: true };
  }

  private sizeOf(file: string): number {
    if (!this.deps.fileSize) return 0;
    try {
      return Math.max(0, Math.trunc(this.deps.fileSize(file)));
    } catch {
      return 0;
    }
  }
}

/** Plain text for a bug report. Deterministic order, no secrets. */
export function renderDiagnostics(info: DiagnosticsInfo): string {
  const lines: string[] = ["capygen diagnostics", ""];
  lines.push("## Versions");
  for (const [key, value] of Object.entries(info.versions)) lines.push(`- ${key}: ${redact(value)}`);
  lines.push("", "## Paths");
  for (const [key, value] of Object.entries(info.paths)) lines.push(`- ${key}: ${redact(value)}`);
  lines.push("", "## Backends");
  for (const harness of info.harnessAvailability) {
    lines.push(
      `- ${harness.backend}: ${harness.available ? "available" : "unavailable"}` +
        (harness.reason ? ` — ${redact(harness.reason)}` : ""),
    );
  }
  lines.push("", "## Storage");
  lines.push(`- database: ${formatBytes(info.dbSizeBytes)}`);
  lines.push(`- logs: ${redact(info.logDir)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Blank anything token-shaped, wherever it appears.
 *
 * The patterns are the ones this app can actually produce: the three provider
 * key prefixes, an `Authorization`/`x-api-key` header value copied out of an
 * MCP server config, and a long unbroken high-entropy run (which is what an
 * OAuth token looks like). Over-redacting a harmless string is a cosmetic
 * problem; under-redacting a key is the one failure this function exists to
 * prevent, so the patterns are deliberately greedy.
 */
export function redact(value: string): string {
  return value
    // Longest prefix first: regex alternation is leftmost-wins, so a bare `sk`
    // listed before `sk-ant` would swallow the more informative label.
    .replace(/\b(sk-ant|sk-proj|sk-or|sk)-[A-Za-z0-9_-]{8,}/g, "$1-[redacted]")
    // Everything after a secret-ish key's separator, to end of line. Matching
    // only the token itself was not enough: `Authorization: Bearer <16 chars>`
    // left the token in place, because "Bearer" is what followed the colon and
    // the token was too short for the entropy rule below. Diagnostics output is
    // line-oriented (`renderDiagnostics`), so taking the rest of the line is
    // both safe and complete.
    .replace(
      /\b(authorization|x-api-key|api[_-]?key|token|secret)\b(\s*[:=]\s*).+$/gim,
      "$1$2[redacted]",
    )
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dirNameOf(file: string): string {
  const at = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  return at > 0 ? file.slice(0, at) : file;
}
