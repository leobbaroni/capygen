/**
 * Runs the installed Claude Agent SDK's `getSessionMessages` against the
 * *production* read-only store adapter (`createReadOnlySessionStore` from
 * `src/imports/claude.ts`), in a child process.
 *
 * It lives here, and not in the vitest process, for one reason: the SDK's
 * backend homes have to be isolated before the module is imported. Setting
 * `CLAUDE_CONFIG_DIR` inside a running test process would mutate global state
 * the rest of the suite shares, and leaving it unset would let the SDK look at
 * the real `~/.claude` — both are forbidden. The caller therefore passes an
 * already-cleaned environment (isolated homes, no provider keys, no nested
 * session markers) at the `execFile` boundary; this file refuses to run without
 * it rather than quietly inventing its own.
 *
 * Run it through tsx so the TypeScript source can be imported directly:
 *   node --import tsx/esm sdkReconstruct.mjs <path-to-json>
 *   input:  { "sessionId": "...", "entries": [ …projected store entries… ] }
 *   output: { "calls": [...], "key": {...}, "uuids": [...], "homes": {...} }
 *
 * No model call, no CLI spawn, no prompt, no auth read.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: node --import tsx/esm sdkReconstruct.mjs <path-to-json>");
  process.exit(2);
}

const claudeHome = process.env.CLAUDE_CONFIG_DIR;
const codexHome = process.env.CODEX_HOME;
const projectDir = process.env.CAPYGEN_IMPORT_PROJECT_DIR;
for (const [name, value] of Object.entries({
  CLAUDE_CONFIG_DIR: claudeHome,
  CODEX_HOME: codexHome,
  CAPYGEN_IMPORT_PROJECT_DIR: projectDir,
})) {
  if (!value || !existsSync(value)) {
    console.error(`${name} must point at an existing isolated directory`);
    process.exit(3);
  }
}

const { sessionId, entries } = JSON.parse(readFileSync(inputPath, "utf8"));

// The real adapter under test, imported from source through tsx.
const { createReadOnlySessionStore } = await import("../../../src/imports/claude.js");
const require = createRequire(import.meta.url);
const { getSessionMessages } = await import(
  pathToFileURL(require.resolve("@anthropic-ai/claude-agent-sdk")).href
);

const store = createReadOnlySessionStore(entries);
const calls = [];
let lastKey = null;
// Wrapped, not replaced: the production refusals are what the SDK actually meets.
const observed = {};
for (const method of [
  "load",
  "append",
  "delete",
  "listSessions",
  "listSessionSummaries",
  "listSubkeys",
]) {
  observed[method] = async (...args) => {
    calls.push(method);
    if (method === "load") lastKey = args[0] ?? null;
    return store[method](...args);
  };
}

const messages = await getSessionMessages(sessionId, { dir: projectDir, sessionStore: observed });
process.stdout.write(
  JSON.stringify({
    calls,
    key: lastKey,
    uuids: messages.map((message) => message.uuid),
    messages: messages.map(({ type, uuid, session_id, message }) => ({
      type,
      uuid,
      session_id,
      message,
    })),
    homes: { claudeHome, codexHome, projectDir },
    // Proof that no provider credential was handed to the child.
    providerKeysInEnv: Object.keys(process.env).filter((key) =>
      /(_API_KEY|_TOKEN|ANTHROPIC|OPENAI|OPENROUTER)/i.test(key),
    ),
  }),
);
