import { describe, expect, it } from "vitest";
import { AgentToolCatalogueSchema } from "./toolCatalogue.js";

describe("agent tool catalogue IPC metadata", () => {
  it("distinguishes lifecycle failures from connected empty servers", () => {
    for (const kind of ["unsupported", "notStarted", "error", "cancelled", "stale"]) {
      expect(AgentToolCatalogueSchema.parse({ kind })).toEqual({ kind });
    }
    expect(AgentToolCatalogueSchema.parse({ kind: "ok", truncated: false,
      servers: [{ name: "docs", state: "connected", tools: [], truncated: false }] })).toMatchObject({ kind: "ok" });
  });

  it("refuses backend details and oversized encoded metadata", () => {
    const server = { name: "docs", state: "connected", tools: ["search"], truncated: false };
    for (const key of ["url", "env", "headers", "schemas", "command", "error"]) {
      expect(AgentToolCatalogueSchema.safeParse({ kind: "ok", truncated: false,
        servers: [{ ...server, [key]: "private" }] }).success).toBe(false);
    }
    expect(AgentToolCatalogueSchema.safeParse({ kind: "error", message: "private" }).success).toBe(false);
    expect(AgentToolCatalogueSchema.safeParse({ kind: "ok", truncated: false,
      servers: Array.from({ length: 100 }, (_, index) => ({ ...server, name: `s${index}`,
        tools: Array.from({ length: 250 }, (_, tool) => `${tool}${'"'.repeat(500)}`) })) }).success).toBe(false);
  });
});
