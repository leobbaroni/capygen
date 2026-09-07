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
  probeCodex,
  type CodexAccountInfo,
  type CodexProbeResult,
  type ProbeCodexOptions,
} from "./codex/account.js";
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

/**
 * [B3] The MCP Apps widget host (SPEC R31). Exported from the package root
 * because `apps/desktop` consumes it and `@capygen/engine` declares a single
 * `"."` entry point. It *uses* the generic client's `MCP_TOOL_PREFIX` /
 * `sanitizeSegment` without re-declaring them, so adding
 * `export * from "./mcp/client/index.js"` here later cannot make either name
 * ambiguous.
 */
export * from "./mcp/client/index.js";
export * from "./mcp/apps/index.js";

/**
 * The API-model backend (SPEC R9). `api/index.ts` is a curated surface rather
 * than a star re-export of the folder precisely so this line is safe: the three
 * names that would collide with the Claude/Codex surface are pre-aliased there
 * (`API_DEFAULT_MAX_TOOL_OUTPUT_CHARS`, `ApiHarnessLogger`, `apiPriceFor`).
 */
export * from "./api/index.js";

/**
 * [B3] `agents.describe` (SPEC R13): one pure `describe*Agent` function per
 * backend, each returning `AgentDescribeCore` (everything but usage/others —
 * `apps/desktop/src/ipc/agentsDescribe.ts` composes those on top with
 * `composeAgentDescribe`). Claude's and the API loop's own `describe.ts` sit
 * next to their harness files, where the wire shapes they read are already
 * documented; Codex's lives in `./describe/codex.ts` instead (its header
 * explains why). Named per-file exports, not folded into `api/index.js`,
 * because `api/index.ts` is itself a curated (non-`export *`) surface this
 * task does not own.
 */
export * from "./claude/describe.js";
export * from "./api/describe.js";
export * from "./describe/index.js";

/**
 * [B1] Round-table dispatch (ADR-0002, SPEC R10-R13, R23) and sub-agent
 * routing (R12). Both are pure module trees — no database, no Electron — so
 * `apps/desktop` can own the stateful half (`engine/RoundTable.ts`) while the
 * rules live next to the harnesses they steer.
 */
export * from "./roundtable/index.js";
export * from "./routing/index.js";

/**
 * [B1] The config-sync engine (Phase 6, SPEC R19-R21, R28-R30): the Claude and
 * Codex config stores, the comment-preserving TOML patcher they write through,
 * the settings layering rules and the prerequisites list. Pure Node, no
 * Electron — `apps/desktop/src/integrations/**` owns the watchers, the SQLite
 * cache and the IPC on top.
 *
 * Safe as an `export *`: `config/types.ts` re-exports nothing, and the two
 * names that could have collided with the MCP client surface above
 * (`McpServerConfig`, `loadMcpServers`) are not declared here — the stores
 * speak `@capygen/shared`'s `McpServerEntry`, which is the *settings* shape,
 * not the *connection* shape.
 */
export * from "./config/index.js";

import type { Backend } from "@capygen/shared";
import { ApiHarness, type ApiHarnessDeps } from "./api/ApiHarness.js";
import { ClaudeHarness, type ClaudeHarnessDeps } from "./claude/ClaudeHarness.js";
import { CodexHarness, type CodexHarnessDeps } from "./codex/CodexHarness.js";
import type { Harness } from "./harness.js";

/**
 * The whole registry, deliberately: a `switch`, not a plugin table.
 *
 * The session runner already owns one harness instance per agent
 * (`apps/desktop/src/engine/SessionRunner.ts`); all it lacks is a way to pick
 * the class from `agent.backend` without importing every harness itself.
 *
 * The `default` branch is not dead code: `Backend` is a zod enum that a future
 * phase widens, and an unmapped backend has to fail with a sentence rather
 * than silently running on Claude.
 */
export interface HarnessRegistryDeps {
  claude?: ClaudeHarnessDeps;
  codex?: CodexHarnessDeps;
  api?: ApiHarnessDeps;
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
    case "api":
      return new ApiHarness(deps.api ?? {});
    default:
      throw new Error(`capygen has no harness for the ${backend as string} backend yet`);
  }
}

// Inert transcript parsing; callers supply the isolated Claude reconstruction boundary.
export {
  parseTranscriptFile,
  createSdkChainReconstructor,
  ImportError,
  IMPORT_LIMITS,
  type ParseTranscriptOptions,
  type ImportedTranscript,
  type ImportedEntry,
  type ImportCounts,
  type ImportWarning,
  type ClaudeChainReconstructor,
} from "./imports/index.js";
