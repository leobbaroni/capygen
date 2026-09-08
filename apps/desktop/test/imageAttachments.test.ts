/**
 * Image attachments end to end in the main process: what `chat.send` stores,
 * what the transcript keeps across a restart, what each agent in a chain is
 * actually handed, and what an `api` agent's replayed history carries.
 *
 * Everything runs against a temp database and a temp attachment root. No model
 * is called, nothing is installed, and no user configuration is read or written.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type CapygenStore } from "@capygen/db";
import {
  parseInvokeArgs,
  parseInvokeResult,
  type Block,
  type InvokeChannel,
  type SlashCommand,
} from "@capygen/shared";
import type { EngineEvent, HarnessCapabilities, TurnImage } from "@capygen/engine";
import { AttachmentStore } from "../src/ipc/attachments.js";
import { createIpcContext, type IpcContext } from "../src/ipc/handlers.js";
import { createSessionRunner } from "../src/engine/SessionRunner.js";
import { loadApiHistory } from "../src/engine/history.js";
import type { EngineDeps } from "../src/engine/types.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const PNG_BASE64 = PNG.toString("base64");
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01]);

/** A harness that records what it was sent and answers immediately. */
class Recorder {
  readonly backend: "claude" | "codex" | "api";
  readonly sends: { text: string; images: readonly TurnImage[] }[] = [];
  constructor(backend: "claude" | "codex" | "api", private readonly reply = "ok") {
    this.backend = backend;
  }
  async start(): Promise<void> {}
  send(input: { turnId: string; text: string; images?: readonly TurnImage[] }): AsyncIterable<EngineEvent> {
    this.sends.push({ text: input.text, images: input.images ?? [] });
    const reply = this.reply;
    return (async function* (): AsyncGenerator<EngineEvent> {
      yield { type: "block", key: "msg:0", patch: { kind: "text", text: reply } };
      yield { type: "turn", status: "done" };
    })();
  }
  async interrupt(): Promise<boolean> {
    return false;
  }
  listCommands(): SlashCommand[] {
    return [];
  }
  capabilities(): HarnessCapabilities {
    return {
      streamingDeltas: true,
      permissions: true,
      questions: true,
      subagents: false,
      resume: true,
      interrupt: true,
      slashCommands: false,
      imageInput: true,
    };
  }
  answerPermission(): boolean {
    return true;
  }
  answerQuestion(): boolean {
    return true;
  }
  backendSessionId(): string | null {
    return null;
  }
  async dispose(): Promise<void> {}
}

let dir: string;
let store: CapygenStore;
let ipc: IpcContext;
let attachments: AttachmentStore;
let logged: string[];
let harnesses: Map<string, Recorder>;
let replies: Map<string, string>;

async function call<C extends InvokeChannel>(channel: C, raw: unknown): Promise<unknown> {
  const args = parseInvokeArgs(channel, raw);
  const handler = ipc.handlers[channel] as (a: unknown) => unknown;
  return parseInvokeResult(channel, await handler(args));
}

function attachment(name = "shot.png", bytes: Buffer = PNG, mediaType = "image/png"): unknown {
  return { name, mediaType, size: bytes.byteLength, data: bytes.toString("base64") };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "capygen-img-"));
  store = openStore(path.join(dir, "capygen.db"), { migrationsDir: MIGRATIONS_DIR });
  logged = [];
  harnesses = new Map();
  replies = new Map();
  attachments = new AttachmentStore(path.join(dir, "userData", "attachments"), {
    info: (...args) => logged.push(args.join(" ")),
    warn: (...args) => logged.push(args.join(" ")),
  });
  ipc = createIpcContext({
    store,
    attachments,
    broadcast: () => {},
    log: { info: (m) => logged.push(String(m)), warn: (m) => logged.push(String(m)), error: (m) => logged.push(String(m)) },
    makeEngine: (deps: EngineDeps) =>
      createSessionRunner({
        ...deps,
        attachments,
        makeHarness: (agent) => {
          const existing = harnesses.get(agent.agentId);
          if (existing) return existing;
          const made = new Recorder(
            agent.backend as "claude" | "codex" | "api",
            replies.get(agent.agentId) ?? "ok",
          );
          harnesses.set(agent.agentId, made);
          return made;
        },
      }),
    pickDirectory: async () => path.join(dir, "project"),
    appInfo: () => ({
      name: "capygen",
      version: "0.1.0",
      electron: "44.2.0",
      chrome: "1",
      node: "24.20.0",
      platform: "win32",
      userDataDir: dir,
      logFile: path.join(dir, "logs", "capygen-desktop.log"),
      dbFile: store.db.file,
    }),
  });
});

