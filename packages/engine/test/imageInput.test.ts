/**
 * Image input, backend by backend.
 *
 * The claim under test is the one the feature exists for: an attached picture
 * reaches each backend as a **real image**, in that backend's own input shape —
 * never as base64 pasted into the prompt, never as a file path in prose, and
 * never silently dropped.
 *
 * The fixture image is written to a temp directory per test; nothing touches the
 * user's workspace or configuration, and no model is called.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeHarness } from "../src/claude/ClaudeHarness.js";
import { CodexHarness } from "../src/codex/CodexHarness.js";
import { anthropicMessages } from "../src/api/providers/anthropic.js";
import { openaiInput } from "../src/api/providers/openai.js";
import { redactImagesForSummary } from "../src/api/compaction.js";
import { ApiHarness } from "../src/api/ApiHarness.js";
import type { Provider, ProviderRequest } from "../src/api/providers/types.js";
import { encodeTurnImage } from "../src/images.js";
import { imageSupport, imageUnsupportedMessage, modelAcceptsImages } from "../src/vision.js";
import type { EngineEvent, HarnessAgent, HarnessSession, TurnImage } from "../src/harness.js";
import { createFakeAppServer } from "./codexFakeAppServer.js";
import { initMessage, makeFakeSdk, resultMessage } from "./fakeSdk.js";

/** A real 10-byte PNG: signature plus two bytes, enough for every sniff. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

const SESSION: HarnessSession = { sessionId: "ses_1", projectPath: "C:\\project" };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function storedImage(): TurnImage {
  const root = mkdtempSync(path.join(tmpdir(), "capygen-image-"));
  roots.push(root);
  const file = path.join(root, "att_1.png");
  writeFileSync(file, PNG);
  return { path: file, mediaType: "image/png", name: "shot.png", size: PNG.byteLength };
}

function drain(events: AsyncIterable<EngineEvent>): { events: EngineEvent[]; done: Promise<void> } {
  const seen: EngineEvent[] = [];
  const done = (async () => {
    for await (const event of events) seen.push(event);
  })();
  return { events: seen, done };
}

describe("Claude harness — image input", () => {
  it("sends the picture as an Anthropic image block alongside the text", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({ query: fake.query });
    const agent: HarnessAgent = { agentId: "agt_1", name: "capy", backend: "claude", model: "claude-sonnet-5" };
    await harness.start(SESSION, agent);

    const turn = drain(harness.send({ turnId: "trn_1", text: "what is this?", images: [storedImage()] }));
    fake.out.push(initMessage());
    fake.out.push(resultMessage("ok"));
    await turn.done;

    const message = fake.messages.at(-1)!;
    expect(message.message.content).toEqual([
      { type: "text", text: "what is this?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") },
      },
    ]);
    // The prompt text itself never carries the bytes.
    expect(fake.prompts.at(-1)).not.toContain(PNG.toString("base64").slice(0, 8) + "AAAA");
  });

  it("keeps a text-only turn's plain-string prompt untouched (R24)", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({ query: fake.query });
    await harness.start(SESSION, { agentId: "agt_1", name: "capy", backend: "claude", model: "claude-sonnet-5" });

    const turn = drain(harness.send({ turnId: "trn_1", text: "hello" }));
    fake.out.push(initMessage());
    fake.out.push(resultMessage("ok"));
    await turn.done;

    expect(fake.messages.at(-1)!.message.content).toBe("hello");
  });

  it("fails the turn when the stored file is gone, rather than sending the text alone", async () => {
    const fake = makeFakeSdk();
    const harness = new ClaudeHarness({ query: fake.query });
    await harness.start(SESSION, { agentId: "agt_1", name: "capy", backend: "claude", model: "claude-sonnet-5" });

    const missing: TurnImage = {
      path: path.join(tmpdir(), "capygen-missing", "nope.png"),
      mediaType: "image/png",
      name: "nope.png",
      size: 10,
    };
    const turn = drain(harness.send({ turnId: "trn_1", text: "what is this?", images: [missing] }));
    await turn.done;

    const status = turn.events.find((e) => e.type === "turn");
    expect(status).toMatchObject({ type: "turn", status: "error" });
    expect((status as { error?: string }).error).toContain("could not be read back");
    expect(fake.messages).toHaveLength(0);
  });
});

describe("Codex harness — image input", () => {
  it("sends a localImage input item (pinned v2/UserInput.ts), so no base64 crosses the protocol", async () => {
    const server = createFakeAppServer({
      handlers: {
        initialize: () => ({}),
        "thread/start": () => ({ thread: { id: "th_1" } }),
        "turn/start": () => ({ turn: { id: "tu_1" } }),
        "skills/list": () => ({ data: [] }),
      },
    });
    const harness = new CodexHarness({ transport: server.transport, requestTimeoutMs: 2_000 });
    await harness.start(SESSION, { agentId: "agt_1", name: "codex", backend: "codex", model: "gpt-5.5" });

    const image = storedImage();
    drain(harness.send({ turnId: "trn_1", text: "what is this?", images: [image] }));
    const started = await server.waitForRequest("turn/start");

    expect(started.params).toMatchObject({
      input: [
        { type: "text", text: "what is this?", text_elements: [] },
        { type: "localImage", path: image.path },
      ],
    });
    expect(JSON.stringify(started.params)).not.toContain(PNG.toString("base64"));
    await harness.dispose();
  });
});

describe("api provider adapters — image input", () => {
  it("maps one neutral image block to each provider's own shape", async () => {
    const encoded = await encodeTurnImage(storedImage());
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "what is this?" },
          { type: "image" as const, mediaType: encoded.mediaType, data: encoded.data },
        ],
      },
    ];

    expect(anthropicMessages(messages)[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: encoded.data } },
      ],
    });

    expect(openaiInput(messages)).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          { type: "input_image", image_url: `data:image/png;base64,${encoded.data}` },
        ],
      },
    ]);
  });

  it("never serialises image bytes into a compaction summary request", () => {
    const data = PNG.toString("base64");
    const redacted = redactImagesForSummary([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mediaType: "image/png", data },
        ],
      },
    ]);
    const json = JSON.stringify(redacted);
    expect(json).not.toContain(data);
    expect(json).toContain("[image attachment (image/png)]");
  });
});

describe("api context deduplication", () => {
  /** The scripted provider from `api.test.ts`, trimmed to what these need. */
  function scripted(): { requests: ProviderRequest[]; provider: Provider } {
    const requests: ProviderRequest[] = [];
    const provider: Provider = {
      provider: "anthropic",
      async *stream(request) {
        requests.push({
          ...request,
          messages: request.messages.map((m) => ({ role: m.role, content: m.content.map((b) => ({ ...b })) })),
        });
        yield { type: "content", index: 0, block: { type: "text", text: "ok" } };
        yield { type: "stop", reason: "end_turn" };
      },
    };
    return { requests, provider };
  }

  const apiAgent: HarnessAgent = {
    agentId: "agt_1",
    name: "Lead",
    backend: "api",
    model: "claude-sonnet-5",
    config: { api: { provider: "anthropic", model: "claude-sonnet-5" } },
  };

  function imageBlocks(request: ProviderRequest): { data: string }[] {
    return request.messages.flatMap((m) =>
      m.content.filter((b): b is Extract<typeof b, { type: "image" }> => b.type === "image"),
    );
  }

  it("does not send a picture the replayed history already carries", async () => {
    const image = storedImage();
    const encoded = await encodeTurnImage(image);
    const { provider, requests } = scripted();
    const harness = new ApiHarness({
      useMcp: false,
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
      // The stored user turn this send is *for* is already in the replay: the
      // history and `send` would otherwise both carry the same picture.
      loadHistory: () => [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", mediaType: encoded.mediaType, data: encoded.data },
          ],
        },
      ],
    });
    await harness.start(SESSION, apiAgent);

    for await (const _ of harness.send({ turnId: "trn_1", text: "what is this?", images: [image] }));

    expect(imageBlocks(requests[0]!)).toHaveLength(1);
    await harness.dispose();
  });

  it("does not repeat the same attachment on a later send in the same session", async () => {
    const image = storedImage();
    const { provider, requests } = scripted();
    const harness = new ApiHarness({
      useMcp: false,
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
    });
    await harness.start(SESSION, apiAgent);

    for await (const _ of harness.send({ turnId: "trn_1", text: "look", images: [image] }));
    expect(imageBlocks(requests[0]!)).toHaveLength(1);
    // A chain hop hands the same stored file to the same agent again.
    for await (const _ of harness.send({ turnId: "trn_2", text: "and now?", images: [image] }));
    expect(imageBlocks(requests[1]!)).toHaveLength(1);
    await harness.dispose();
  });

  it("does send it when the context no longer holds it — a compacted history", async () => {
    const image = storedImage();
    const { provider, requests } = scripted();
    const harness = new ApiHarness({
      useMcp: false,
      createProvider: async () => provider,
      keys: { getKey: () => "sk-test" },
      // What compaction leaves behind: a summary, with no picture in it. The
      // dedup must not treat the summary as "the model can still see it".
      loadHistory: () => [
        { role: "user", content: [{ type: "text", text: "[summary] the user attached a screenshot" }] },
      ],
    });
    await harness.start(SESSION, apiAgent);

    for await (const _ of harness.send({ turnId: "trn_1", text: "again", images: [image] }));
    expect(imageBlocks(requests[0]!)).toHaveLength(1);
    await harness.dispose();
  });
});

