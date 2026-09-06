import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizePath, isPathInside, requireIsolatedHomes } from "../scripts/test-policy.js";

const saved = {
  claude: process.env.CLAUDE_CONFIG_DIR,
  codex: process.env.CODEX_HOME,
};
const tempRoots: string[] = [];

afterEach(() => {
  if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.claude;
  if (saved.codex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.codex;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function homes(): [string, string] {
  const root = mkdtempSync(path.join(os.tmpdir(), "capygen-policy-"));
  tempRoots.push(root);
  const claude = path.join(root, "claude");
  const codex = path.join(root, "codex");
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  return [claude, codex];
}

describe("test probe isolation policy", () => {
  it("accepts explicit dedicated homes", () => {
    const [claude, codex] = homes();
    process.env.CLAUDE_CONFIG_DIR = claude;
    process.env.CODEX_HOME = codex;
    expect(() => requireIsolatedHomes("unit-test")).not.toThrow();
  });

  it("rejects missing, relative, and personal-home descendants", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    expect(() => requireIsolatedHomes("unit-test")).toThrow(/dedicated isolated homes/);

    process.env.CLAUDE_CONFIG_DIR = "relative-claude";
    process.env.CODEX_HOME = path.resolve("relative-codex");
    expect(() => requireIsolatedHomes("unit-test")).toThrow(/absolute paths/);

    const [claude, codex] = homes();
    process.env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".claude", "nested");
    process.env.CODEX_HOME = codex;
    expect(() => requireIsolatedHomes("unit-test")).toThrow(/personal config homes/);
    process.env.CLAUDE_CONFIG_DIR = claude;
  });

  it("rejects either personal backend home even when assigned to the other backend", () => {
    const [claude, codex] = homes();
    process.env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), ".codex", "nested");
    process.env.CODEX_HOME = codex;
    expect(() => requireIsolatedHomes("unit-test")).toThrow(/personal config homes/);
    process.env.CLAUDE_CONFIG_DIR = claude;
    process.env.CODEX_HOME = path.join(os.homedir(), ".claude", "nested");
    expect(() => requireIsolatedHomes("unit-test")).toThrow(/personal config homes/);
  });

  it("canonicalizes a symlink and recognizes exact and descendant paths", () => {
    const [claude] = homes();
    const alias = `${claude}-alias`;
    // Symlinks are available in the test environment; the policy uses the same
    // realpath path used by Windows junctions.
    symlinkSync(claude, alias, "junction");
    expect(canonicalizePath(alias)).toBe(canonicalizePath(claude));
    expect(isPathInside(canonicalizePath(claude), canonicalizePath(path.join(alias, "nested")))).toBe(true);
  });

  it("refuses the user home or filesystem root as a test home", () => {
    const [, codex] = homes();
    process.env.CODEX_HOME = codex;
    process.env.CLAUDE_CONFIG_DIR = os.homedir();
    expect(() => requireIsolatedHomes("unit-test")).toThrow(/personal config homes/);
    process.env.CLAUDE_CONFIG_DIR = path.parse(os.homedir()).root;
    expect(() => requireIsolatedHomes("unit-test")).toThrow(/personal config homes/);
  });
});