afterEach(() => {
  ipc.dispose();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function soloSession(model = "claude-sonnet-5"): Promise<{ sessionId: string; agentId: string }> {
  const project = (await call("projects.pick", {})) as { id: string };
  const created = (await call("sessions.create", {
    projectId: project.id,
    leadAgent: { name: "capy", backend: "claude", model },
  })) as { session: { id: string; leadAgentId: string | null } };
  return { sessionId: created.session.id, agentId: created.session.leadAgentId! };
}

/** Wait for every turn in the session to settle. */
async function settle(sessionId: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (!store.turns.hasStreaming(sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("turns did not settle");
}

function blocksOf(sessionId: string): Block[] {
  return store.blocks.listBySession(sessionId);
}

describe("chat.send with images", () => {
  it("stores the bytes outside the workspace, records an image block and sends a real image", async () => {
    const { sessionId, agentId } = await soloSession();
    await call("chat.send", { sessionId, text: "what is this?", agentId: null, attachments: [attachment()] });
    await settle(sessionId);

    const image = blocksOf(sessionId).find((b) => b.kind === "image");
    expect(image).toMatchObject({ kind: "image", name: "shot.png", mediaType: "image/png", size: PNG.byteLength });

    // The file lives under the app's own attachment root, byte-identical.
    const stored = attachments.resolve(
      (image as Extract<Block, { kind: "image" }>).attachmentId,
      "image/png",
    );
    expect(stored).not.toBeNull();
    expect(fs.readFileSync(stored!)).toEqual(PNG);
    expect(stored!.startsWith(path.join(dir, "userData", "attachments"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "project"))).toBe(false);

    // The harness got the picture as an image, not as text.
    const sent = harnesses.get(agentId)!.sends.at(-1)!;
    expect(sent.images).toHaveLength(1);
    expect(sent.images[0]!.path).toBe(stored);
    expect(sent.text).not.toContain(PNG_BASE64);
    // …and nothing base64 reached the log.
    expect(logged.join("\n")).not.toContain(PNG_BASE64);
  });

  it("rebuilds the image from the rows alone after a restart", async () => {
    const { sessionId } = await soloSession();
    await call("chat.send", { sessionId, text: "look", agentId: null, attachments: [attachment()] });
    await settle(sessionId);

    // A relaunch: a brand-new store over the same database file.
    const reopened = openStore(store.db.file, { migrationsDir: MIGRATIONS_DIR });
    try {
      const image = reopened.blocks
        .listBySession(sessionId)
        .find((b) => b.kind === "image") as Extract<Block, { kind: "image" }> | undefined;
      expect(image).toBeDefined();
      expect(attachments.resolve(image!.attachmentId, image!.mediaType)).not.toBeNull();
    } finally {
      reopened.close();
    }
  });

  it("refuses a file that is not one of the three supported formats, storing nothing", async () => {
    const { sessionId } = await soloSession();
    await expect(
      call("chat.send", {
        sessionId,
        text: "look",
        agentId: null,
        attachments: [attachment("anim.gif", GIF, "image/png")],
      }),
    ).rejects.toThrow(/not a PNG, JPEG or WebP image/);
    // Nothing was written: no turn, no block, no file.
    expect(store.turns.list(sessionId)).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "userData", "attachments"))).toBe(false);
  });

  it("fails the turn with a reason when the agent's model cannot read images", async () => {
    const { sessionId, agentId } = await soloSession();
    // `sessions.create` resolves an unknown model against the catalogue, so the
    // text-only model is set on the row afterwards.
    store.sessions.updateAgent(agentId, { model: "some-local-llm" });
    await call("chat.send", { sessionId, text: "look", agentId: null, attachments: [attachment()] });
    await settle(sessionId);

    const error = blocksOf(sessionId).find((b) => b.kind === "error") as
      | Extract<Block, { kind: "error" }>
      | undefined;
    // An unlisted model is reported as unverified, not as known-incapable.
    expect(error?.message).toContain("not a model capygen has verified");
    // The picture is still in the transcript, and the model was never sent one.
    expect(blocksOf(sessionId).some((b) => b.kind === "image")).toBe(true);
    expect(harnesses.get(agentId)?.sends ?? []).toHaveLength(0);
  });
});

describe("images through a round-table chain", () => {
  it("carries the pictures to a mentioned hop, and tells a blind hop they exist", async () => {
    const project = (await call("projects.pick", {})) as { id: string };
    const created = (await call("sessions.create", {
      projectId: project.id,
      mode: "round-table",
      agents: [
        { name: "seer", backend: "claude", model: "claude-sonnet-5", role: "lead" },
        { name: "blind", backend: "api", model: "some-local-llm", role: "member" },
      ],
    })) as { session: { id: string; leadAgentId: string | null }; agents: { id: string; mentionName: string }[] };
    const sessionId = created.session.id;
    const lead = created.agents.find((a) => a.id === created.session.leadAgentId)!;
    const other = created.agents.find((a) => a.id !== lead.id)!;
    // Pinned on the row: `sessions.create` resolves a model it does not know.
    store.sessions.updateAgent(lead.id, { model: "claude-sonnet-5" });
    store.sessions.updateAgent(other.id, { model: "some-local-llm" });
    // The lead's reply mentions the other agent, which opens the next hop.
    replies.set(lead.id, `@${other.mentionName} what do you think?`);

    await call("chat.send", { sessionId, text: "look at this", agentId: null, attachments: [attachment()] });
    await settle(sessionId);

    const hop = harnesses.get(other.id)!.sends.at(-1)!;
    // The hop's model has no vision: it is told the images exist rather than
    // being handed a message that reads as if there had never been one.
    expect(hop.images).toHaveLength(0);
    expect(hop.text).toContain("shot.png");
    expect(hop.text).toContain("has not verified that your model reads images");
  });

  it("hands a sighted hop the same stored files", async () => {
    const project = (await call("projects.pick", {})) as { id: string };
    const created = (await call("sessions.create", {
      projectId: project.id,
      mode: "round-table",
      agents: [
        { name: "first", backend: "claude", model: "claude-sonnet-5", role: "lead" },
        { name: "second", backend: "claude", model: "claude-opus-4-1", role: "member" },
      ],
    })) as { session: { id: string; leadAgentId: string | null }; agents: { id: string; mentionName: string }[] };
    const sessionId = created.session.id;
    const lead = created.agents.find((a) => a.id === created.session.leadAgentId)!;
    const other = created.agents.find((a) => a.id !== lead.id)!;
    store.sessions.updateAgent(lead.id, { model: "claude-sonnet-5" });
    store.sessions.updateAgent(other.id, { model: "claude-opus-4-1" });
    replies.set(lead.id, `@${other.mentionName} your turn`);

    await call("chat.send", { sessionId, text: "look", agentId: null, attachments: [attachment()] });
    await settle(sessionId);

    const hop = harnesses.get(other.id)!.sends.at(-1)!;
    expect(hop.images.map((i) => i.name)).toEqual(["shot.png"]);
    expect(fs.readFileSync(hop.images[0]!.path)).toEqual(PNG);
  });
});

describe("api history replay", () => {
  it("replays a stored image as a real image block, not as a description", async () => {
    const project = (await call("projects.pick", {})) as { id: string };
    const created = (await call("sessions.create", {
      projectId: project.id,
      leadAgent: { name: "api", backend: "api", model: "gpt-5.5" },
    })) as { session: { id: string; leadAgentId: string | null } };
    const sessionId = created.session.id;
    await call("chat.send", { sessionId, text: "what is this?", agentId: null, attachments: [attachment()] });
    await settle(sessionId);

    const agent = store.sessions.agent(created.session.leadAgentId!)!;
    const history = loadApiHistory(
      store,
      { sessionId, projectPath: path.join(dir, "project") },
      { agentId: agent.id, name: agent.displayName, backend: "api", model: agent.model },
      (block) => {
        const file = attachments.resolve(block.attachmentId, block.mediaType);
        return file ? fs.readFileSync(file) : null;
      },
    );

    expect(history[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", mediaType: "image/png", data: PNG_BASE64 },
      ],
    });
  });

  it("says an image was not re-sent rather than pretending it is still in view", async () => {
    const project = (await call("projects.pick", {})) as { id: string };
    const created = (await call("sessions.create", {
      projectId: project.id,
      leadAgent: { name: "api", backend: "api", model: "gpt-5.5" },
    })) as { session: { id: string; leadAgentId: string | null } };
    const sessionId = created.session.id;
    await call("chat.send", { sessionId, text: "what is this?", agentId: null, attachments: [attachment()] });
    await settle(sessionId);

    const agent = store.sessions.agent(created.session.leadAgentId!)!;
    // No reader: the file cannot be read back on this run.
    const history = loadApiHistory(
      store,
      { sessionId, projectPath: path.join(dir, "project") },
      { agentId: agent.id, name: agent.displayName, backend: "api", model: agent.model },
    );
    const text = JSON.stringify(history);
    expect(text).toContain("is not re-sent here");
    expect(text).not.toContain(PNG_BASE64);
  });
});

