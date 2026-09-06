/**
 * The round table's pure half (ADR-0002, SPEC R11/R23): who a message reaches,
 * what an agent is actually sent, and the one session-stable string it is
 * started with.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_DELTA_CHARS,
  buildAgentPrompt,
  buildRoundTablePrompt,
  chainStoppedMessage,
  contextDelta,
  findMentionTokens,
  hopAllowed,
  nextHopTargets,
  parseMentions,
  resolveTargets,
  speakerLabel,
  type RoundTableAgent,
  type SpeakerInfo,
  type TranscriptTurn,
} from "../src/index.js";

const alice: RoundTableAgent = {
  id: "agent_a",
  mentionName: "alice",
  displayName: "Alice",
  backend: "claude",
  model: "claude-opus-4-5",
  role: "lead",
};
const codex: RoundTableAgent = {
  id: "agent_c",
  mentionName: "codex",
  displayName: "Codex",
  backend: "codex",
  model: "gpt-5.5",
  role: "member",
};
const gpt: RoundTableAgent = {
  id: "agent_g",
  mentionName: "gpt",
  displayName: "GPT",
  backend: "api",
  model: "gpt-5",
  role: "member",
};
const AGENTS = [alice, codex, gpt];

const speakers: Map<string, SpeakerInfo> = new Map([
  [alice.id, { mentionName: alice.mentionName, backend: alice.backend }],
  [codex.id, { mentionName: codex.mentionName, backend: codex.backend }],
  [gpt.id, { mentionName: gpt.mentionName, backend: gpt.backend }],
]);

describe("mention parsing (SPEC R11)", () => {
  it("resolves in order, case-insensitively, and deduplicates", () => {
    const parsed = parseMentions("@Codex and @alice — then @codex again", AGENTS);
    expect(parsed.mentions.map((m) => m.mentionName)).toEqual(["codex", "alice"]);
    expect(parsed.unknown).toEqual([]);
  });

  it("ignores an email address rather than summoning its local part", () => {
    expect(parseMentions("write to alice@example.com", AGENTS).mentions).toEqual([]);
    // The same rule drops a URL handle, whose @ follows a slash.
    expect(parseMentions("https://x.com/@codex", AGENTS).mentions).toEqual([]);
  });

  it("ignores mentions inside inline code and fenced blocks", () => {
    expect(parseMentions("run `git log --format=%an @codex`", AGENTS).mentions).toEqual([]);
    const fenced = ["before", "```", "@codex do the thing", "```", "after"].join("\n");
    expect(parseMentions(fenced, AGENTS).mentions).toEqual([]);
    // …and the blanking keeps offsets intact for the mentions that survive.
    const mixed = "`@alice` but really @codex";
    const [only] = parseMentions(mixed, AGENTS).mentions;
    expect(only?.mentionName).toBe("codex");
    expect(mixed.slice(only!.index, only!.index + 6)).toBe("@codex");
  });

  it("reports an unknown @name instead of dropping it silently", () => {
    const parsed = parseMentions("@claud can you look?", AGENTS);
    expect(parsed.mentions).toEqual([]);
    expect(parsed.unknown).toEqual(["claud"]);
  });

  it("finds a name at the end of a sentence and inside markdown emphasis", () => {
    expect(findMentionTokens("**@codex**, thanks").map((t) => t.name)).toEqual(["codex"]);
    expect(parseMentions("over to @codex.", AGENTS).mentions[0]?.mentionName).toBe("codex");
  });
});

describe("targets (SPEC R11)", () => {
  it("goes to the mentioned agents, in mention order", () => {
    const targets = resolveTargets({
      text: "@gpt then @codex please",
      agents: AGENTS,
      leadAgentId: alice.id,
    });
    expect(targets.source).toBe("mentions");
    expect(targets.agents.map((a) => a.id)).toEqual([gpt.id, codex.id]);
  });

  it("falls back to the lead when nothing is mentioned", () => {
    const targets = resolveTargets({ text: "hello", agents: AGENTS, leadAgentId: alice.id });
    expect(targets.source).toBe("lead");
    expect(targets.agents.map((a) => a.id)).toEqual([alice.id]);
  });

  it("falls back to the first agent when the lead row is gone", () => {
    const targets = resolveTargets({ text: "hello", agents: AGENTS, leadAgentId: "agent_gone" });
    expect(targets.agents.map((a) => a.id)).toEqual([alice.id]);
  });

  it("an explicit pick beats a mention", () => {
    const targets = resolveTargets({
      text: "@codex look",
      agents: AGENTS,
      leadAgentId: alice.id,
      explicitAgentId: gpt.id,
    });
    expect(targets.source).toBe("explicit");
    expect(targets.agents.map((a) => a.id)).toEqual([gpt.id]);
  });

  it("a self-mention never hands the floor back to the speaker", () => {
    const next = nextHopTargets({
      text: "as @alice I think @codex should check this",
      speakerAgentId: alice.id,
      agents: AGENTS,
    });
    expect(next.map((a) => a.id)).toEqual([codex.id]);
  });

  it("the hop cap is an absolute index, so a user message resets it", () => {
    expect(hopAllowed(3, 3)).toBe(true);
    expect(hopAllowed(4, 3)).toBe(false);
    expect(chainStoppedMessage(3)).toMatch(/Chain stopped after 3 hops/);
  });
});

describe("context delta (SPEC R23)", () => {
  const transcript: TranscriptTurn[] = [
    { id: "t1", agentId: null, role: "user", text: "start the parser" },
    { id: "t2", agentId: alice.id, role: "agent", text: "done, moved it to mentions.ts" },
    { id: "t3", agentId: codex.id, role: "agent", text: "offsets still line up" },
    { id: "t4", agentId: gpt.id, role: "agent", text: "I checked the fenced case" },
  ];

  it("carries only the other speakers' turns since this agent's last one", () => {
    const delta = contextDelta({
      backend: "claude",
      agentId: alice.id,
      transcript,
      speakers,
      sinceTurnId: "t2",
      message: "",
    });
    expect(delta).toBe(
      "[@codex (Codex)]: offsets still line up\n[@gpt (API model)]: I checked the fenced case",
    );
    // Neither its own turn nor anything before it is replayed: the backend
    // session already remembers those.
    expect(delta).not.toContain("moved it to mentions.ts");
    expect(delta).not.toContain("start the parser");
  });

  it("labels the addressed message when another agent wrote it", () => {
    const prompt = buildAgentPrompt({
      backend: "codex",
      agentId: codex.id,
      transcript,
      speakers,
      sinceTurnId: "t3",
      exclude: ["t4"],
      message: "I checked the fenced case",
      messageFrom: gpt.id,
    });
    expect(prompt).toBe("[@gpt (API model)]: I checked the fenced case");
  });

  it("leaves a user message bare — it is the turn, not a quotation", () => {
    const prompt = buildAgentPrompt({
      backend: "claude",
      agentId: alice.id,
      transcript: [],
      speakers,
      message: "hello",
      messageFrom: null,
    });
    expect(prompt).toBe("hello");
  });

  it("drops the oldest lines rather than the newest when over budget", () => {
    const long: TranscriptTurn[] = Array.from({ length: 40 }, (_, i) => ({
      id: `x${i}`,
      agentId: codex.id,
      role: "agent" as const,
      text: `${i}: ${"y".repeat(400)}`,
    }));
    const delta = contextDelta({
      backend: "claude",
      agentId: alice.id,
      transcript: long,
      speakers,
      message: "",
    });
    expect(delta.length).toBeLessThanOrEqual(DEFAULT_MAX_DELTA_CHARS + 500);
    expect(delta).toContain("39: ");
    expect(delta).not.toContain("\n[@codex (Codex)]: 0: ");
  });

  it("starts from the beginning when the watermark turn is not in the transcript", () => {
    const delta = contextDelta({
      backend: "api",
      agentId: gpt.id,
      transcript,
      speakers,
      sinceTurnId: "t_from_another_session",
      message: "",
    });
    expect(delta).toContain("start the parser");
  });
});

describe("the session-stable prompt addition (SPEC R23/R24)", () => {
  it("says nothing at all for a solo session with no routing", () => {
    expect(
      buildRoundTablePrompt({ self: alice, agents: [alice], leadAgentId: alice.id, hopCap: 3 }),
    ).toBeNull();
  });

  it("names the participants, the convention and the hop cap", () => {
    const prompt = buildRoundTablePrompt({
      self: alice,
      agents: AGENTS,
      leadAgentId: alice.id,
      hopCap: 3,
    });
    expect(prompt).toContain(speakerLabel(alice));
    expect(prompt).toContain("@codex (Codex)");
    expect(prompt).toContain("@gpt (API model)");
    expect(prompt).toContain("stop after 3 hops");
    // It never lists the agent to itself as somebody to address.
    expect(prompt).not.toMatch(/^- @alice/m);
  });

  it("mentions delegate_task only when routing crosses backends", () => {
    const plain = buildRoundTablePrompt({
      self: alice,
      agents: AGENTS,
      leadAgentId: alice.id,
      hopCap: 3,
    });
    expect(plain).not.toContain("delegate_task");

    const routed = buildRoundTablePrompt({
      self: alice,
      agents: AGENTS,
      leadAgentId: alice.id,
      hopCap: 3,
      delegation: { backend: "codex", model: "gpt-5.5", toolName: "delegate_task" },
    });
    expect(routed).toContain("delegate_task");
    expect(routed).toContain("Codex (gpt-5.5)");
  });

  it("is offered even to a solo agent when its sub-agents are routed away", () => {
    const prompt = buildRoundTablePrompt({
      self: alice,
      agents: [alice],
      leadAgentId: alice.id,
      hopCap: 3,
      delegation: { backend: "api", model: "gpt-5", toolName: "delegate_task" },
    });
    expect(prompt).toContain("delegate_task");
  });
});