describe("vision availability", () => {
  it("allows the multimodal families and refuses anything unlisted", () => {
    expect(modelAcceptsImages("claude-sonnet-5")).toBe(true);
    expect(modelAcceptsImages("claude-3-5-haiku-20241022")).toBe(true);
    expect(modelAcceptsImages("gpt-5.5")).toBe(true);
    expect(modelAcceptsImages("anthropic/claude-opus-4-1")).toBe(true);
    // Fails closed: unknown or text-only ids are not guessed into "supported".
    expect(modelAcceptsImages("o3-mini")).toBe(false);
    expect(modelAcceptsImages("some-local-llm")).toBe(false);
    expect(modelAcceptsImages("")).toBe(false);
  });

  it("says 'cannot' only for a model known to be text-only, 'unverified' otherwise", () => {
    expect(imageSupport("claude-sonnet-5")).toBe("yes");
    expect(imageSupport("o3-mini")).toBe("no");
    expect(imageSupport("some-local-llm")).toBe("unknown");

    expect(imageUnsupportedMessage("Blind", "api", "o3-mini")).toContain("cannot read images");
    const unknown = imageUnsupportedMessage("Mystery", "api", "some-local-llm");
    expect(unknown).toContain("not a model capygen has verified");
    expect(unknown).toContain("may or may not read images");
    expect(unknown).not.toContain("cannot read images");
  });
});
