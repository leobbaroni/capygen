/**
 * The Claude chain, reconstructed by the *installed SDK* against the
 * *production* store adapter (`createReadOnlySessionStore`), rather than by a
 * fake of either.
 *
 * The SDK has to see isolated backend homes from the moment it loads, so it
 * runs in a child process (`test/fixtures/imports/sdkReconstruct.mjs`, launched
 * through tsx so it can import the TypeScript source). The environment is built
 * *here*, at the `execFile` boundary: `cleanEnv` strips the nested-session
 * markers, provider credentials are removed outright, and `CLAUDE_CONFIG_DIR` /
 * `CODEX_HOME` point at fresh temp directories. The vitest process itself never
 * imports the SDK and never mutates an environment variable — which is exactly
 * why the shipping parser takes the reconstructor as an injected boundary.
 *
 * No model call, no CLI spawn, no auth read.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanEnv } from "../src/env.js";
import {
  parseTranscriptFile,
  type ClaudeChainReconstructor,
  type ClaudeStoreEntry,
} from "../src/imports/index.js";

const execFileAsync = promisify(execFile);
const HELPER = fileURLToPath(new URL("./fixtures/imports/sdkReconstruct.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/imports/claude-chain.jsonl", import.meta.url));

/** Anything that could authenticate a real backend call. */
const CREDENTIAL_PATTERN = /(_API_KEY|_TOKEN|_SECRET|ANTHROPIC|OPENAI|OPENROUTER|AWS_|GOOGLE_)/i;

const temps: string[] = [];

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface HelperResult {
  calls: string[];
  key: { projectKey: string; sessionId: string } | null;
  uuids: string[];
  homes: { claudeHome: string; codexHome: string; projectDir: string };
  providerKeysInEnv: string[];
}

/**
 * Runs the real SDK in a child process with an environment built here, and
 * returns what it did.
 */
async function reconstructInChild(input: {
  sessionId: string;
  entries: ClaudeStoreEntry[];
}): Promise<HelperResult> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-sdk-"));
  temps.push(root);
  const claudeHome = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  const projectDir = path.join(root, "inert-project");
  for (const dir of [claudeHome, codexHome, projectDir]) fs.mkdirSync(dir);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(cleanEnv(process.env))) {
    if (value === undefined || CREDENTIAL_PATTERN.test(key)) continue;
    env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = claudeHome;
  env.CODEX_HOME = codexHome;
  env.CAPYGEN_IMPORT_PROJECT_DIR = projectDir;

  const inputPath = path.join(root, "input.json");
  fs.writeFileSync(inputPath, JSON.stringify(input), "utf8");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx/esm", HELPER, inputPath],
    { env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout) as HelperResult;
}

describe("Claude chain reconstruction through the installed SDK", () => {
  it("orders the chain from the production store, touching only load()", async () => {
    let observed: HelperResult | null = null;
    const reconstruct: ClaudeChainReconstructor = async ({ sessionId, entries }) => {
      observed = await reconstructInChild({ sessionId, entries });
      const byUuid = new Map(entries.map((entry) => [entry.uuid, entry]));
      return observed.uuids.map((uuid) => {
        const entry = byUuid.get(uuid);
        return {
          type: (entry?.type ?? "user") as "user" | "assistant" | "system",
          uuid,
          session_id: sessionId,
          message: entry?.message,
          parent_tool_use_id: null,
          parent_agent_id: null,
        };
      });
    };

    const result = await parseTranscriptFile(FIXTURE, { reconstruct });
    const seen = observed as HelperResult | null;
    expect(seen).not.toBeNull();

    // The SDK read the supplied store once and called nothing else on it.
    expect(seen!.calls).toEqual(["load"]);
    expect(seen!.key?.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    // The project key came from the inert directory we made, not a real project.
    expect(seen!.key?.projectKey).toContain("inert-project");
    // The child ran with isolated homes and no provider credential at all.
    expect(seen!.homes.claudeHome).toContain("capygen-sdk-");
    expect(seen!.homes.codexHome).toContain("capygen-sdk-");
    expect(seen!.providerKeysInEnv).toEqual([]);

    // a-2 sits before its parent u-2 in the file; the SDK still orders the chain.
    expect(seen!.uuids).toEqual(["u-1", "a-1", "u-2", "a-2"]);
    expect(result.entries.map((entry) => `${entry.kind}:${entry.text}`)).toEqual([
      "message:Hello ünïcode ✨ — please read the loader",
      "thinking:The loader is in src/loader.ts",
      "message:Reading it now.",
      'activity:{\n  "file_path": "C:/work/src/loader.ts"\n}',
      "activity-result:export const loader = 1;",
      "message:Done — the loader is fine.",
    ]);
  }, 120_000);
});
