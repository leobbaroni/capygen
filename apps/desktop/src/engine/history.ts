/**
 * Stored transcript → the `ChatMessage[]` an `api` agent starts a turn with.
 *
 * The Claude and Codex backends keep their own conversation and are resumed by
 * a backend session id. The `api` backend has none: capygen *is* the loop, so
 * the SQLite transcript is the only memory it has, and without this an `api`
 * session forgets everything the moment the app restarts (the gap the Phase 3
 * API task recorded as its first integrator item).
 *
 * The harness deliberately has no database access, so this is the desktop's
 * side of `ApiHarnessDeps.loadHistory`.
 *
 * Rules that are not obvious:
 *
 *  - **Only this agent's turns become assistant messages.** In a round-table
 *    session (Phase 4) another agent's reply is somebody else's voice; it is
 *    replayed to this one as user-role text prefixed with the speaker's name,
 *    never as this agent's own words.
 *  - **Every `tool_use` gets a `tool_result`, always.** Both providers reject a
 *    conversation where one is missing, and a turn interrupted mid-tool leaves
 *    exactly that hole — so an unfinished call is replayed with an explicit
 *    "no result" marker instead of being dropped (dropping the `tool_use` too
 *    would silently rewrite what the model believes it did).
 *  - **Thinking is replayed only when it carries a signature.** Anthropic
 *    rejects an unsigned `thinking` block on the way back in.
 *  - **Images are replayed, but bounded and deduplicated.** An `api` agent has
 *    no backend memory, so a picture the user attached before the restart has
 *    to come back as a real image or the model is answering about something it
 *    can no longer see. The newest pictures are re-sent up to
 *    `MAX_REPLAYED_IMAGES` *and* `MAX_REPLAYED_IMAGE_BYTES` across the whole
 *    replay — every replayed image is billed on every request the session makes
 *    afterwards — and the same file, or byte-identical content, is carried
 *    once. Anything not re-sent becomes a line naming the file and saying so,
 *    which is the honest alternative to pretending it is still in view.
 */
import { createHash } from "node:crypto";
import type { CapygenStore } from "@capygen/db";
import {
  IMPORTED_REFERENCE_SPEAKER_LABEL,
  type ChatContent,
  type ChatMessage,
  type HarnessAgent,
  type HarnessSession,
} from "@capygen/engine";
import type { Block } from "@capygen/shared";

/** Longest tool result replayed verbatim; the rest is a marked stub (R25). */
const MAX_REPLAYED_RESULT_CHARS = 8 * 1024;

/**
 * What a replayed history may spend on pictures (R24/R25).
 *
 * Both bounds are enforced together and across the *whole* replay, not per
 * message: four 5 MiB screenshots are four attachments and also 20 MiB, and it
 * is the byte total that decides what every later turn costs, since a replayed
 * image is re-sent on every request the session makes from then on.
 */
export const MAX_REPLAYED_IMAGES = 4;
export const MAX_REPLAYED_IMAGE_BYTES = 10 * 1024 * 1024;

/** Reads one stored attachment; absent (or null) means "cannot be replayed". */
export type AttachmentReader = (block: Extract<Block, { kind: "image" }>) => Buffer | null;

function textOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clamp(text: string): string {
  if (text.length <= MAX_REPLAYED_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_REPLAYED_RESULT_CHARS)}\n… [truncated by capygen: ${text.length} chars]`;
}

/**
 * Builds the replay for one agent. `store` is read once per `start()`, never
 * per turn — the harness keeps the array and appends to it as the session runs.
 */
export function loadApiHistory(
  store: CapygenStore,
  session: HarnessSession,
  agent: HarnessAgent,
  readAttachment?: AttachmentReader,
): ChatMessage[] {
  const turns = store.turns.list(session.sessionId);
  const blocks = store.blocks.listBySession(session.sessionId);
  const byTurn = new Map<string, Block[]>();
  for (const block of blocks) {
    const list = byTurn.get(block.turnId);
    if (list) list.push(block);
    else byTurn.set(block.turnId, [block]);
  }
  const agentName = new Map(store.sessions.historicalAgents(session.sessionId).map((a) => [a.id, a.name]));

  // Which pictures are actually re-sent, decided before the walk so the rest
  // can be replayed as a note instead.
  //
  // Chosen newest-first, because the picture the conversation is currently
  // about is the one worth paying for on every subsequent request, and stopped
  // by whichever bound is reached first — count or bytes. Two references to the
  // same stored file, and two files with identical content, are replayed once:
  // the model gains nothing from the second copy and each one is billed again.
  const prepared = new Map<string, Buffer>();
  /** Block ids whose picture is carried by another block in this replay. */
  const duplicates = new Set<string>();
  if (readAttachment) {
    const digests = new Set<string>();
    const seenAttachments = new Set<string>();
    let spent = 0;
    const imageBlocks = blocks.filter(
      (b): b is Extract<Block, { kind: "image" }> => b.kind === "image",
    );
    for (let index = imageBlocks.length - 1; index >= 0; index -= 1) {
      const block = imageBlocks[index]!;
      if (prepared.size >= MAX_REPLAYED_IMAGES) break;
      // The same stored file twice: the later reference is already carrying it.
      if (seenAttachments.has(block.attachmentId)) {
        duplicates.add(block.id);
        continue;
      }
      const bytes = readAttachment(block);
      // A file that is gone is announced, never faked.
      if (!bytes) continue;
      const digest = createHash("sha256").update(bytes).digest("hex");
      // Byte-identical content under a different attachment id.
      if (digests.has(digest)) {
        duplicates.add(block.id);
        continue;
      }
      if (spent + bytes.byteLength > MAX_REPLAYED_IMAGE_BYTES) continue;
      digests.add(digest);
      seenAttachments.add(block.attachmentId);
      prepared.set(block.id, bytes);
      spent += bytes.byteLength;
    }
  }

  const messages: ChatMessage[] = [];
  const pushUser = (content: ChatContent[]): void => {
    if (content.length === 0) return;
    const last = messages[messages.length - 1];
    // Consecutive user messages are merged: a tool_result batch belongs with
    // whatever the user said next, and both providers prefer strict alternation.
    if (last?.role === "user") last.content.push(...content);
    else messages.push({ role: "user", content });
  };

  for (const turn of turns) {
    // The turn being started right now has no content yet, and its own prompt
    // is handed to the harness by `send()` — replaying it here would double it.
    if (turn.status === "streaming") continue;
    const own = (byTurn.get(turn.id) ?? []).slice().sort((a, b) => a.index - b.index);
    if (own.length === 0) continue;

    // A continuation reference is a system-owned, noninteractive transcript
    // row, but it must reach the provider at user-message priority. Check its
    // explicit marker before the null-agent fallback below can relabel it as
    // another speaker. The stored formatter already JSON-quotes untrusted
    // history and enforces its independent 6,000-byte bound; keep it exact.
    if (turn.speakerLabel === IMPORTED_REFERENCE_SPEAKER_LABEL) {
      const text = own
        .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
        .map((b) => b.text)
        .join("\n");
      if (text) pushUser([{ type: "text", text }]);
      continue;
    }

    if (turn.role === "user") {
      const text = own
        .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const content: ChatContent[] = text ? [{ type: "text", text }] : [];
      for (const block of own) {
        if (block.kind !== "image") continue;
        const bytes = prepared.get(block.id) ?? null;
        if (bytes) {
          content.push({ type: "image", mediaType: block.mediaType, data: bytes.toString("base64") });
          continue;
        }
        // Never "here is the image": it is not being sent. A duplicate says so
        // precisely, because the model *can* see that picture — further down.
        const elsewhere = duplicates.has(block.id);
        content.push({
          type: "text",
          text: elsewhere
            ? `[image attachment "${block.name}" (${block.mediaType}); the same image is included later in this conversation]`
            : `[image attachment "${block.name}" (${block.mediaType}) was sent earlier and is not re-sent here]`,
        });
      }
      if (content.length > 0) pushUser(content);
      continue;
    }

    if (turn.agentId !== agent.agentId) {
      const speaker = (turn.agentId ? agentName.get(turn.agentId) : null) ?? "another agent";
      const text = own
        .filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) pushUser([{ type: "text", text: `[${speaker}]: ${text}` }]);
      continue;
    }

    const assistant: ChatContent[] = [];
    const results: ChatContent[] = [];
    for (const block of own) {
      switch (block.kind) {
        case "text":
          if (block.text.trim()) assistant.push({ type: "text", text: block.text });
          break;
        case "thinking":
          if (block.signature) {
            assistant.push({
              type: "thinking",
              thinking: block.text,
              signature: block.signature,
            });
          }
          break;
        case "tool_call": {
          if (!block.toolUseId) break;
          assistant.push({
            type: "tool_use",
            id: block.toolUseId,
            name: block.name,
            input: block.input,
          });
          // `denied` counts: the denial message *is* the result, and replaying
          // it as "the turn ended before this tool finished" would tell the
          // model the call was merely interrupted — a good reason to retry the
          // exact command the user just refused.
          const raw =
            block.status === "success" ||
            block.status === "error" ||
            block.status === "denied"
              ? clamp(textOf(block.output))
              : "";
          results.push({
            type: "tool_result",
            toolUseId: block.toolUseId,
            content: raw || "[no result: the turn ended before this tool finished]",
            ...(block.status === "error" || block.status === "denied" ? { isError: true } : {}),
          });
          break;
        }
        default:
          // image (an agent turn never carries one) / permission / question /
          // elicitation / widget / diff / usage / error / subagent are
          // capygen's own UI record of the turn. The model
          // already saw their effect (the tool ran, or it did not); replaying
          // them would be inventing conversation.
          break;
      }
    }
    if (assistant.length > 0) messages.push({ role: "assistant", content: assistant });
    if (results.length > 0) pushUser(results);
  }

  return messages;
}
