/**
 * Path containment on real Windows filesystems (SPEC R27).
 *
 * `resolvePath` decides whether a model-supplied path is inside the session's
 * project directory. Doing that lexically is not enough on Windows, where one
 * directory has two legitimate names: the long form and the 8.3 alias
 * (`C:\Users\TUGAPL~1\…`). `os.tmpdir()` returns the alias on this machine, so
 * an owned temp project reached by its own alias was refused — a false positive
 * against a path that is demonstrably inside the project.
 *
 * The same canonicalisation must not weaken the boundary it exists for: a
 * junction or symlink that leaves the project is still an escape, whatever it
 * is spelled as.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePath } from "../src/tools/fs.js";
import { ToolInputError } from "../src/tools/types.js";

const onWindows = process.platform === "win32";
/** The alias only exists on Windows; elsewhere these read as plain paths. */
const aliasedTmp = os.tmpdir();
const realTmp = fs.realpathSync.native(aliasedTmp);
const hasAlias = onWindows && aliasedTmp.toLowerCase() !== realTmp.toLowerCase();

let root = "";
let outside = "";

/** Creates a link, reporting whether this machine actually allowed it. */
function tryLink(target: string, link: string, type: "junction" | "dir"): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  // A name with a space and a non-ASCII character, because both are real.
  root = fs.mkdtempSync(path.join(realTmp, "capygen fs-café-"));
  outside = fs.mkdtempSync(path.join(realTmp, "capygen outside-"));
  fs.mkdirSync(path.join(root, "nested", "deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "nested", "deep", "here.txt"), "x", "utf8");
  fs.writeFileSync(path.join(outside, "secret.txt"), "s", "utf8");
});

afterAll(() => {
  for (const dir of [root, outside]) fs.rmSync(dir, { recursive: true, force: true });
});

/** The same directory, spelled with the 8.3 alias its own OS hands out. */
function aliased(target: string): string {
  return realTmp.toLowerCase() === target.slice(0, realTmp.length).toLowerCase()
    ? aliasedTmp + target.slice(realTmp.length)
    : target;
}

describe("an 8.3 alias names the same directory, not an escape", () => {
  it.runIf(hasAlias)("accepts an existing file reached through the alias", () => {
    const target = aliased(path.join(root, "nested", "deep", "here.txt"));
    expect(target).not.toBe(path.join(root, "nested", "deep", "here.txt"));
    const resolved = resolvePath(root, target);
    // Resolved to the canonical long form, and readable — the two spellings are
    // one file, which is the whole point.
    expect(fs.readFileSync(resolved, "utf8")).toBe("x");
  });

  it.runIf(hasAlias)("accepts a not-yet-existing file reached through the alias", () => {
    // The reported case: `write_file` creating a new file under an aliased root.
    const target = aliased(path.join(root, "nested", "deep", "new file.txt"));
    const resolved = resolvePath(root, target);
    expect(() => fs.writeFileSync(resolved, "written", "utf8")).not.toThrow();
    expect(fs.readFileSync(path.join(root, "nested", "deep", "new file.txt"), "utf8")).toBe(
      "written",
    );
    fs.rmSync(resolved);
  });

  it.runIf(hasAlias)("accepts an aliased project root with a long-form target", () => {
    const resolved = resolvePath(aliased(root), path.join(root, "nested", "deep", "here.txt"));
    expect(fs.readFileSync(resolved, "utf8")).toBe("x");
  });

  it.runIf(hasAlias)("still refuses an aliased path that genuinely escapes", () => {
    expect(() => resolvePath(root, aliased(path.join(outside, "secret.txt")))).toThrow(
      ToolInputError,
    );
  });
});

describe("canonicalisation does not weaken the boundary", () => {
  it.runIf(onWindows)("refuses a junction inside the project that points outside", (ctx) => {
    const link = path.join(root, "escape-hatch");
    if (!tryLink(outside, link, "junction")) {
      // [review] A skip with a reason, never a silent `return`: an unrunnable
      // case must not be counted as a passing one.
      ctx.skip("this machine cannot create a junction (privilege or filesystem)");
      return;
    }
    try {
      // Lexically this is inside the project. It is not.
      expect(() => resolvePath(root, path.join(link, "secret.txt"))).toThrow(ToolInputError);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it.runIf(onWindows)("refuses a dangling junction rather than treating it as absent", (ctx) => {
    const victim = path.join(root, "target-that-goes-away");
    const link = path.join(root, "dangling");
    fs.mkdirSync(victim, { recursive: true });
    if (!tryLink(victim, link, "junction")) {
      ctx.skip("this machine cannot create a junction (privilege or filesystem)");
      return;
    }
    try {
      // The junction still exists; what it points at does not. `realpath` says
      // ENOENT, which must not be read as "this segment is simply missing".
      fs.rmSync(victim, { recursive: true, force: true });
      expect(() => resolvePath(root, path.join("dangling", "file.txt"))).toThrow(ToolInputError);
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it("refuses a symlink loop rather than walking past it", (ctx) => {
    const a = path.join(root, "loop-a");
    const b = path.join(root, "loop-b");
    // Each points at the other, so neither ever resolves.
    if (!tryLink(b, a, "junction") || !tryLink(a, b, "junction")) {
      for (const link of [a, b]) fs.rmSync(link, { recursive: true, force: true });
      ctx.skip("this machine cannot create the linked pair needed for a loop");
      return;
    }
    try {
      expect(() => resolvePath(root, path.join("loop-a", "file.txt"))).toThrow(ToolInputError);
    } finally {
      for (const link of [a, b]) fs.rmSync(link, { recursive: true, force: true });
    }
  });

  it("refuses when the project directory itself does not exist", () => {
    // Deterministic, no privileges: there is no real location to compare
    // against, so nothing may be admitted into it.
    expect(() => resolvePath(path.join(root, "no-such-project"), "a.txt")).toThrow(
      /does not exist/,
    );
  });

  it.runIf(onWindows)("refuses a path whose drive root does not resolve", () => {
    // An absent drive: the walk reaches the root without resolving anything,
    // which must refuse rather than fall back to the lexical form.
    expect(() => resolvePath(root, "Z:\\elsewhere\\secret.txt")).toThrow(ToolInputError);
  });

  it("refuses a parent walk and an absolute outsider", () => {
    // `Z:\…` is covered separately: on Linux it is a legitimate *filename*,
    // not another drive, so asserting it here would test nothing there.
    for (const target of [path.join("..", "secret.txt"), path.join(outside, "secret.txt")]) {
      expect(() => resolvePath(root, target)).toThrow(/outside the project directory/);
    }
  });

  it("keeps relative paths, dot and nested creation inside the project", () => {
    expect(resolvePath(root, ".")).toBe(fs.realpathSync.native(root));
    expect(resolvePath(root, path.join("nested", "deep", "here.txt"))).toBe(
      path.join(fs.realpathSync.native(root), "nested", "deep", "here.txt"),
    );
    // A path whose parents do not exist yet must still resolve.
    expect(resolvePath(root, path.join("brand", "new", "tree", "file.txt"))).toBe(
      path.join(fs.realpathSync.native(root), "brand", "new", "tree", "file.txt"),
    );
  });
});