describe("api history replay bounds", () => {
  /** Write `count` distinct images onto one user turn, largest first. */
  function seedImages(sessionId: string, bytes: Buffer[]): void {
    const turn = store.turns.create({ sessionId, role: "user", status: "done" });
    // Stored one at a time: `chat.send`'s per-message ceilings are not what is
    // under test here — the *replay* budget across a whole history is.
    const stored = bytes.flatMap((b, i) =>
      attachments.store([
        {
          name: `img-${i}.png`,
          mediaType: "image/png" as const,
          size: b.byteLength,
          data: b.toString("base64"),
        },
      ]),
    );
    stored.forEach((image, index) => {
      store.blocks.upsert({
        id: `blk_img_${index}`,
        turnId: turn.id,
        sessionId,
        kind: "image",
        index,
        attachmentId: image.attachmentId,
        name: image.name,
        mediaType: image.mediaType,
        size: image.size,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
  }

  /** A distinct valid PNG of `size` bytes (signature + filler). */
  function png(size: number, filler: number): Buffer {
    return Buffer.concat([PNG, Buffer.alloc(Math.max(0, size - PNG.byteLength), filler)]);
  }

  function replay(sessionId: string, agentId: string): string {
    const agent = store.sessions.agent(agentId)!;
    return JSON.stringify(
      loadApiHistory(
        store,
        { sessionId, projectPath: path.join(dir, "project") },
        { agentId: agent.id, name: agent.displayName, backend: "api", model: agent.model },
        (block) => {
          const file = attachments.resolve(block.attachmentId, block.mediaType);
          return file ? fs.readFileSync(file) : null;
        },
      ),
    );
  }

  it("replays at most four pictures, newest first", async () => {
    const { sessionId, agentId } = await soloSession();
    seedImages(sessionId, [1, 2, 3, 4, 5, 6].map((n) => png(64, n)));
    const json = replay(sessionId, agentId);
    expect(json.split('"type":"image"').length - 1).toBe(4);
    // The two oldest are announced rather than dropped in silence.
    expect(json.split("is not re-sent here").length - 1).toBe(2);
  });

  it("stops at the byte budget even when the count would allow more", async () => {
    const { sessionId, agentId } = await soloSession();
    // 3 × 4 MiB: the third would take the replay past 10 MiB.
    seedImages(sessionId, [1, 2, 3].map((n) => png(4 * 1024 * 1024, n)));
    const json = replay(sessionId, agentId);
    expect(json.split('"type":"image"').length - 1).toBe(2);
    expect(json).toContain("is not re-sent here");
  });

  it("carries a repeated image once and says where the other copy is", async () => {
    const { sessionId, agentId } = await soloSession();
    const same = png(64, 7);
    // Two different attachment ids holding byte-identical content.
    seedImages(sessionId, [same, same]);
    const json = replay(sessionId, agentId);
    expect(json.split('"type":"image"').length - 1).toBe(1);
    expect(json).toContain("the same image is included later in this conversation");
  });
});

describe("the attachment scheme handler", () => {
  it("serves a stored file and refuses anything that is not one", () => {
    const [stored] = attachments.store([
      { name: "a.png", mediaType: "image/png", size: PNG.byteLength, data: PNG_BASE64 },
    ]);
    expect(attachments.serve(`capygen-attachment://file/${stored!.attachmentId}.png`)).toMatchObject({
      mediaType: "image/png",
    });
    // A traversal, a nested path and an unknown name are misses, not reads.
    expect(attachments.serve("capygen-attachment://file/..%2F..%2Fcapygen.db")).toBeNull();
    expect(attachments.serve("capygen-attachment://file/sub/dir.png")).toBeNull();
    expect(attachments.serve("capygen-attachment://file/nope.png")).toBeNull();
    expect(attachments.resolve("../outside", "image/png")).toBeNull();
  });
});
