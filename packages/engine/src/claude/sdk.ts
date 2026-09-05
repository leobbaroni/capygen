/**
 * The Claude Agent SDK surface capygen depends on, and how it is loaded.
 *
 * Only *types* are imported statically. The runtime module is pulled in lazily
 * with `import()` so that:
 *
 *   - unit tests can inject a fake `query` and never touch the real SDK,
 *   - the Electron main bundle keeps `@anthropic-ai/claude-agent-sdk` external.
 *     That matters: the SDK finds its bundled `claude.exe` through
 *     `createRequire(import.meta.url).resolve(...)` (grep `import.meta.url` in
 *     `sdk.mjs`), which an inlined copy inside `main.cjs` could not resolve.
 *     Verified with `node -e "require('@anthropic-ai/claude-agent-sdk')"` →
 *     `query = function`: `require()` of this ESM-only package works on Node
 *     22.12+ / Electron 44, so esbuild's `import()` → `require()` rewrite in the
 *     CJS bundle is safe.
 *
 * Pinned contract: see COMPAT.md.
 */
import type {
  HookInput,
  HookJSONOutput,
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type {
  Options as ClaudeOptions,
  Query as ClaudeQuery,
  HookInput as ClaudeHookInput,
  HookJSONOutput as ClaudeHookOutput,
  SDKUserMessage,
};

/** Exactly `query`'s signature — a fake must be shape-compatible with the real one. */
export type ClaudeQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

export const CLAUDE_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

let cached: Promise<ClaudeQueryFn> | null = null;

/** Resolve the real `query`, once per process. */
export function loadClaudeQuery(): Promise<ClaudeQueryFn> {
  cached ??= (async (): Promise<ClaudeQueryFn> => {
    const mod: unknown = await import(CLAUDE_SDK_PACKAGE);
    const query = (mod as { query?: unknown }).query;
    if (typeof query !== "function") {
      throw new Error(
        `${CLAUDE_SDK_PACKAGE} loaded but exports no query(); got ${typeof query}`,
      );
    }
    return query as ClaudeQueryFn;
  })().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}
