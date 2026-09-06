/**
 * Search tools: `glob` and `grep`.
 *
 * No dependency is added for either. `fast-glob` would pull a transitive tree
 * into a package that today has exactly four runtime dependencies, and the
 * walker below is ~60 lines because it only has to do what a coding agent asks
 * for: match a path pattern under a root, skipping the directories nobody wants
 * matched (`node_modules`, `.git`, build output).
 *
 * `grep` prefers **ripgrep** when it is on PATH — it is what the user's other
 * agents already shell out to, it respects `.gitignore`, and it is an order of
 * magnitude faster on a real repository. The JS fallback exists so an `api`
 * agent still works on a machine without it, and the tool result says which one
 * ran so a slow search is explicable.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { cleanEnv } from "../env.js";
import { resolvePath } from "./fs.js";
import {
  clampText,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  describeError,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./types.js";

/** Directories a code search never wants to walk into. */
export const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  "release",
  "coverage",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".cache",
]);

const DEFAULT_MAX_RESULTS = 200;
/** Walk cap — a runaway pattern on a huge tree must not hang a turn. */
const MAX_WALKED_ENTRIES = 200_000;

/**
 * Glob → RegExp. Supports `**` (any depth), `*` (within one segment), `?`,
 * `{a,b}` alternation and `[...]` classes; everything else is literal. Matching
 * is done on `/`-separated paths so a Windows path behaves like a POSIX one.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` may match zero segments, so the slash is part of the optional group.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "{") {
      const end = pattern.indexOf("}", i);
      if (end > i) {
        const alternatives = pattern
          .slice(i + 1, end)
          .split(",")
          .map((alt) => alt.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*"));
        out += `(?:${alternatives.join("|")})`;
        i = end;
        continue;
      }
    }
    if (ch === "[") {
      const end = pattern.indexOf("]", i);
      if (end > i) {
        out += pattern.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, process.platform === "win32" ? "i" : "");
}

export interface WalkOptions {
  root: string;
  /** Called with the `/`-separated path relative to `root`. */
  match: (relativePath: string) => boolean;
  limit: number;
  signal?: AbortSignal;
}

/** Depth-first walk, sorted for a stable result, skipping `DEFAULT_IGNORED_DIRS`. */
export async function walkFiles(options: WalkOptions): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;

  async function visit(dir: string, prefix: string): Promise<void> {
    if (found.length >= options.limit || options.signal?.aborted) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip it rather than fail the whole search
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= options.limit || options.signal?.aborted) return;
      visited += 1;
      if (visited > MAX_WALKED_ENTRIES) return;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
        await visit(path.join(dir, entry.name), relative);
        continue;
      }
      if (entry.isFile() && options.match(relative)) found.push(relative);
    }
  }

  await visit(options.root, "");
  return found;
}

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    "Find files by path pattern (e.g. src/**/*.ts, **/*.{json,md}). " +
    "Returns paths relative to the search root, sorted. Skips node_modules, .git and build output.",
  permissionClass: "read",
  family: "glob",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, matched against the relative path." },
      path: { type: "string", description: "Directory to search in. Defaults to the project directory." },
      limit: { type: "integer", description: `Maximum matches. Default ${DEFAULT_MAX_RESULTS}.` },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async run(input, ctx): Promise<ToolResult> {
    const pattern = requireString(input, "pattern");
    const root = resolvePath(ctx.cwd, optionalString(input, "path") ?? ".");
    const limit = optionalNumber(input, "limit") ?? DEFAULT_MAX_RESULTS;
    const regexp = globToRegExp(pattern);
    const matches = await walkFiles({
      root,
      limit,
      match: (relative) => regexp.test(relative),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (matches.length === 0) return { content: `No files match ${pattern} under ${root}.` };
    const header = `${matches.length} match${matches.length === 1 ? "" : "es"} for ${pattern} under ${root}\n`;
    return clampText(header + matches.join("\n"), ctx.maxOutputChars);
  },
};

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export interface RipgrepRunner {
  /** Resolves null when ripgrep is not usable; otherwise its stdout. */
  run(args: string[], cwd: string, signal?: AbortSignal): Promise<string | null>;
}

/** Spawns `rg`; resolves null when the binary is missing (ENOENT). */
export const systemRipgrep: RipgrepRunner = {
  run(args, cwd, signal) {
    return new Promise<string | null>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("rg", args, {
          cwd,
          windowsHide: true,
          env: cleanEnv() as NodeJS.ProcessEnv,
        });
      } catch {
        resolve(null);
        return;
      }
      let stdout = "";
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("error", () => finish(null));
      // rg exits 1 for "no matches" and 2 for a real error; 1 is still a result.
      child.on("close", (code) => finish(code === 0 || code === 1 ? stdout : null));
      signal?.addEventListener("abort", () => {
        child.kill();
        finish(stdout);
      });
    });
  },
};

