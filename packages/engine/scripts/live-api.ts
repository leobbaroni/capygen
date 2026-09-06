/**
 * Live check for the API harness — a real provider, a real key, one real turn.
 *
 *   corepack pnpm --dir packages/engine live:api
 *   corepack pnpm --dir packages/engine live:api -- --provider openai --model gpt-5
 *   corepack pnpm --dir packages/engine live:api -- --tool
 *
 * **It costs money and it needs a key.** With no key for the chosen provider it
 * prints `SKIP` and the reason, and exits 0 — this machine has none of the three
 * environment variables set (SPEC §Current State), so that is the expected
 * result here and the script is still worth running as a regression check that
 * the harness composes and the SDK loads.
 *
 * Keys come from the environment only. The engine never reads a key from disk
 * (SPEC R21): in the app they arrive through the `KeyProvider` the desktop
 * injects out of Electron `safeStorage`, and no value is ever printed here —
 * only `maskKey`'s ends.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApiHarness } from "../src/api/ApiHarness.js";
import { ENV_KEY_NAMES, envKeyProvider, maskKey } from "../src/api/keys.js";
import type { EngineEvent } from "../src/harness.js";
import type { ApiProvider } from "@capygen/shared";

const argv = process.argv.slice(2);

function flag(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1]) return argv[index + 1] as string;
  return fallback;
}
const has = (name: string): boolean => argv.includes(`--${name}`);

const DEFAULT_MODELS: Record<ApiProvider, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5-mini",
  openrouter: "anthropic/claude-sonnet-4.5",
};

const provider = flag("provider", "anthropic") as ApiProvider;
if (!(provider in DEFAULT_MODELS)) {
  console.error(`unknown provider ${provider}; expected one of ${Object.keys(DEFAULT_MODELS)}`);
  process.exit(2);
}
const model = flag("model", DEFAULT_MODELS[provider]);
const timeoutMs = Number(flag("timeout", "180000"));
/** `--tool` proves the loop, not just the stream: it forces one read_file. */
const useTool = has("tool");
const prompt = flag(
  "prompt",
  useTool
    ? "Read the file ping.txt in the working directory and reply with exactly the word it contains."
    : "Reply with exactly the word pong.",
);

// `KeyProvider.getKey` may be async in general; the env one never is.
const key = (await envKeyProvider().getKey(provider)) as string | null;
if (!key) {
  console.log(
    `SKIP — no ${provider} key. Set ${ENV_KEY_NAMES[provider]} in the environment, ` +
      "or run this from the app where the desktop injects the stored key " +
      "(Settings ▸ API keys, Electron safeStorage).",
  );
  process.exit(0);
}

const cwd = mkdtempSync(path.join(tmpdir(), "capygen-live-api-"));
writeFileSync(path.join(cwd, "ping.txt"), "pong\n", "utf8");

const harness = new ApiHarness({
  // The generic MCP client would start the user's real servers; a smoke check
  // should prove the harness, not their configuration.
  useMcp: false,
  log: {
    info: (...a: unknown[]) => console.log("[info]", ...a),
    warn: (...a: unknown[]) => console.warn("[warn]", ...a),
    error: (...a: unknown[]) => console.error("[error]", ...a),
  },
});

let exitCode = 0;
let sawText = false;
let sawUsage = false;

try {
  await harness.start(
    { sessionId: "ses_live", projectPath: cwd },
    {
      agentId: "agt_live",
      name: "capy",
      backend: "api",
      model,
      // read_file is class `read`, which `default` allows; anything that writes
      // or executes would raise a card nobody is here to answer.
      permissionMode: "default",
      config: { api: { provider, model } },
    },
  );

  console.log(`provider: ${provider}`);
  console.log(`model:    ${model}`);
  console.log(`key:      ${maskKey(key)}`);
  console.log(`cwd:      ${cwd}`);
  console.log(`prompt:   ${JSON.stringify(prompt)}\n`);

  const timer = setTimeout(() => {
    console.error(`\nTIMEOUT after ${timeoutMs} ms — interrupting`);
    void harness.interrupt();
  }, timeoutMs);
  timer.unref?.();

  for await (const event of harness.send({ turnId: "trn_live", text: prompt })) {
    print(event);
  }
  clearTimeout(timer);

  if (!sawText) {
    console.error("\nFAIL — the turn produced no text block");
    exitCode = 1;
  } else if (!sawUsage) {
    console.error("\nFAIL — the turn produced no usage event");
    exitCode = 1;
  } else {
    console.log("\nOK");
  }
} catch (err) {
  console.error("\nFAIL —", err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  await harness.dispose();
  rmSync(cwd, { recursive: true, force: true });
}

process.exit(exitCode);

function print(event: EngineEvent): void {
  if (event.type === "block") {
    const patch = event.patch;
    if (patch.kind === "text") {
      sawText = true;
      console.log(`[text ${event.key}] ${patch.text}`);
      return;
    }
    if (patch.kind === "thinking") {
      console.log(`[thinking ${event.key}] ${patch.text.slice(0, 200)}`);
      return;
    }
    if (patch.kind === "tool_call") {
      console.log(
        `[tool ${patch.name} ${patch.status}] ${JSON.stringify(patch.input)}` +
          (patch.output === undefined ? "" : `\n  → ${String(patch.output).slice(0, 400)}`),
      );
      return;
    }
    if (patch.kind === "usage") {
      console.log(
        `[usage] ${patch.usage.inputTokens} in · ${patch.usage.outputTokens} out · ` +
          `${patch.usage.cacheReadTokens} cached · $${patch.usage.costUsd.toFixed(4)} (${patch.model})`,
      );
      return;
    }
    console.log(`[${patch.kind} ${event.key}]`, JSON.stringify(patch).slice(0, 400));
    return;
  }
  if (event.type === "usage") {
    sawUsage = true;
    return;
  }
  if (event.type === "turn") {
    console.log(`\n[turn] ${event.status}${event.error ? ` — ${event.error}` : ""}`);
    if (event.status !== "done") exitCode = 1;
    return;
  }
  if (event.type === "permission") {
    // Nobody is here to answer; deny so the turn can end instead of hanging.
    console.log(`[permission] ${event.request.toolName} — denying (no UI in this script)`);
    harness.answerPermission(event.requestId, {
      behavior: "deny",
      message: "live-api.ts runs unattended",
    });
    return;
  }
  if (event.type === "question") {
    console.log(`[question] ${event.questions.map((q) => q.question).join(" / ")} — skipping`);
    harness.answerQuestion(event.requestId, {});
  }
}
