/**
 * `@capygen/engine` — the backend adapters (CONTEXT.md §Harness).
 *
 * Phase 2 shipped the Claude Code harness; Phase 3 adds Codex behind the same
 * `Harness` interface. The API-model loop follows.
 *
 * The Codex surface is re-exported **by name**, not with `export *`: both
 * harnesses declare a `HarnessLogger` and a `DEFAULT_MAX_TOOL_OUTPUT_CHARS`,
 * and a star re-export would silently drop one of each (TS ambiguous-export
 * rules) rather than fail loudly.
 */
export * from "./harness.js";
export * from "./asyncQueue.js";
export * from "./env.js";
export * from "./claude/sdk.js";
export * from "./claude/ClaudeHarness.js";

export {
  CodexHarness,
  CODEX_BUILTIN_COMMANDS,
  CODEX_UNAUTHORIZED,
  commandDecision,
  countDiff,
  readCodexConfig,
  DEFAULT_MAX_TOOL_OUTPUT_CHARS as CODEX_DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  type CodexHarnessDeps,
  type CodexAgentSettings,
} from "./codex/CodexHarness.js";
export {
  CodexAppServerClient,
  createStdioTransport,
  DEFAULT_REQUEST_TIMEOUT_MS as CODEX_DEFAULT_REQUEST_TIMEOUT_MS,
  type CodexAppServerClientOptions,
  type CodexExitInfo,
  type CodexServerRequestHandler,
  type CodexTransport,
  type CodexTransportFactory,
  type CodexTransportHandlers,
} from "./codex/CodexAppServerClient.js";
export {
  resolveCodexBinary,
  resolveBundledCodex,
  resolveInstalledCodex,
  type CodexBinary,
  type CodexBinarySource,
  type ResolveCodexBinaryOptions,
} from "./codex/binary.js";
export {
  CODEX_PRICES,
  codexUsageWithCost,
  estimateCodexCost,
  priceFor,
  readCodexUsage,
  type CodexPrice,
} from "./codex/pricing.js";
export * from "./codex/protocol.js";

import type { Backend } from "@capygen/shared";
import { ClaudeHarness, type ClaudeHarnessDeps } from "./claude/ClaudeHarness.js";
import { CodexHarness, type CodexHarnessDeps } from "./codex/CodexHarness.js";
import type { Harness } from "./harness.js";

/**
 * The whole registry, deliberately: a `switch`, not a plugin table.
 *
 * The session runner already owns one harness instance per agent
 * (`apps/desktop/src/engine/SessionRunner.ts`); all it lacks is a way to pick
 * the class from `agent.backend` without importing every harness itself. The
 * `api` backend is Phase 3's other task and throws here until it lands, so a
 * session created against it fails with a sentence instead of silently running
 * on Claude.
 */
export interface HarnessRegistryDeps {
  claude?: ClaudeHarnessDeps;
  codex?: CodexHarnessDeps;
}

export function createHarnessForBackend(
  backend: Backend,
  deps: HarnessRegistryDeps = {},
): Harness {
  switch (backend) {
    case "claude":
      return new ClaudeHarness(deps.claude ?? {});
    case "codex":
      return new CodexHarness(deps.codex ?? {});
    default:
      throw new Error(`capygen has no harness for the ${backend} backend yet`);
  }
}
