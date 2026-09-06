/**
 * Live check for the Codex harness — the real bundled `codex app-server`, the
 * real ChatGPT sign-in on this machine.
 *
 *   corepack pnpm --dir packages/engine live:codex
 *   corepack pnpm --dir packages/engine live:codex -- --model gpt-5.6-luna
 *
 * Two turns in one throwaway thread, in a temp directory:
 *
 *   1. "Reply with exactly the word pong." — proves text streaming, the turn
 *      boundary and usage accounting;
 *   2. a shell command under `approvalPolicy: "untrusted"`, which forces
 *      `item/commandExecution/requestApproval`. The approval is answered
 *      **accept**, programmatically, and the script asserts the command block
 *      came back with output. This is the only unattended `allow` in the
 *      repository, and it is one `echo` inside a `mkdtemp` directory.
 *
 * Nothing touches the app's database or a real project directory. Exits
 * non-zero unless turn 1 printed "pong" and turn 2 completed an approval.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexHarness } from "../src/codex/CodexHarness.js";
import type { EngineEvent } from "../src/harness.js";
import { requireIsolatedHomes, requirePinnedTestModel, TEST_CODEX_MODEL, TEST_EFFORT } from "./test-policy.js";

const argv = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1]) return argv[index + 1] as string;
  return fallback;
}

const model = flag("model", TEST_CODEX_MODEL);
const timeoutMs = Number(flag("timeout", "180000"));
const verbose = argv.includes("--verbose");
requireIsolatedHomes("live-codex");
requirePinnedTestModel("live-codex", model, TEST_CODEX_MODEL);

/**
 * `realpathSync.native` matters here: on this machine `os.tmpdir()` is the 8.3
 * short form `C:\Users\TUGAPL~1\AppData\Local\Temp`, and Codex's Windows
 * sandbox compares the command's cwd against the long form of the granted
 * workspace root — an approved command then failed with
 * "Access to the path … is denied" even though the approval had been accepted.
 */
const cwd = realpathSync.native(mkdtempSync(path.join(tmpdir(), "capygen-live-codex-")));
const harness = new CodexHarness({
  log: {
    info: (...a: unknown[]) => console.log("[info]", ...a),
    warn: (...a: unknown[]) => (verbose ? console.warn("[warn]", ...a) : undefined),
    error: (...a: unknown[]) => console.error("[error]", ...a),
  },
});

interface TurnResult {
  status: string;
  error?: string;
  text: string;
  blocks: Map<string, Record<string, unknown>>;
  usage: (EngineEvent & { type: "usage" }) | null;
  approvals: { tool: string; decision: string }[];
}

async function runTurn(turnId: string, prompt: string, allow: boolean): Promise<TurnResult> {
  const blocks = new Map<string, Record<string, unknown>>();
  const approvals: { tool: string; decision: string }[] = [];
  let usage: (EngineEvent & { type: "usage" }) | null = null;
  let status = "unknown";
  let error: string | undefined;

  console.log(`\n--- turn ${turnId}: ${JSON.stringify(prompt)}`);
  const timer = setTimeout(() => {
    console.error(`TIMEOUT after ${timeoutMs} ms — interrupting`);
    void harness.interrupt();
  }, timeoutMs);

  for await (const event of harness.send({ turnId, text: prompt })) {
    switch (event.type) {
      case "session":
        console.log(
          `thread ${event.backendSessionId} model=${event.model ?? "?"} ` +
            `commands=${event.commands?.length ?? 0}`,
        );
        break;
      case "block":
        blocks.set(event.key, event.patch as unknown as Record<string, unknown>);
        break;
      case "permission": {
        const decision = allow ? "allow" : "deny";
        console.log(
          `permission: ${event.request.toolName} ${JSON.stringify(event.request.input).slice(0, 160)}` +
            ` -> ${decision}`,
        );
        approvals.push({ tool: event.request.toolName, decision });
        harness.answerPermission(
          event.requestId,
          allow ? { behavior: "allow" } : { behavior: "deny", message: "live check" },
        );
        break;
      }
      case "question":
        console.log(`question: ${event.questions[0]?.question ?? "?"} — answering blank`);
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

  console.log(`blocks (${blocks.size}):`);
  for (const [key, patch] of blocks) {
    const summary =
      typeof patch.text === "string"
        ? JSON.stringify(patch.text)
        : JSON.stringify(patch).slice(0, 220);
    console.log(`  ${String(patch.kind).padEnd(10)} ${key.padEnd(46)} ${summary}`);
  }
  console.log(`turn: ${status}${error ? ` (${error})` : ""}`);
  if (usage) {
    console.log(
      `usage: in=${usage.usage.inputTokens} out=${usage.usage.outputTokens} ` +
        `cacheRead=${usage.usage.cacheReadTokens} ` +
        `cacheCreation=${usage.usage.cacheCreationTokens} ` +
        `cost=$${usage.usage.costUsd} [assumed]  byModel=${JSON.stringify(usage.byModel)}`,
    );
  } else {
    console.log("usage: none");
  }

  const text = [...blocks.values()]
    .filter((p) => p.kind === "text")
    .map((p) => String(p.text ?? ""))
    .join("");
  return { status, error, text, blocks, usage, approvals };
}

let exitCode = 0;

try {
  await harness.start(
    { sessionId: "ses_live", projectPath: cwd },
    {
      agentId: "agt_live",
      name: "capy",
      backend: "codex",
      model,
      resumeSessionId: null,
      // `untrusted` is what makes turn 2 ask: under the default `on-request`
      // Codex approves an `echo` inside the sandbox by itself and the approval
      // card the script is here to prove never appears.
      config: {
        codex: {
          approvalPolicy: "untrusted",
          sandbox: "workspace-write",
          reasoningEffort: TEST_EFFORT,
        },
      },
    },
  );
  console.log(`cwd:   ${cwd}`);
  console.log(`model: ${model}`);

  const first = await runTurn("trn_live_1", "Reply with exactly the word pong.", false);
  const second = await runTurn(
    "trn_live_2",
    "Run the shell command `echo capy` and tell me its exact output. Do not read any files.",
    true,
  );

  const pong = first.status === "done" && /pong/i.test(first.text);
  const command = [...second.blocks.values()].find(
    (p) => p.kind === "tool_call" && p.family === "bash",
  );
  const approved =
    second.approvals.some((a) => a.decision === "allow") &&
    command !== undefined &&
    command.status === "success";

  console.log(`\npong turn:     ${pong ? "PASS" : "FAIL"} — ${JSON.stringify(first.text.trim())}`);
  console.log(
    `approval turn: ${approved ? "PASS" : "FAIL"} — approvals=${JSON.stringify(second.approvals)}` +
      ` command=${command ? `${String(command.status)} ${JSON.stringify(command.output).slice(0, 80)}` : "none"}`,
  );
  console.log(`\nLIVE ${pong && approved ? "PASS" : "FAIL"}`);
  if (!pong || !approved) exitCode = 1;
} catch (err) {
  console.error("LIVE FAIL -", err);
  exitCode = 1;
} finally {
  await harness.dispose();
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.log(`(left ${cwd} behind: ${err instanceof Error ? err.message : String(err)})`);
  }
}

process.exit(exitCode);
