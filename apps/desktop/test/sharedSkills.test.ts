import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { nodeFileIo } from "@capygen/engine";
import type { SkillEntry } from "@capygen/shared";
import { createSharedSkillTools, sharedSkillMetadataIo } from "../src/engine/sharedSkills.js";
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-shared-skills-")); owned.push(root);
  const skillRoot = path.join(root, "skills"); fs.mkdirSync(skillRoot);
  function skill(name: string, backend: "claude" | "codex" = "claude", body = "---\nname: fixture\n---\nInstructions"): SkillEntry {
    const dir = path.join(skillRoot, name); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "SKILL.md"); fs.writeFileSync(file, body);
    return { name, backend, scope: "user", path: file, enabled: true };
  }
  return { root, skillRoot, skill };
}
const run = (tool: ReturnType<typeof createSharedSkillTools>[number], input: Record<string, unknown>) => tool!.run(input, {} as never);

it("shares canonical backend ids, rechecks disabled skills/plugins, and reads only selected bodies with byte cap", async () => {
  const f = fixture();
  const first = f.skill("same", "claude", "á".repeat(50_000));
  const second = f.skill("codex", "codex"); second.name = first.name;
  const plugin = { ...f.skill("plugin"), scope: "plugin" as const, pluginName: "disabled-plugin" };
  const skills = [first, second, plugin];
  const tools = createSharedSkillTools(() => [{ skills, plugins: [], roots: [f.skillRoot] }]);
  const list = JSON.parse((await run(tools[0]!, {})).content) as { skills: { id: string; backend: string }[] };
  expect(list.skills).toHaveLength(2);
  expect(new Set(list.skills.map((entry) => entry.id)).size).toBe(2);
  const id = list.skills.find((entry) => entry.backend === "claude")!.id;
  const result = await run(tools[1]!, { id });
  expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(64 * 1024);
  expect(result.truncated).toBeUndefined(); expect(result.fullOutput).toBeUndefined();
  let page = JSON.parse(result.content) as { text: string; sourceDirectory: string; nextOffset: number | null; revision: string };
  expect(page.sourceDirectory).toBe(path.dirname(first.path));
  let combined = page.text;
  const revision = page.revision;
  while (page.nextOffset !== null) {
    const next = await run(tools[1]!, { id, offset: page.nextOffset });
    expect(Buffer.byteLength(next.content)).toBeLessThanOrEqual(64 * 1024);
    page = JSON.parse(next.content);
    expect(page.revision).toBe(revision);
    combined += page.text;
  }
  expect(combined).toBe("á".repeat(50_000));
  expect(result.content).not.toContain("�");
  first.enabled = false;
  expect(await run(tools[1]!, { id })).toMatchObject({ isError: true });
  expect(await run(tools[1]!, { id, path: second.path })).toMatchObject({ isError: true });
  const metadata = sharedSkillMetadataIo(nodeFileIo, [f.skillRoot]).read(second.path)!;
  expect(metadata).toContain("Instructions");
  expect(Buffer.byteLength(sharedSkillMetadataIo(nodeFileIo, [f.skillRoot]).read(first.path)!)).toBeLessThanOrEqual(8194);
});

it("supports a declared linked root and registered hardlinked skill while refusing an escaping child junction", async () => {
  const f = fixture();
  const packageDir = path.join(f.root, "package-store"); fs.mkdirSync(packageDir);
  const installed = path.join(packageDir, "SKILL.md"); fs.writeFileSync(installed, "Registered package instructions");
  const hard = f.skill("hard"); fs.unlinkSync(hard.path); fs.linkSync(installed, hard.path);
  const declaredRoot = path.join(f.root, "linked-skills"); fs.symlinkSync(f.skillRoot, declaredRoot, "junction");
  hard.path = path.join(declaredRoot, "hard", "SKILL.md");
  const secretDir = path.join(f.root, "unrelated"); fs.mkdirSync(secretDir);
  fs.writeFileSync(path.join(secretDir, "SKILL.md"), "Private fixture content");
  const junction = path.join(declaredRoot, "escape"); fs.symlinkSync(secretDir, junction, "junction");
  const escaped = { ...hard, path: path.join(junction, "SKILL.md") };
  const tools = createSharedSkillTools(() => [{ skills: [hard, escaped], plugins: [], roots: [declaredRoot] }]);
  const listed = JSON.parse((await run(tools[0]!, {})).content).skills;
  expect(listed).toHaveLength(1);
  expect(JSON.parse((await run(tools[1]!, { id: listed[0].id })).content).text).toBe("Registered package instructions");
  expect(sharedSkillMetadataIo(nodeFileIo, [declaredRoot]).read(hard.path)).toBe("Registered package instructions");
  expect(sharedSkillMetadataIo(nodeFileIo, [declaredRoot]).read(escaped.path)).toBeUndefined();
});
