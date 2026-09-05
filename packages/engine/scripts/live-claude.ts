/**
 * Live check for the Claude harness — the real SDK, the real signed-in CLI.
 *
 *   corepack pnpm --dir packages/engine live:claude
 *   corepack pnpm --dir packages/engine live:claude -- --prompt "/context"
 *
 * It starts a throwaway session in a temp directory, sends one prompt, prints
 * every block the harness produced and the usage event that closed the turn,
 * and exits non-zero if the reply or the usage is missing. Nothing is written to
 * the app's database and no project directory is touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeHarness } from "../src/claude/ClaudeHarness.js";
import type { EngineEvent } from "../src/harness.js";

const argv = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1]) return argv[index + 1] as string;
  return fallback;
}

const prompt = flag("prompt", "Reply with exactly the word pong.");
const model = flag("model", "claude-sonnet-5");
const timeoutMs = Number(flag("timeout", "120000"));

const cwd = mkdtempSync(path.join(tmpdir(), "capygen-live-"));
const harness = new ClaudeHarness({
  log: {
    info: (...a: unknown[]) => console.log("[info]", ...a),
    warn: (...a: unknown[]) => console.warn("[warn]", ...a),
    error: (...a: unknown[]) => console.error("[error]", ...a),
  },
});

let exitCode = 0;

try {
  await harness.start(
    { sessionId: "ses_live", projectPath: cwd },
    {
      agentId: "agt_live",
      name: "capy",
      backend: "claude",
      model,
      permissionMode: "default",
      resumeSessionId: null,
    },
  );

  console.log(`prompt: ${JSON.stringify(prompt)}`);
  console.log(`cwd:    ${cwd}`);
  console.log(`model:  ${model}\n`);

  const timer = setTimeout(() => {
    console.error(`\nTIMEOUT after ${timeoutMs} ms — interrupting`);
    void harness.interrupt();
  }, timeoutMs);

  /** Latest state per block key, printed once the turn ends. */
  const blocks = new Map<string, EngineEvent & { type: "block" }>();
  let usage: (EngineEvent & { type: "usage" }) | null = null;
  let status = "unknown";
  let error: string | undefined;

  for await (const event of harness.send({ turnId: "trn_live", text: prompt })) {
    switch (event.type) {
      case "session":
        console.log(
          `session ${event.backendSessionId} model=${event.model ?? "?"} ` +
            `commands=${event.commands?.length ?? 0}`,
        );
        break;
      case "block":
        blocks.set(event.key, event);
        break;
      case "permission":
        console.log(`permission asked for ${event.request.toolName} — denying (live check)`);
        harness.answerPermission(event.requestId, {
          behavior: "deny",
          message: "live check runs unattended",
        });
        break;
      case "question":
        console.log(`question asked: ${event.questions[0]?.question ?? "?"} — answering blank`);
        harness.answerQuestion(event.requestId, {});
        break;
      case "usage":
        usage = event;
        break;
      case "turn":
        status = event.status;
        error = event.error;
        break;
    }
  }
  clearTimeout(timer);

  console.log(`\nblocks (${blocks.size}):`);
  for (const [key, block] of blocks) {
    const patch = block.patch as Record<string, unknown>;
    const summary =
      typeof patch.text === "string"
        ? JSON.stringify(patch.text)
        : JSON.stringify(patch).slice(0, 200);
    console.log(`  ${String(patch.kind).padEnd(10)} ${key.padEnd(28)} ${summary}`);
  }

  console.log(`\nturn: ${status}${error ? ` (${error})` : ""}`);
  if (usage) {
    console.log(
      `usage: in=${usage.usage.inputTokens} out=${usage.usage.outputTokens} ` +
        `cacheRead=${usage.usage.cacheReadTokens} ` +
        `cacheCreation=${usage.usage.cacheCreationTokens} ` +
        `cost=$${usage.usage.costUsd}`,
    );
    console.log(`byModel: ${JSON.stringify(usage.byModel)}`);
  } else {
    console.log("usage: none");
  }

  const text = [...blocks.values()]
    .map((b) => (b.patch as { kind: string; text?: string }))
    .filter((p) => p.kind === "text")
    .map((p) => p.text ?? "")
    .join("");

  const ok = status === "done" && text.trim().length > 0 && (usage?.usage.costUsd ?? 0) > 0;
  console.log(
    `\nLIVE ${ok ? "PASS" : "FAIL"} - text=${JSON.stringify(text.trim().slice(0, 80))} ` +
      `cost=${usage?.usage.costUsd ?? 0}`,
  );
  if (!ok) exitCode = 1;
} catch (err) {
  console.error("LIVE FAIL -", err);
  exitCode = 1;
} finally {
  await harness.dispose();
  // The child holds `cwd` open for a moment after the abort; on Windows that is
  // an EBUSY on rmdir, which must not fail an otherwise green check.
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.log(`(left ${cwd} behind: ${err instanceof Error ? err.message : String(err)})`);
  }
}

process.exit(exitCode);
