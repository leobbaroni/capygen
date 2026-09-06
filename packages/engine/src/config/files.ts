/**
 * Reading and writing the backends' own config files, with two rules that make
 * SPEC R29's "the backend's files are the source of truth" survivable:
 *
 *   1. **A write never invents a file's other content.** JSON is read, the one
 *      key we own is changed on the parsed object, and the whole object is
 *      written back — so every key capygen does not model survives verbatim.
 *      TOML never goes through a serialiser at all (see `./toml.ts`).
 *   2. **A write is atomic and re-read.** The new bytes go to a sibling
 *      `.<name>.capygen-tmp` and are renamed over the original, so a crash
 *      mid-write cannot leave the user with half a `settings.json`; the caller
 *      then reads the file back, which is how every store here proves the edit
 *      landed rather than assuming it.
 *
 * A missing file reads as `undefined`, never as an error: a machine with no
 * `~/.codex/config.toml` has no Codex MCP servers, which is a fact, not a
 * failure.
 */
import fs from "node:fs";
import path from "node:path";

export interface FileIo {
  read(file: string): string | undefined;
  write(file: string, contents: string): void;
  exists(file: string): boolean;
  /**
   * Move a file. The **only** way anything in this module makes a path stop
   * existing: there is deliberately no `delete`, so a bug here can misplace a
   * user's skill but can never destroy it.
   */
  rename(from: string, to: string): void;
  /** Directory entries, or `[]` when the directory is absent. */
  listDirs(dir: string): string[];
  stat(file: string): { size: number; mtimeMs: number } | undefined;
}

export const nodeFileIo: FileIo = {
  read(file) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  },
  write(file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.capygen-tmp`);
    fs.writeFileSync(temp, contents, "utf8");
    fs.renameSync(temp, file);
  },
  exists(file) {
    return fs.existsSync(file);
  },
  rename(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  },
  listDirs(dir) {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  },
  stat(file) {
    try {
      const stats = fs.statSync(file);
      return { size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
      return undefined;
    }
  },
};

export function readJsonFile(
  io: FileIo,
  file: string,
  onError?: (message: string) => void,
): Record<string, unknown> | undefined {
  const text = io.read(file);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch (err) {
    // A settings file somebody is mid-edit must not take the app down; it is
    // reported and treated as absent until the next watcher tick.
    onError?.(`${file} is not valid JSON: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Read-modify-write one JSON config file. `mutate` receives the parsed object
 * (`{}` when the file is absent) and edits it in place; every key it does not
 * touch is written back exactly as it was read.
 */
export function updateJsonFile(
  io: FileIo,
  file: string,
  mutate: (value: Record<string, unknown>) => void,
): Record<string, unknown> {
  const current = readJsonFile(io, file) ?? {};
  mutate(current);
  io.write(file, `${JSON.stringify(current, null, 2)}\n`);
  const reread = readJsonFile(io, file);
  if (!reread) throw new Error(`capygen wrote ${file} but could not read it back`);
  return reread;
}

/** Read-modify-write for the TOML patcher; `patch` returns the new text. */
export function updateTextFile(
  io: FileIo,
  file: string,
  patch: (text: string) => string,
): string {
  const next = patch(io.read(file) ?? "");
  io.write(file, next);
  const reread = io.read(file);
  if (reread === undefined) throw new Error(`capygen wrote ${file} but could not read it back`);
  return reread;
}

/**
 * The `name:` and `description:` of a `SKILL.md`, from its YAML front matter.
 * Deliberately a two-key reader and not a YAML parser: those are the only two
 * fields Settings ▸ Skills shows, and the rest of the document is prose.
 */
export function readSkillFrontMatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const body = match[1] ?? "";
  const out: { name?: string; description?: string } = {};
  for (const line of body.split(/\r?\n/)) {
    const field = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!field) continue;
    const key = field[1] as "name" | "description";
    if (out[key] !== undefined) continue;
    out[key] = unquoteScalar((field[2] ?? "").trim());
  }
  return out;
}

function unquoteScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\"/g, '"');
    }
  }
  return value;
}
