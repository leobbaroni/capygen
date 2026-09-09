import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** Use the already-installed pinned SDK CLI, independent of a developer's PATH. */
export function nativeClaudePath(repoRoot: string): string {
  const engineRequire = createRequire(path.join(repoRoot, "packages", "engine", "package.json"));
  const sdk = engineRequire.resolve("@anthropic-ai/claude-agent-sdk");
  const nativePackage = createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
  const binary = path.join(path.dirname(nativePackage), process.platform === "win32" ? "claude.exe" : "claude");
  if (!fs.existsSync(binary)) throw new Error("The pinned SDK CLI is missing; install the workspace dependencies first.");
  return binary;
}
