/**
 * The harness registry (SPEC R7/R8/R9): `agent.backend` → the adapter that
 * drives that backend. This is what makes the composer's backend picker mean
 * anything — before it, the session runner built a Claude harness whatever the
 * agent said it was.
 */
import { describe, expect, it } from "vitest";
import {
  ApiHarness,
  ClaudeHarness,
  CodexHarness,
  createHarnessForBackend,
} from "../src/index.js";
import type { Backend } from "@capygen/shared";

describe("createHarnessForBackend", () => {
  it("builds each backend's own harness, and says so on the instance", () => {
    const claude = createHarnessForBackend("claude");
    const codex = createHarnessForBackend("codex");
    const api = createHarnessForBackend("api");

    expect(claude).toBeInstanceOf(ClaudeHarness);
    expect(codex).toBeInstanceOf(CodexHarness);
    expect(api).toBeInstanceOf(ApiHarness);
    expect([claude.backend, codex.backend, api.backend]).toEqual(["claude", "codex", "api"]);
  });

  it("knows nothing until a session starts — construction is inert", () => {
    // The runner builds one harness per agent the moment a session is opened,
    // long before a turn runs. A constructor that connected would cost a
    // `codex app-server` child per agent in the sidebar, so what a fresh
    // harness can report is exactly nothing.
    for (const backend of ["claude", "codex", "api"] as const) {
      expect(createHarnessForBackend(backend).backendSessionId()).toBeNull();
    }
    // Codex is the one that has something to say before a session: its
    // built-ins are capygen's own list, not a backend listing. The skills that
    // join them come from `skills/list`, which needs a running app-server.
    const codexMenu = createHarnessForBackend("codex").listCommands();
    expect(codexMenu.every((c) => c.source === "builtin")).toBe(true);
    expect(createHarnessForBackend("claude").listCommands()).toEqual([]);
  });

  it("reports each backend's real capabilities rather than one shared answer", () => {
    const claude = createHarnessForBackend("claude").capabilities();
    const codex = createHarnessForBackend("codex").capabilities();
    const api = createHarnessForBackend("api").capabilities();

    expect(claude.subagents).toBe(true);
    // Codex's collabAgentToolCall items are unmapped, and the API loop has no
    // Task tool — both are Phase 4, and both say so instead of pretending.
    expect(codex.subagents).toBe(false);
    expect(api.subagents).toBe(false);
    // The API backend has no command list of its own; the composer's built-ins
    // come from the renderer.
    expect(api.slashCommands).toBe(false);
    expect(codex.slashCommands).toBe(true);
    for (const caps of [claude, codex, api]) {
      expect(caps.permissions).toBe(true);
      expect(caps.interrupt).toBe(true);
    }
  });

  it("refuses an unknown backend with a sentence instead of a Claude harness", () => {
    expect(() => createHarnessForBackend("ollama" as Backend)).toThrow(
      /no harness for the ollama backend/,
    );
  });

  it("only the API harness needs a key provider — the other two never ask for one", () => {
    // Injecting deps for a backend that is not being built must not be an
    // error, so the runner can wire all three once and forget about it.
    const asked: string[] = [];
    const deps = {
      api: { keys: { getKey: (p: string) => (asked.push(p), null) } },
    } as Parameters<typeof createHarnessForBackend>[1];
    expect(() => createHarnessForBackend("claude", deps)).not.toThrow();
    expect(() => createHarnessForBackend("codex", deps)).not.toThrow();
    expect(() => createHarnessForBackend("api", deps)).not.toThrow();
    // Nothing is resolved until a turn runs (R26: no start-up chatter).
    expect(asked).toEqual([]);
  });
});
