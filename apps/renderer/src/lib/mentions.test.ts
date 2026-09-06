import { describe, expect, it } from "vitest";
import type { Agent } from "@capygen/shared";
import { activeMentionQuery, insertMention, parseMentions } from "./mentions";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "a1",
    sessionId: "s1",
    name: "codex",
    displayName: "Codex",
    mentionName: "codex",
    backend: "codex",
    model: "gpt-5.5",
    role: "member",
    order: 0,
    config: null,
    createdAt: 0,
    ...overrides,
  };
}

describe("parseMentions", () => {
  const codex = agent({ id: "a-codex", mentionName: "codex" });
  const capy = agent({ id: "a-capy", mentionName: "capy", displayName: "Capy" });

  it("finds a mentioned agent by mentionName, case-insensitively", () => {
    expect(parseMentions("hey @Codex can you look", [codex, capy]).map((a) => a.id)).toEqual([
      "a-codex",
    ]);
  });

  it("returns agents in first-occurrence order (ADR-0002)", () => {
    expect(parseMentions("@capy then @codex", [codex, capy]).map((a) => a.id)).toEqual([
      "a-capy",
      "a-codex",
    ]);
  });

  it("de-duplicates a repeated mention, keeping the first position", () => {
    expect(parseMentions("@codex ... @codex again", [codex, capy]).map((a) => a.id)).toEqual([
      "a-codex",
    ]);
  });

  it("ignores an @token that matches no agent", () => {
    expect(parseMentions("email me at user@example.com", [codex, capy])).toEqual([]);
  });

  it("ignores an email-shaped @ with no preceding whitespace", () => {
    expect(parseMentions("ping bob@codex.dev", [codex, capy])).toEqual([]);
  });

  it("returns nothing for plain text", () => {
    expect(parseMentions("just a normal message", [codex, capy])).toEqual([]);
  });
});

describe("activeMentionQuery", () => {
  it("detects an in-progress mention ending at the caret", () => {
    const text = "hey @cod";
    expect(activeMentionQuery(text, text.length)).toEqual({ start: 4, query: "cod" });
  });

  it("detects a bare '@' with an empty query", () => {
    const text = "@";
    expect(activeMentionQuery(text, 1)).toEqual({ start: 0, query: "" });
  });

  it("returns null once the mention is closed by a space", () => {
    expect(activeMentionQuery("hey @codex ", 11)).toBeNull();
  });

  it("returns null when the caret is not inside any @token", () => {
    expect(activeMentionQuery("no mentions here", 5)).toBeNull();
  });

  it("looks at the caret position, not the end of the string", () => {
    // Caret placed right after "@cod" even though more text follows it.
    const text = "@codex rest of the message";
    expect(activeMentionQuery(text, 4)).toEqual({ start: 0, query: "cod" });
  });
});

describe("insertMention", () => {
  it("replaces the in-progress query with the finished mention plus a trailing space", () => {
    const text = "hey @cod";
    const query = activeMentionQuery(text, text.length)!;
    const result = insertMention(text, query, "codex");
    expect(result.text).toBe("hey @codex ");
    expect(result.caret).toBe(result.text.length);
  });

  it("preserves text that follows the mention", () => {
    const text = "@cod please review";
    const query = { start: 0, query: "cod" };
    const result = insertMention(text, query, "codex");
    expect(result.text).toBe("@codex please review");
  });
});
