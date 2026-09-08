import { access } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { probeClaudeModels } from "../src/claude/modelCatalogue.js";
import type { ClaudeQuery, ClaudeQueryFn } from "../src/claude/sdk.js";

it("reads exact model/effort initialization metadata without a user turn and cleans its workspace", async () => {
  let directory = "";
  let inputCount = 0;
  let inputDone: Promise<void> | undefined;
  const close = vi.fn();
  const query: ClaudeQueryFn = ({ prompt, options }) => {
    directory = options!.cwd!;
    expect(options).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, hooks: {}, persistSession: false, systemPrompt: "" });
    expect(options!.env!.CLAUDE_CONFIG_DIR).toBe("isolated-test-identity");
    inputDone = (async () => { for await (const _ of prompt as AsyncIterable<unknown>) inputCount++; })();
    return { close, supportedModels: async () => [
      { value: "sonnet", resolvedModel: "claude-sonnet-test", displayName: "Sonnet", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium"] },
      { value: "unknown", displayName: "Unknown", description: "" },
      { value: "disabled", displayName: "Disabled", description: "", supportsEffort: false, supportedEffortLevels: ["low"] },
    ] } as unknown as ClaudeQuery;
  };
  const result = await probeClaudeModels({ query, env: { CLAUDE_CONFIG_DIR: "isolated-test-identity" } });
  expect(result.models).toEqual([
    { id: "claude-sonnet-test", label: "Sonnet", efforts: ["low", "medium"] },
    { id: "unknown", label: "Unknown", efforts: [] },
    { id: "disabled", label: "Disabled", efforts: [] },
  ]);
  await inputDone;
  expect(inputCount).toBe(0);
  expect(close).toHaveBeenCalledOnce();
  await expect(access(directory)).rejects.toThrow();
});

it("bounds a stalled metadata initialization, closes it, and reports no invented models", async () => {
  const close = vi.fn();
  const query = (() => ({ close, supportedModels: () => new Promise(() => {}) })) as unknown as ClaudeQueryFn;
  const result = await probeClaudeModels({ query, env: {}, timeoutMs: 10 });
  expect(result.models).toEqual([]);
  expect(result.reason).toBe("Claude model catalogue is unavailable");
  expect(close).toHaveBeenCalledOnce();
});
