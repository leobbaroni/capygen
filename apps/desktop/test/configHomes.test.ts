/**
 * The isolated-config-home seam (Phase 6, Task C item 1).
 *
 * This is the mechanism the repo's hard safety rule rests on — an e2e run must
 * not be able to write into `~/.claude` or `~/.codex` — so the rules are tested
 * on the real function rather than restated in the e2e that depends on them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPYGEN_CLAUDE_CONFIG_DIR_ENV,
  CAPYGEN_CODEX_HOME_ENV,
  applyConfigHomes,
  plannedConfigHomes,
  type EnvLike,
} from "../src/win/configHomes.js";
import { resolveBackendHomes } from "@capygen/engine";
import { cleanEnv } from "@capygen/engine";

const temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-homes-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plannedConfigHomes", () => {
  it("maps both capygen variables onto the backends' own", () => {
    const planned = plannedConfigHomes({
      [CAPYGEN_CLAUDE_CONFIG_DIR_ENV]: "C:/tmp/claude",
      [CAPYGEN_CODEX_HOME_ENV]: "C:/tmp/codex",
    });
    expect(planned.map((m) => m.to)).toEqual(["CLAUDE_CONFIG_DIR", "CODEX_HOME"]);
    expect(planned.map((m) => m.dir)).toEqual([
      path.resolve("C:/tmp/claude"),
      path.resolve("C:/tmp/codex"),
    ]);
  });

  it("ignores an unset or blank value rather than writing an empty home", () => {
    expect(plannedConfigHomes({})).toEqual([]);
    expect(
      plannedConfigHomes({
        [CAPYGEN_CLAUDE_CONFIG_DIR_ENV]: "   ",
        [CAPYGEN_CODEX_HOME_ENV]: "",
      }),
    ).toEqual([]);
  });

  it("does not touch the backends' variables when nothing asks it to", () => {
    const env: EnvLike = { CLAUDE_CONFIG_DIR: "C:/real/.claude" };
    applyConfigHomes(env, { mkdir: () => undefined });
    expect(env.CLAUDE_CONFIG_DIR).toBe("C:/real/.claude");
  });
});

describe("applyConfigHomes", () => {
  it("creates the directory and rewrites the environment in place", () => {
    const root = tempDir();
    const claude = path.join(root, "claude-home");
    const codex = path.join(root, "codex-home");
    const env: EnvLike = {
      [CAPYGEN_CLAUDE_CONFIG_DIR_ENV]: claude,
      [CAPYGEN_CODEX_HOME_ENV]: codex,
    };

    const applied = applyConfigHomes(env);

    expect(applied).toHaveLength(2);
    expect(fs.existsSync(claude)).toBe(true);
    expect(fs.existsSync(codex)).toBe(true);
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.resolve(claude));
    expect(env.CODEX_HOME).toBe(path.resolve(codex));
  });

  it("overrides a value inherited from the parent shell", () => {
    // capygen launched from a Claude Code terminal inherits that terminal's
    // own CLAUDE_CONFIG_DIR; the capygen-namespaced variable must win.
    const root = tempDir();
    const env: EnvLike = {
      CLAUDE_CONFIG_DIR: "C:/inherited/.claude",
      [CAPYGEN_CLAUDE_CONFIG_DIR_ENV]: root,
    };
    applyConfigHomes(env);
    expect(env.CLAUDE_CONFIG_DIR).toBe(path.resolve(root));
  });

  it("survives a directory it cannot create and still sets the variable", () => {
    const messages: string[] = [];
    const env: EnvLike = { [CAPYGEN_CODEX_HOME_ENV]: "C:/nope" };
    applyConfigHomes(env, {
      mkdir: () => {
        throw new Error("EPERM");
      },
      log: (m) => messages.push(m),
    });
    expect(env.CODEX_HOME).toBe(path.resolve("C:/nope"));
    expect(messages.join("\n")).toContain("EPERM");
  });

  it("is what `resolveBackendHomes` and `cleanEnv` then read", () => {
    // The two consumers named in `configHomes.ts`'s header, asserted rather
    // than assumed: the config stores go through `resolveBackendHomes`, and
    // every spawned child inherits `cleanEnv`'s copy.
    const root = tempDir();
    const claude = path.join(root, "c");
    const codex = path.join(root, "x");
    const env: EnvLike = {
      [CAPYGEN_CLAUDE_CONFIG_DIR_ENV]: claude,
      [CAPYGEN_CODEX_HOME_ENV]: codex,
    };
    applyConfigHomes(env);

    const homes = resolveBackendHomes(env, "C:/Users/nobody");
    expect(homes.claude).toBe(path.resolve(claude));
    expect(homes.codex).toBe(path.resolve(codex));

    const childEnv = cleanEnv(env);
    expect(childEnv.CLAUDE_CONFIG_DIR).toBe(path.resolve(claude));
    expect(childEnv.CODEX_HOME).toBe(path.resolve(codex));
  });
});