export interface GrepDeps {
  ripgrep?: RipgrepRunner | null;
}

/** JS fallback: walk, read, match. Only used when ripgrep is absent. */
async function grepInJs(
  root: string,
  regexp: RegExp,
  fileGlob: string | undefined,
  limit: number,
  ctx: ToolContext,
): Promise<string[]> {
  const fileMatcher = fileGlob ? globToRegExp(fileGlob) : null;
  const files = await walkFiles({
    root,
    limit: 20_000,
    match: (relative) => (fileMatcher ? fileMatcher.test(relative) : true),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const hits: string[] = [];
  for (const relative of files) {
    if (hits.length >= limit || ctx.signal?.aborted) break;
    let text: string;
    try {
      text = await fs.readFile(path.join(root, relative), "utf8");
    } catch {
      continue;
    }
    // A NUL in the first block is the same "this is binary" heuristic grep uses.
    if (text.slice(0, 4096).includes("\u0000")) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (hits.length >= limit) break;
      regexp.lastIndex = 0;
      if (regexp.test(lines[i] as string)) hits.push(`${relative}:${i + 1}:${lines[i]}`);
    }
  }
  return hits;
}

export function createGrepTool(deps: GrepDeps = {}): ToolDefinition {
  const ripgrep = deps.ripgrep === undefined ? systemRipgrep : deps.ripgrep;
  return {
    name: "grep",
    description:
      "Search file contents with a regular expression. Returns file:line:text. " +
      "Uses ripgrep when it is installed, otherwise an equivalent in-process search.",
    permissionClass: "read",
    family: "grep",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression (Rust regex / JS syntax)." },
        path: { type: "string", description: "Directory to search. Defaults to the project directory." },
        glob: { type: "string", description: "Only search files matching this glob, e.g. **/*.ts." },
        ignore_case: { type: "boolean", description: "Case-insensitive search. Default false." },
        limit: { type: "integer", description: `Maximum matching lines. Default ${DEFAULT_MAX_RESULTS}.` },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    async run(input, ctx): Promise<ToolResult> {
      const pattern = requireString(input, "pattern");
      const root = resolvePath(ctx.cwd, optionalString(input, "path") ?? ".");
      const fileGlob = optionalString(input, "glob");
      const ignoreCase = optionalBoolean(input, "ignore_case") ?? false;
      const limit = optionalNumber(input, "limit") ?? DEFAULT_MAX_RESULTS;

      let engine = "ripgrep";
      let lines: string[] | null = null;

      if (ripgrep) {
        const args = ["--line-number", "--no-heading", "--color", "never", "--max-count", String(limit)];
        if (ignoreCase) args.push("--ignore-case");
        if (fileGlob) args.push("--glob", fileGlob);
        args.push("--regexp", pattern, ".");
        const stdout = await ripgrep.run(args, root, ctx.signal);
        if (stdout !== null) {
          lines = stdout
            .split(/\r?\n/)
            .filter((line) => line.length > 0)
            .slice(0, limit)
            // rg prints `./src/x.ts:1:…` from a relative root; drop the `./`.
            .map((line) => (line.startsWith("./") ? line.slice(2) : line));
        }
      }

      if (lines === null) {
        engine = "in-process";
        let regexp: RegExp;
        try {
          regexp = new RegExp(pattern, ignoreCase ? "i" : "");
        } catch (err) {
          return { content: `Invalid pattern: ${describeError(err)}`, isError: true };
        }
        lines = await grepInJs(root, regexp, fileGlob, limit, ctx);
      }

      if (lines.length === 0) {
        return { content: `No matches for /${pattern}/ under ${root} (${engine}).` };
      }
      const header = `${lines.length} match${lines.length === 1 ? "" : "es"} for /${pattern}/ under ${root} (${engine})\n`;
      return clampText(header + lines.join("\n"), ctx.maxOutputChars);
    },
  };
}

export const grepTool: ToolDefinition = createGrepTool();
