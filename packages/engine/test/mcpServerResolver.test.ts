import { describe, expect, it } from "vitest";
import { resolveMcpServerConfigs, type McpServerConfig } from "../src/index.js";

function server(
  name: string,
  command: string,
  extra: Partial<McpServerConfig> = {},
): McpServerConfig {
  return { name, transport: "stdio", command, source: "agent", ...extra };
}

describe("resolveMcpServerConfigs", () => {
  it("resolves API names before filtering disabled higher-priority entries", () => {
    const resolved = resolveMcpServerConfigs({
      backend: "api",
      agent: [server("same", "agent", { disabled: true })],
      api: [server("same", "api"), server("api-only", "api")],
      claude: [server("same", "claude"), server("claude-only", "claude")],
      codex: [server("same", "codex"), server("codex-only", "codex")],
    });

    expect(resolved.map((entry) => [entry.name, entry.command])).toEqual([
      ["api-only", "api"],
      ["claude-only", "claude"],
      ["codex-only", "codex"],
    ]);
  });

  it("preserves the complete selected transport configuration", () => {
    const selected = server("complete", "node", {
      args: ["server.mjs"],
      cwd: "C:/fixtures/project",
      env: { TOKEN: "secret" },
      headers: { Authorization: "Bearer secret" },
    });
    expect(
      resolveMcpServerConfigs({ backend: "api", agent: [], api: [selected], claude: [], codex: [] }),
    ).toEqual([selected]);
  });
});
