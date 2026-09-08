import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileIo } from "@capygen/engine";
import type { PluginEntry, SkillEntry } from "@capygen/shared";
import type { ToolDefinition } from "../../../../packages/engine/src/tools/types.js";

export interface SharedSkillSource { skills: SkillEntry[]; plugins: PluginEntry[]; roots: string[] }
const MAX_OUTPUT = 64 * 1024;
const MAX_FILE = 4 * 1024 * 1024;
const normalized = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
const inside = (file: string, root: string) => { const relative = path.relative(normalized(root), normalized(file)); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

/** Declared roots may be linked dotfiles directories; child links must stay inside their resolved tree. */
function safeFile(file: string, roots: string[]): string | null {
  if (path.basename(file) !== "SKILL.md") return null;
  try {
    const real = fs.realpathSync(file);
    const validRoot = roots.some((root) => {
      try { return inside(file, root) && inside(real, fs.realpathSync(root)); }
      catch { return false; }
    });
    const stat = fs.statSync(real);
    return validRoot && stat.isFile() && stat.size <= MAX_FILE ? real : null;
  } catch { return null; }
}

function readBounded(file: string, roots: string[], limit: number): string | undefined {
  const real = safeFile(file, roots); if (!real) return undefined;
  const before = fs.statSync(real);
  const fd = fs.openSync(real, "r");
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || safeFile(file, roots) !== real) return undefined;
    const buffer = Buffer.alloc(Math.min(limit, opened.size));
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(fd, buffer, size, buffer.length - size, size);
      if (!read) break;
      size += read;
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally { fs.closeSync(fd); }
}

/** Catalogue reads only frontmatter-sized prefixes; bodies are loaded on read_skill. */
export function sharedSkillMetadataIo(base: FileIo, roots: string[]): FileIo {
  return { ...base, read: (file) => path.basename(file).startsWith("SKILL.md") ? readBounded(file, roots, 8192) : base.read(file) };
}

function idFor(skill: SkillEntry): string {
  return createHash("sha256").update(JSON.stringify([skill.backend, skill.scope, skill.pluginName ?? "", normalized(skill.path)])).digest("hex");
}

/** Bind this callback to the agent's project; no tool argument can select another root. */
export function createSharedSkillTools(sources: () => SharedSkillSource[]): ToolDefinition[] {
  function available() {
    return sources().flatMap((source) => source.skills.filter((skill) => skill.enabled
      && (!skill.pluginName || source.plugins.some((plugin) => plugin.name === skill.pluginName && plugin.enabled))
      && safeFile(skill.path, source.roots)).map((skill) => ({ skill, roots: source.roots, id: idFor(skill) })))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  return [{
    name: "list_skills", description: "List enabled shared skill instructions from canonical Claude Code and Codex files. Native plugin tools are not made portable by reading instructions.",
    permissionClass: "read", family: "read",
    parameters: { type: "object", properties: { offset: { type: "integer", minimum: 0 } }, additionalProperties: false },
    async run(input) {
      const offset = input.offset ?? 0;
      if (Object.keys(input).some((key) => key !== "offset") || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return { content: "Invalid skill list offset.", isError: true };
      const all = available(); const entries = all.slice(offset, offset + 20);
      for (;;) {
        const content = JSON.stringify({ skills: entries.map(({ skill, id }) => ({ id, name: skill.name.slice(0, 128), backend: skill.backend, scope: skill.scope, description: skill.description?.slice(0, 256) ?? "", pluginName: skill.pluginName?.slice(0, 128) ?? null })), nextOffset: offset + entries.length < all.length ? offset + entries.length : null });
        if (Buffer.byteLength(content) <= MAX_OUTPUT) return { content };
        entries.pop();
      }
    },
  }, {
    name: "read_skill", description: "Read enabled skill instructions by list_skills id. Follow nextOffset to read every page; offsets count UTF-16 code units. Returns source directory and revision. Does not execute native plugin capabilities.",
    permissionClass: "read", family: "read",
    parameters: { type: "object", properties: { id: { type: "string", pattern: "^[a-f0-9]{64}$" }, offset: { type: "integer", minimum: 0 } }, required: ["id"], additionalProperties: false },
    async run(input) {
      const offset = input.offset ?? 0;
      if (Object.keys(input).some((key) => key !== "id" && key !== "offset") || typeof input.id !== "string" || !/^[a-f0-9]{64}$/.test(input.id) || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return { content: "Use a list_skills id and a valid nextOffset.", isError: true };
      const entry = available().find((entry) => entry.id === input.id);
      if (!entry) return { content: "Skill is unavailable or disabled. List skills again.", isError: true };
      const body = readBounded(entry.skill.path, entry.roots, MAX_FILE);
      if (body === undefined) return { content: "Skill file is unavailable or outside its canonical directory.", isError: true };
      if (offset > body.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(body[offset] ?? "") && /[\uD800-\uDBFF]/.test(body[offset - 1] ?? ""))) return { content: "Use the nextOffset returned by the previous page.", isError: true };
      let end = Math.min(body.length, offset + 8192);
      const revision = createHash("sha256").update(body).digest("hex");
      for (;;) {
        if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1] ?? "")) end -= 1;
        if (end <= offset && offset < body.length) return { content: "Skill source metadata exceeds the output limit.", isError: true };
        const content = JSON.stringify({ backend: entry.skill.backend, sourceDirectory: path.dirname(entry.skill.path), revision, offset, nextOffset: end < body.length ? end : null, text: body.slice(offset, end) });
        if (Buffer.byteLength(content) <= MAX_OUTPUT) return { content };
        if (end <= offset) return { content: "Skill source metadata exceeds the output limit.", isError: true };
        end = offset + Math.floor((end - offset) / 2);
      }
    },
  }];
}
