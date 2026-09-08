import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, type EnvRecord } from "../env.js";
import { loadClaudeQuery, type ClaudeQuery, type ClaudeQueryFn, type SDKUserMessage } from "./sdk.js";

export interface ClaudeCatalogueModel { id: string; label: string; efforts: string[] }
export interface ClaudeModelProbeResult { models: ClaudeCatalogueModel[]; reason?: string }
export interface ClaudeModelProbeDeps { query?: ClaudeQueryFn; env?: EnvRecord; timeoutMs?: number }

/** SDK supportedModels reads initialize.models. The input stream never yields a user message. */
export async function probeClaudeModels(deps: ClaudeModelProbeDeps = {}): Promise<ClaudeModelProbeResult> {
  const abort = new AbortController();
  let query: ClaudeQuery | undefined;
  let directory: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let endInput: (() => void) | undefined;
  const input: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        endInput = () => resolve({ done: true, value: undefined });
        if (abort.signal.aborted) endInput();
      }) };
    },
  };
  try {
    // Only our workspace is created/deleted. The authenticated backend home is never copied.
    directory = await mkdtemp(join(tmpdir(), "capygen-claude-models-"));
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); endInput?.(); reject(new Error("timeout")); }, Math.min(5000, Math.max(1, deps.timeoutMs ?? 5000)));
    });
    const probe = async () => {
      const queryFn = deps.query ?? await loadClaudeQuery();
      if (abort.signal.aborted) throw new Error("cancelled");
      query = queryFn({ prompt: input, options: {
        cwd: directory, env: cleanEnv(deps.env), abortController: abort,
        tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, hooks: {},
        systemPrompt: "", maxTurns: 1, persistSession: false, enableFileCheckpointing: false,
        canUseTool: async () => ({ behavior: "deny", message: "Metadata probe has no tools" }),
        stderr: () => {},
      } });
      const rows = await query.supportedModels();
      if (!Array.isArray(rows) || rows.length > 256 || Buffer.byteLength(JSON.stringify(rows), "utf8") > 65536) throw new Error("Invalid catalogue");
      const models = new Map<string, ClaudeCatalogueModel>();
      for (const row of rows) {
        const id = row.resolvedModel ?? row.value;
        if (typeof id !== "string" || !id.trim() || id.length > 200 || typeof row.displayName !== "string" || row.displayName.length > 200) continue;
        const efforts = row.supportsEffort === false ? [] : [...new Set((row.supportedEffortLevels ?? [])
          .filter((effort) => ["low", "medium", "high", "xhigh", "max"].includes(effort)))];
        if (!models.has(id)) models.set(id, { id, label: row.displayName || id, efforts });
      }
      return { models: [...models.values()] };
    };
    return await Promise.race([probe(), timeout]);
  } catch {
    return { models: [], reason: "Claude model catalogue is unavailable" };
  } finally {
    if (timer) clearTimeout(timer);
    abort.abort();
    endInput?.();
    try { query?.close(); } catch { /* metadata errors never leak backend output */ }
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
