import { z } from "zod";
import { loadClaudeSdkMcpApi, type ClaudeSdkMcpApi } from "@capygen/engine";
import type { ToolDefinition, ToolLogger } from "../../../../packages/engine/src/tools/types.js";

/** Native Claude receives exactly the same paginated reader as API/Codex. */
export async function createSharedSkillsMcpServer(deps: {
  tools: ToolDefinition[];
  projectPath: string;
  log: ToolLogger;
  loadSdk?: () => Promise<ClaudeSdkMcpApi>;
}): Promise<Record<string, unknown>> {
  const sdk = await (deps.loadSdk ?? loadClaudeSdkMcpApi)();
  const tools = deps.tools.filter((tool) => tool.name === "list_skills" || tool.name === "read_skill").map((tool) => {
    const offset = z.number().int().nonnegative().safe().optional();
    const shape = tool.name === "read_skill" ? { id: z.string().regex(/^[a-f0-9]{64}$/), offset } : { offset };
    const schema = z.object(shape).strict();
    return sdk.tool(tool.name, tool.description, shape, async (input, extra) => {
      try {
        const parsed = schema.safeParse(input);
        if (!parsed.success) return { isError: true, content: [{ type: "text", text: "Invalid shared skill arguments." }] };
        const signal = (extra as { signal?: AbortSignal } | null)?.signal;
        if (signal?.aborted) return { isError: true, content: [{ type: "text", text: "Skill read cancelled." }] };
        const result = await tool.run(parsed.data, {
          cwd: deps.projectPath, ...(signal ? { signal } : {}), log: deps.log, maxOutputChars: 64 * 1024,
          ask: async () => { throw new Error("Shared skill readers cannot ask questions."); },
        });
        // Never pretend a native SDK result retained fullOutput: the shared
        // reader uses explicit pages, and an oversized replacement fails closed.
        if (result.truncated || Buffer.byteLength(result.content) > 64 * 1024) return { isError: true, content: [{ type: "text", text: "Skill result exceeded its page limit and could not be returned." }] };
        return { ...(result.isError ? { isError: true } : {}), content: [{ type: "text", text: result.content }] };
      } catch {
        deps.log.warn("[shared-skills] Native skill read failed");
        return { isError: true, content: [{ type: "text", text: "Shared skill is unavailable. List skills again." }] };
      }
    });
  });
  return { capygen_skills: sdk.createSdkMcpServer({ name: "capygen_skills", version: "1.0.0", tools }) };
}
