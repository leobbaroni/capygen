import { expect, it, vi } from "vitest";
import { createSharedSkillsMcpServer } from "../src/engine/sharedSkillsMcp.js";
import type { ClaudeSdkMcpApi } from "@capygen/engine";
import type { ToolDefinition } from "../../../packages/engine/src/tools/types.js";

it("registers only shared skill tools, validates native arguments, forwards pages and never leaks fullOutput", async () => {
  const handlers = new Map<string, Parameters<ClaudeSdkMcpApi["tool"]>[3]>();
  const sdk: ClaudeSdkMcpApi = {
    tool: (name, _description, _schema, handler) => { handlers.set(name, handler); return { name }; },
    createSdkMcpServer: (options) => ({ type: "sdk", ...options }),
  };
  const run = vi.fn(async (_input: Record<string, unknown>) => ({ content: JSON.stringify({ text: "instructions", nextOffset: 8192 }) }));
  const definition: ToolDefinition = { name: "read_skill", description: "read", parameters: { type: "object", properties: {} }, family: "read", permissionClass: "read", run };
  const result = await createSharedSkillsMcpServer({ tools: [definition, { ...definition, name: "other_tool" }], projectPath: "C:/owned-fixture", log: { info() {}, warn() {}, error() {} }, loadSdk: async () => sdk });
  expect(result.capygen_skills).toMatchObject({ name: "capygen_skills", tools: [{ name: "read_skill" }] });
  const handler = handlers.get("read_skill")!;
  expect(await handler({ id: "a".repeat(64), offset: 8192 }, {})).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ text: "instructions", nextOffset: 8192 }) }] });
  expect(run.mock.calls[0]?.[0]).toEqual({ id: "a".repeat(64), offset: 8192 });
  expect(await handler({ id: "a".repeat(64), path: "C:/secret" }, {})).toMatchObject({ isError: true });
  expect(run).toHaveBeenCalledTimes(1);
  run.mockResolvedValueOnce({ content: "x".repeat(70_000) });
  expect(await handler({ id: "a".repeat(64) }, {})).toMatchObject({ isError: true });
});
