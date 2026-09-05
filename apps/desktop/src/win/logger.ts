/**
 * Rotating file logger with secret redaction.
 *
 * Ported from the sibling project's proven implementation
 * (Omnigent-windows/app/src/win/logger.js) to TypeScript. A packaged Windows app
 * never shows a console, so every console.* call from the main process is
 * mirrored into %APPDATA%\capygen\logs\capygen-desktop.log, rotated at 2 MB,
 * five files kept. Redaction is belt-and-braces: capygen never logs a key
 * (CLAUDE.md §Secrets), and this makes an accident non-fatal.
 */
import fs from "node:fs";
import path from "node:path";

export interface LoggerOptions {
  dir: string;
  maxBytes?: number;
  keep?: number;
  fileName?: string;
  now?: () => Date;
  fsImpl?: Pick<
    typeof fs,
    "mkdirSync" | "statSync" | "appendFileSync" | "existsSync" | "renameSync" | "rmSync"
  >;
}

export interface Logger {
  readonly file: string;
  readonly dir: string;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  captureConsole(consoleObj?: Console): () => void;
  captureProcessErrors(proc?: NodeJS.Process): void;
}

const DEFAULTS = { maxBytes: 2 * 1024 * 1024, keep: 5, fileName: "capygen-desktop.log" };

/**
 * Mask secret-shaped values before a line reaches disk: bearer tokens,
 * `token=` / `password=` pairs, session cookies, and any long opaque value
 * after `=`.
 */
export function redact(line: unknown): string {
  return String(line)
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted]")
    .replace(
      /((?:token|password|passwd|secret|api[_-]?key|cookie)\s*[=:]\s*)[^\s&"',;]+/gi,
      "$1[redacted]",
    )
    .replace(/\b(sk-[A-Za-z0-9_\-]{8,})/g, "[redacted]")
    .replace(/("?set-cookie"?\s*[:=]\s*\[?\s*"?)([^"\]]+)/gi, (_m, prefix: string) => `${prefix}[redacted]`)
    .replace(
      /\b([A-Za-z0-9_\-]*(?:sess|session|csrf|auth)[A-Za-z0-9_\-]*=)[^;\s"']+/gi,
      "$1[redacted]",
    )
    .replace(/(=)[A-Za-z0-9%._\-]{40,}/g, "$1[redacted]");
}

function fmt(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  const cfg = { ...DEFAULTS, ...opts };
  const fsx = cfg.fsImpl ?? fs;
  const now = cfg.now ?? (() => new Date());
  const file = path.join(cfg.dir, cfg.fileName);

  function rotateIfNeeded(): void {
    let size = 0;
    try {
      size = fsx.statSync(file).size;
    } catch {
      return;
    }
    if (size < cfg.maxBytes) return;
    for (let i = cfg.keep - 1; i >= 1; i -= 1) {
      const from = `${file}.${i}`;
      try {
        if (!fsx.existsSync(from)) continue;
        if (i === cfg.keep - 1) fsx.rmSync(from, { force: true });
        else fsx.renameSync(from, `${file}.${i + 1}`);
      } catch {
        /* best effort */
      }
    }
    try {
      fsx.renameSync(file, `${file}.1`);
    } catch {
      /* best effort */
    }
  }

  function write(level: string, args: unknown[]): void {
    try {
      fsx.mkdirSync(cfg.dir, { recursive: true });
      rotateIfNeeded();
      fsx.appendFileSync(
        file,
        `${now().toISOString()} [${level}] ${redact(args.map(fmt).join(" "))}\n`,
      );
    } catch {
      /* logging must never break the app */
    }
  }

  return {
    file,
    dir: cfg.dir,
    info: (...a) => write("info", a),
    warn: (...a) => write("warn", a),
    error: (...a) => write("error", a),
    debug: (...a) => write("debug", a),
    captureConsole(consoleObj: Console = console) {
      const originals: Record<string, (...a: unknown[]) => void> = {};
      const pairs: [keyof Console, string][] = [
        ["log", "info"],
        ["info", "info"],
        ["warn", "warn"],
        ["error", "error"],
        ["debug", "debug"],
      ];
      for (const [method, level] of pairs) {
        const original = consoleObj[method] as (...a: unknown[]) => void;
        originals[method as string] = original;
        (consoleObj as unknown as Record<string, unknown>)[method as string] = (
          ...a: unknown[]
        ) => {
          write(level, a);
          try {
            original.apply(consoleObj, a);
          } catch {
            /* console unavailable in a packaged app */
          }
        };
      }
      return () => {
        for (const [m, fn] of Object.entries(originals)) {
          (consoleObj as unknown as Record<string, unknown>)[m] = fn;
        }
      };
    },
    captureProcessErrors(proc: NodeJS.Process = process) {
      proc.on("uncaughtException", (err) => write("error", ["uncaughtException", err]));
      proc.on("unhandledRejection", (reason) => write("error", ["unhandledRejection", reason]));
    },
  };
}
