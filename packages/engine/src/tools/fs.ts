/**
 * File tools: `read_file`, `write_file`, `edit_file`, `list_dir`.
 *
 * Deliberately the same four verbs (and the same argument names) the Claude Code
 * and Codex tool sets use, so a prompt that works against one backend works
 * against an `api` agent too — the reason the API harness can share the rest of
 * the app's block renderers without a translation layer.
 *
 * `edit_file` is the one with a real rule: the old string must occur **exactly
 * once** unless `replace_all` is set. A silent second match is how an edit tool
 * corrupts a file, so an ambiguous edit is an error the model has to fix.
 */
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ToolInputError,
  clampText,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  type ToolDefinition,
  type ToolResult,
} from "./types.js";

/**
 * Resolve a model-supplied path **inside the session's project directory**.
 *
 * Relative paths resolve against the project directory, never `process.cwd()`,
 * and an absolute path or a `..` walk that lands outside it is refused rather
 * than followed (SPEC R27). It used to be followed: `read_file` would happily
 * take `C:\Users\<user>\.ssh\id_rsa`, and `read` is an `allow` class in every
 * permission mode — plan mode included — so a model steered by an untrusted
 * tool result or a project file had unprompted read access to the whole disk.
 *
 * Reads stay ungated inside the project (an agent that must ask before reading
 * a file it was pointed at is unusable, and Claude Code's plan mode reads too);
 * the boundary is what makes that safe.
 */
export function resolvePath(cwd: string, target: string): string {
  const resolved = path.isAbsolute(target)
    ? path.normalize(target)
    : path.resolve(cwd, target);
  const root = path.resolve(cwd);
  const relative = path.relative(root, resolved);
  // `path.relative` returns an absolute path when the two are on different
  // Windows drives, and a leading `..` when the target escapes upwards.
  const outside =
    relative !== "" &&
    (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`));
  if (outside) {
    throw new ToolInputError(
      `${resolved} is outside the project directory (${root}). ` +
        "This runtime only reads and writes inside the project.",
    );
  }
  return resolved;
}

/** `cat -n`-style numbering — the format every one of these models has seen. */
function numberLines(lines: string[], firstLineNumber: number): string {
  return lines
    .map((line, i) => `${String(firstLineNumber + i).padStart(6, " ")}\t${line}`)
    .join("\n");
}

async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from disk. Returns the content with 1-based line numbers. " +
    "Use offset/limit to read a slice of a large file instead of the whole thing.",
  permissionClass: "read",
  family: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path, or relative to the project directory." },
      offset: { type: "integer", description: "1-based line to start at. Default 1." },
      limit: { type: "integer", description: "How many lines to return. Default: the whole file." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(input, ctx): Promise<ToolResult> {
    const target = resolvePath(ctx.cwd, requireString(input, "path"));
    const stats = await statOrNull(target);
    if (!stats) return { content: `No such file: ${target}`, isError: true };
    if (stats.isDirectory()) {
      return { content: `${target} is a directory — use list_dir.`, isError: true };
    }
    const raw = await fs.readFile(target, "utf8");
    const lines = raw.split(/\r?\n/);
    const offset = Math.max(1, optionalNumber(input, "offset") ?? 1);
    const limit = optionalNumber(input, "limit");
    const slice = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined);
    if (slice.length === 0) {
      return { content: `${target} has ${lines.length} lines; offset ${offset} is past the end.` };
    }
    const body = numberLines(slice, offset);
    const header =
      slice.length < lines.length
        ? `${target} (lines ${offset}-${offset + slice.length - 1} of ${lines.length})\n`
        : `${target}\n`;
    return clampText(header + body, ctx.maxOutputChars);
  },
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Create or overwrite a text file. Parent directories are created as needed. " +
    "Prefer edit_file when the file already exists and only part of it changes.",
  permissionClass: "write",
  family: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path, or relative to the project directory." },
      content: { type: "string", description: "The complete new file content." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async run(input, ctx): Promise<ToolResult> {
    const target = resolvePath(ctx.cwd, requireString(input, "path"));
    const content = input.content;
    if (typeof content !== "string") throw new ToolInputError("content must be a string");
    const existed = await statOrNull(target);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
    return {
      content: `${existed ? "Overwrote" : "Wrote"} ${target} (${lines} lines, ${content.length} characters).`,
    };
  },
};

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_string must appear exactly once unless " +
    "replace_all is true; include enough surrounding context to make it unique.",
  permissionClass: "write",
  family: "edit",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path, or relative to the project directory." },
      old_string: { type: "string", description: "Exact text to replace, including whitespace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async run(input, ctx): Promise<ToolResult> {
    const target = resolvePath(ctx.cwd, requireString(input, "path"));
    const oldString = requireString(input, "old_string");
    const newString = input.new_string;
    if (typeof newString !== "string") throw new ToolInputError("new_string must be a string");
    if (oldString === newString) {
      return { content: "old_string and new_string are identical; nothing to do.", isError: true };
    }
    const stats = await statOrNull(target);
    if (!stats) return { content: `No such file: ${target}`, isError: true };

    const original = await fs.readFile(target, "utf8");
    const count = countOccurrences(original, oldString);
    if (count === 0) {
      return {
        content:
          `old_string was not found in ${target}. Read the file again — ` +
          "whitespace and indentation must match exactly.",
        isError: true,
      };
    }
    const replaceAll = optionalBoolean(input, "replace_all") ?? false;
    if (count > 1 && !replaceAll) {
      return {
        content:
          `old_string occurs ${count} times in ${target}. ` +
          "Add surrounding context to make it unique, or pass replace_all: true.",
        isError: true,
      };
    }
    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);
    await fs.writeFile(target, updated, "utf8");
    const replaced = replaceAll ? count : 1;
    return {
      content: `Replaced ${replaced} occurrence${replaced > 1 ? "s" : ""} in ${target}.`,
    };
  },
};

/** `split().join()` would allocate the whole file twice; this only scans it. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const listDirTool: ToolDefinition = {
  name: "list_dir",
  description:
    "List the entries of a directory. Directories are marked with a trailing slash. " +
    "Use glob for recursive pattern matching.",
  permissionClass: "read",
  family: "read",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory to list. Defaults to the project directory.",
      },
    },
    additionalProperties: false,
  },
  async run(input, ctx): Promise<ToolResult> {
    const target = resolvePath(ctx.cwd, optionalString(input, "path") ?? ".");
    const stats = await statOrNull(target);
    if (!stats) return { content: `No such directory: ${target}`, isError: true };
    if (!stats.isDirectory()) {
      return { content: `${target} is a file, not a directory.`, isError: true };
    }

    const entries = await fs.readdir(target, { withFileTypes: true });
    entries.sort((a, b) => {
      const dirDelta = Number(b.isDirectory()) - Number(a.isDirectory());
      return dirDelta !== 0 ? dirDelta : a.name.localeCompare(b.name);
    });
    if (entries.length === 0) return { content: `${target} is empty.` };
    const body = entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .join("\n");
    return clampText(`${target}\n${body}`, ctx.maxOutputChars);
  },
};

export const FS_TOOLS: ToolDefinition[] = [readFileTool, writeFileTool, editFileTool, listDirTool];
