import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { ApiProvider } from "@capygen/shared";

export const TEST_CLAUDE_MODEL = "claude-sonnet-5" as const;
export const TEST_CODEX_MODEL = "gpt-5.6-luna" as const;
export const TEST_EFFORT = "low" as const;

/** Require caller-provided, non-personal homes before any live child starts. */
export function requireIsolatedHomes(entrypoint: string): void {
  const claude = process.env.CLAUDE_CONFIG_DIR?.trim();
  const codex = process.env.CODEX_HOME?.trim();
  const missing = [
    !claude && "CLAUDE_CONFIG_DIR",
    !codex && "CODEX_HOME",
  ].filter(Boolean) as string[];
  if (missing.length > 0) {
    throw new Error(
      `[${entrypoint}] live probes require dedicated isolated homes; set ${missing.join(" and ")} ` +
        "to dedicated test directories. No real-home fallback or credential copying is allowed.",
    );
  }

  if (!path.isAbsolute(claude!) || !path.isAbsolute(codex!)) {
    throw new Error(
      `[${entrypoint}] isolated config homes must be absolute paths; use dedicated test directories for CLAUDE_CONFIG_DIR and CODEX_HOME.`,
    );
  }

  const protectedHomes = [".claude", ".codex"].map(name =>
    canonicalizePath(path.join(os.homedir(), name)),
  );
  const requestedHomes = [claude!, codex!].map(canonicalizePath);
  if (
    requestedHomes.some((candidate) =>
      protectedHomes.some((root) => isPathInside(root, candidate) || isPathInside(candidate, root)),
    )
  ) {
    throw new Error(
      `[${entrypoint}] refusing personal config homes or descendants; use dedicated test directories for CLAUDE_CONFIG_DIR and CODEX_HOME.`,
    );
  }
}

/** Resolve symlinks/junctions, including the nearest existing ancestor for new paths. */
export function canonicalizePath(input: string): string {
  if (!path.isAbsolute(input)) throw new Error(`path must be absolute: ${input}`);
  const absolute = path.resolve(input);
  let existing = absolute;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  let canonicalExisting: string;
  try {
    canonicalExisting = fs.realpathSync.native(existing);
  } catch {
    canonicalExisting = fs.realpathSync(existing);
  }
  const suffix = path.relative(existing, absolute);
  const canonical = suffix ? path.resolve(canonicalExisting, suffix) : canonicalExisting;
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** API smoke coverage is intentionally one explicit supported test model. */
export function requireApiTestModel(provider: ApiProvider, model: string): void {
  if (provider !== "anthropic" || model !== TEST_CLAUDE_MODEL) {
    throw new Error(
      `[live-api] test model not supported: use --provider anthropic --model ${TEST_CLAUDE_MODEL}; no substitute will be selected.`,
    );
  }
}

export function requirePinnedTestModel(entrypoint: string, model: string, expected: string): void {
  if (model !== expected) {
    throw new Error(
      `[${entrypoint}] test model not supported: use --model ${expected}; no substitute will be selected.`,
    );
  }
}
