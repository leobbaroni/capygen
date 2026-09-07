/**
 * Claude Code JSONL → normalized import snapshot.
 *
 * The canonical ordering of a Claude transcript is not "the order of the
 * lines": entries link through `parentUuid`, and the CLI's own reader walks
 * that chain. Rather than re-implement it (and drift), this module hands the
 * *projected* records to the installed SDK's `getSessionMessages` through a
 * read-only custom `SessionStore` — one `load` call, no CLI spawn.
 *
 * Projection happens **before** the hand-off, not after. What reaches the store
 * (and therefore any worker or staging file the integration puts in between) is
 * already reduced to `{type, uuid, parentUuid, sessionId, timestamp, isSidechain,
 * isMeta, message}` where `message` itself holds only allowlisted, already-
 * bounded blocks. A record's `cwd`, `version`, `gitBranch`, `userType`,
 * `toolUseResult` blob, tool-use ids, images and unknown block payloads never
 * leave this file.
 *
 * The SDK call is an **injected boundary** (`ClaudeChainReconstructor`). This
 * module never imports the SDK at runtime, never reads or writes
 * `CLAUDE_CONFIG_DIR`, and has no default project directory — the caller
 * supplies an inert one (see `CLAUDE_RECONSTRUCTION_NOTE`).
 */
import type { SessionMessage, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { TranscriptBuilder, clampLabel, clampUtf8, deriveTitle, validTimestamp } from "./builder.js";
import type { CollectorSource, TranscriptCollector } from "./collector.js";
import type { ImportLimits } from "./limits.js";
import { ImportError, type ImportSpeaker, type ImportedTranscript } from "./types.js";

export const CLAUDE_TRANSCRIPT_FORMAT = "claude-jsonl/v1";

/** What the integration still has to solve; reported, not silently assumed. */
export const CLAUDE_RECONSTRUCTION_NOTE =
  "getSessionMessages must run where CLAUDE_CONFIG_DIR/CODEX_HOME are already isolated, which means an isolated worker process — this module never mutates process.env and never defaults to a personal backend home.";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The blocks a projected message may contain. Nothing else survives.
 *
 * `truncated` travels with the block: projection bounds the text before the
 * store hand-off, so without it the final append would see already-short text
 * and report a complete message. Names are clamped here too — the SDK never
 * receives an unbounded tool name.
 */
export type ProjectedBlock =
  | { type: "text"; text: string; truncated: boolean }
  | { type: "thinking"; thinking: string; truncated: boolean }
  | { type: "tool_use"; name: string; input: string; truncated: boolean }
  | { type: "tool_result"; content: string; is_error: boolean | null; truncated: boolean }
  /** A slash-command / skill invocation the user typed, reduced to its name
   *  and arguments. Inert: a historical note, never something to run. */
  | { type: "command"; name: string; args: string; truncated: boolean };

export interface ProjectedMessage {
  role: ImportSpeaker;
  content: ProjectedBlock[];
}

/**
 * The only fields that reach the SDK store — and `message` is itself already
 * projected, so no unknown payload rides along inside it.
 */
export interface ClaudeStoreEntry {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  message?: ProjectedMessage;
  isSidechain?: boolean;
  isMeta?: boolean;
  [k: string]: unknown;
}

/** Chain reconstruction, injected so the SDK stays outside this module. */
export type ClaudeChainReconstructor = (input: {
  sessionId: string;
  entries: ClaudeStoreEntry[];
}) => Promise<SessionMessage[]>;

/**
 * A `SessionStore` that can only be read, and only for the session it was
 * built for. Every mutating or listing method throws: a store that could
 * enumerate or write would be a way back out to the user's real transcripts.
 */
export function createReadOnlySessionStore(entries: ClaudeStoreEntry[]): SessionStore {
  const refuse = (method: string): never => {
    throw new ImportError(
      "unsupported-structure",
      `capygen import store is read-only; ${method} is not available`,
    );
  };
  const store: SessionStore = {
    load: async () => entries,
    append: async () => refuse("append"),
    delete: async () => refuse("delete"),
    listSessions: async () => refuse("listSessions"),
    listSessionSummaries: async () => refuse("listSessionSummaries"),
    listSubkeys: async () => refuse("listSubkeys"),
  };
  return store;
}

/** The slice of `getSessionMessages` this adapter needs. */
export type GetSessionMessagesLike = (
  sessionId: string,
  options: { dir: string; sessionStore: SessionStore },
) => Promise<SessionMessage[]>;

/**
 * Wrap the SDK's `getSessionMessages` as a reconstructor.
 *
 * `dir` is required and must be absolute: it becomes the SDK's `projectKey`, so
 * passing a real project directory would key the read against the user's actual
 * transcripts. Callers pass an empty scratch directory made for this one parse.
 */
export function createSdkChainReconstructor(
  getSessionMessages: GetSessionMessagesLike,
  options: { dir: string },
): ClaudeChainReconstructor {
  const { dir } = options;
  if (!dir || !/^([A-Za-z]:[\\/]|[\\/])/.test(dir)) {
    throw new ImportError(
      "unsupported-structure",
      "an absolute, inert project directory is required to reconstruct a Claude chain",
    );
  }
  return async ({ sessionId, entries }) =>
    getSessionMessages(sessionId, { dir, sessionStore: createReadOnlySessionStore(entries) });
}

/**
 * Record types whose values are configuration, environment or hook plumbing.
 * They are counted and thrown away — never projected into an entry, and never
 * handed to the reconstructor.
 */
const CONFIGURATION_TYPES = new Set([
  "system",
  "settings",
  "file-history-snapshot",
  "queue",
  "mode",
  "mode-change",
  "tags",
  "title",
]);

/**
 * Wrappers the CLI puts around machine-generated prose in `isMeta` records:
 * slash-command plumbing, local command output, injected reminders. They are
 * configuration and environment, not something a person said, so they are
 * counted and dropped.
 *
 * Applied only to records the source itself marked `isMeta` — ordinary prose
 * that happens to quote one of these tags is left alone.
 */
const META_CONFIGURATION_PREFIXES = [
  "Caveat: The messages below were generated by the user while running local commands",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<system-reminder>",
  "<user-memory-input>",
];

/**
 * The CLI wraps injected instruction context in `<system-reminder>` and a
 * typed slash command in `<command-name>` — and it does so inside *ordinary*
 * user records, not only `isMeta` ones. Read leading-wrapper-only, by hand:
 * a real XML parser would be a dependency and a new attack surface for text a
 * person wrote, and prose that merely mentions a marker mid-sentence must stay
 * exactly as typed.
 */
const REMINDER_OPEN = "<system-reminder>";
const REMINDER_CLOSE = "</system-reminder>";
const COMMAND_NAME_OPEN = "<command-name>";
const COMMAND_NAME_CLOSE = "</command-name>";
const COMMAND_ARGS_OPEN = "<command-args>";
const COMMAND_ARGS_CLOSE = "</command-args>";

type UserTextReading =
  /** Ordinary prose; `text` is exactly what was written. */
  | { kind: "text"; text: string }
  /** A leading reminder wrapper. `remainder` is the ordinary text after it. */
  | { kind: "reminder"; remainder: string | null }
  /** A leading slash-command block. */
  | { kind: "command"; name: string; args: string }
  /** A leading wrapper that never closes: what it held cannot be read. */
  | { kind: "unterminated"; wrapper: "system-reminder" | "command-name" | "command-args" };

/** Text between `open` and `close`, when `close` really follows. */
function between(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  const from = start + open.length;
  const end = text.indexOf(close, from);
  return end === -1 ? null : text.slice(from, end);
}

function readUserText(raw: string): UserTextReading {
  const text = raw.trimStart();
  if (text.startsWith(REMINDER_OPEN)) {
    const end = text.indexOf(REMINDER_CLOSE);
    if (end === -1) return { kind: "unterminated", wrapper: "system-reminder" };
    // Everything the reminder held is instruction context; anything the user
    // typed after the closing tag is theirs and survives.
    const remainder = text.slice(end + REMINDER_CLOSE.length).trim();
    return { kind: "reminder", remainder: remainder.length > 0 ? remainder : null };
  }
  if (text.startsWith(COMMAND_NAME_OPEN)) {
    const name = between(text, COMMAND_NAME_OPEN, COMMAND_NAME_CLOSE);
    if (name === null) return { kind: "unterminated", wrapper: "command-name" };
    const args = between(text, COMMAND_ARGS_OPEN, COMMAND_ARGS_CLOSE);
    if (text.includes(COMMAND_ARGS_OPEN) && args === null) {
      return { kind: "unterminated", wrapper: "command-args" };
    }
    return { kind: "command", name: name.trim().replace(/^\//, ""), args: (args ?? "").trim() };
  }
  return { kind: "text", text: raw };
}

function isMetaConfiguration(text: string): boolean {
  const trimmed = text.trimStart();
  return META_CONFIGURATION_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Types that are recognisably Claude even before a chain record appears. */
export const CLAUDE_MARKER_TYPES = new Set([
  ...CONFIGURATION_TYPES,
  "summary",
  "user",
  "assistant",
  "compact_boundary",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export interface ClaudeCollectorDeps {
  limits: ImportLimits;
  reconstruct: ClaudeChainReconstructor;
}

/**
 * Consumes Claude JSONL records one at a time, then reconstructs and projects.
 */
export function createClaudeCollector(deps: ClaudeCollectorDeps): TranscriptCollector {
  const { limits, reconstruct } = deps;
  const builder = new TranscriptBuilder(limits);
  const chainEntries: ClaudeStoreEntry[] = [];
  const seenUuids = new Set<string>();
  const timestamps = new Map<string, string>();
  let sessionId: string | null = null;
  let summaryTitle: string | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let sidechain = 0;
  let attachments = 0;
  let unsupportedContent = 0;
  let unterminatedWrappers = 0;
  let complete = true;
  /** uuid → what the source said this record *is*, kept across the SDK hop. */
  const classification = new Map<string, { meta: boolean; compactSummary: boolean }>();

  const noteIdentity = (candidate: string | null, line: number): void => {
    if (!candidate) return;
    if (!UUID_PATTERN.test(candidate)) {
      throw new ImportError(
        "conflicting-identity",
        `line ${line} carries a session id that is not a UUID`,
        line,
      );
    }
    if (sessionId === null) {
      sessionId = candidate;
      return;
    }
    if (sessionId !== candidate) {
      throw new ImportError(
        "conflicting-identity",
        `line ${line} belongs to a different session than the rest of the file`,
        line,
      );
    }
  };

  const noteTime = (at: string | null): void => {
    if (!at) return;
    if (firstAt === null || at < firstAt) firstAt = at;
    if (lastAt === null || at > lastAt) lastAt = at;
  };

  /**
   * Reduce one raw `message` to allowlisted, bounded blocks. Attachments and
   * unrecognized blocks are counted *here*, so they are accounted for even
   * though nothing about them travels onwards.
   */
  /**
   * One raw user text block → zero or more projected blocks. Wrappers are
   * recognized only at the start of the block, so a question *about*
   * `<system-reminder>` is still a question.
   */
  const projectUserText = (raw: string, blocks: ProjectedBlock[]): void => {
    let reading = readUserText(raw);
    while (reading.kind === "reminder") {
      builder.dropConfiguration();
      if (reading.remainder === null) return;
      reading = readUserText(reading.remainder);
    }
    switch (reading.kind) {
      case "text": {
        const clipped = clampUtf8(reading.text, limits.maxMessageBytes);
        if (clipped.text.trim().length > 0) {
          blocks.push({ type: "text", text: clipped.text, truncated: clipped.truncated });
        }
        return;
      }
      case "command": {
        const clipped = clampUtf8(reading.args, limits.maxMessageBytes);
        blocks.push({
          type: "command",
          name: clampLabel(reading.name.length > 0 ? reading.name : "command", limits.maxLabelChars),
          args: clipped.text,
          truncated: clipped.truncated,
        });
        return;
      }
      case "unterminated": {
        // The wrapper never closes, so there is no way to tell instruction
        // context from the user's own words: nothing is kept, and the snapshot
        // says so rather than guessing.
        unterminatedWrappers += 1;
        builder.dropConfiguration();
        return;
      }
    }
  };

  const projectMessage = (raw: unknown, role: ImportSpeaker): ProjectedMessage | null => {
    const payload = asRecord(raw);
    if (!payload) return null;
    const content = payload.content;
    const blocks: ProjectedBlock[] = [];

    if (typeof content === "string") {
      if (role === "user") {
        projectUserText(content, blocks);
        return { role, content: blocks };
      }
      const clipped = clampUtf8(content, limits.maxMessageBytes);
      if (clipped.text.trim().length > 0) {
        blocks.push({ type: "text", text: clipped.text, truncated: clipped.truncated });
      }
      return { role, content: blocks };
    }
    if (!Array.isArray(content)) {
      builder.countUnknown("message-content");
      unsupportedContent += 1;
      return { role, content: blocks };
    }

    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (!block) {
        builder.countUnknown("content-block");
        unsupportedContent += 1;
        continue;
      }
      switch (block.type) {
        case "text": {
          const text = asString(block.text);
          if (text) {
            if (role === "user") {
              projectUserText(text, blocks);
              break;
            }
            const clipped = clampUtf8(text, limits.maxMessageBytes);
            blocks.push({ type: "text", text: clipped.text, truncated: clipped.truncated });
          }
          break;
        }
        case "thinking": {
          const thinking = asString(block.thinking);
          if (thinking) {
            const clipped = clampUtf8(thinking, limits.maxMessageBytes);
            blocks.push({
              type: "thinking",
              thinking: clipped.text,
              truncated: clipped.truncated,
            });
          }
          break;
        }
        case "tool_use": {
          const clipped = clampUtf8(describeToolInput(block.input), limits.maxToolTextBytes);
          blocks.push({
            type: "tool_use",
            // Bounded here, not at append: an unbounded name must not reach
            // the SDK, a staging file or a worker.
            name: clampLabel(asString(block.name) ?? "tool", limits.maxLabelChars),
            // The id is deliberately not carried: nothing may be correlated
            // back to a live tool-use block or replayed.
            input: clipped.text,
            truncated: clipped.truncated,
          });
          break;
        }
        case "tool_result": {
          const clipped = clampUtf8(
            describeToolResult(block.content, builder, () => {
              attachments += 1;
            }),
            limits.maxToolTextBytes,
          );
          blocks.push({
            type: "tool_result",
            content: clipped.text,
            is_error: block.is_error === true ? true : block.is_error === false ? false : null,
            truncated: clipped.truncated,
          });
          break;
        }
        case "image":
        case "document":
          attachments += 1;
          break;
        default:
          builder.countUnknown(block.type);
          unsupportedContent += 1;
          break;
      }
    }
    return { role, content: blocks };
  };

  return {
    backend: "claude",

    accept({ line, value }) {
      const record = asRecord(value);
      if (!record) {
        throw new ImportError("unsupported-structure", `line ${line} is not a JSON object`, line);
      }
      builder.counts.records += 1;
      const type = typeof record.type === "string" ? record.type : "";
      const at = validTimestamp(record.timestamp);
      noteTime(at);

      if (type === "summary") {
        // The CLI's own conversation summary: the best available title, and
        // nothing else about it is retained.
        summaryTitle ??= asString(record.summary);
        builder.dropConfiguration();
        return;
      }
      if (type === "compact_boundary") {
        // History was replaced by a summary before this file was written.
        complete = false;
        builder.warn(
          "claude.compacted",
          "this conversation was compacted; the turns it replaced are not in the file",
        );
        builder.append({
          kind: "notice",
          label: "compacted (historical)",
          text: "(the conversation was compacted here)",
          at,
        });
        return;
      }
      if (CONFIGURATION_TYPES.has(type)) {
        builder.dropConfiguration();
        return;
      }
      if (type !== "user" && type !== "assistant") {
        builder.countUnknown(record.type);
        return;
      }

      noteIdentity(asString(record.sessionId), line);
      if (record.isSidechain === true) {
        // Sub-agent transcripts hang off the main chain; importing them as if
        // they were the conversation would invent structure that was not there,
        // so they are left out — and that omission is what `complete` reports.
        sidechain += 1;
        complete = false;
        return;
      }
      const uuid = asString(record.uuid);
      if (!uuid) {
        throw new ImportError("unsupported-structure", `line ${line} has no uuid`, line);
      }
      if (seenUuids.has(uuid)) {
        throw new ImportError(
          "conflicting-identity",
          `line ${line} repeats a uuid that already appeared in this file`,
          line,
        );
      }
      seenUuids.add(uuid);
      if (at) timestamps.set(uuid, at);
      const compactSummary = record.isCompactSummary === true;
      if (compactSummary) {
        complete = false;
        builder.warn(
          "claude.compacted",
          "this conversation was compacted; the turns it replaced are not in the file",
        );
      }
      // The SDK hop returns type/uuid/message only, so what the source said
      // this record *is* has to be remembered here.
      classification.set(uuid, { meta: record.isMeta === true, compactSummary });

      chainEntries.push({
        type,
        uuid,
        parentUuid: typeof record.parentUuid === "string" ? record.parentUuid : null,
        sessionId: asString(record.sessionId) ?? undefined,
        timestamp: at ?? undefined,
        message: projectMessage(record.message, type === "assistant" ? "assistant" : "user") ?? undefined,
        isSidechain: false,
        isMeta: record.isMeta === true,
      });
    },

    async finish(source: CollectorSource): Promise<ImportedTranscript> {
      if (sidechain > 0) {
        builder.warn(
          "claude.sidechain-dropped",
          "sub-agent (sidechain) records were left out of this snapshot",
          sidechain,
        );
      }
      if (attachments > 0) {
        complete = false;
        builder.warn(
          "claude.attachment-dropped",
          "recorded images and documents are not imported, so part of the recorded content is missing",
          attachments,
        );
      }
      if (unterminatedWrappers > 0) {
        complete = false;
        builder.warn(
          "claude.unterminated-wrapper",
          "a system-reminder or command block was never closed, so its contents were left out",
          unterminatedWrappers,
        );
      }
      if (unsupportedContent > 0) {
        complete = false;
        builder.warn(
          "claude.unsupported-content",
          "some recorded content could not be read and is not in this snapshot",
          unsupportedContent,
        );
      }
      if (sessionId === null) {
        throw new ImportError(
          "unsupported-structure",
          "no Claude session id was found in the selected file",
        );
      }
      if (chainEntries.length === 0) {
        throw new ImportError(
          "unsupported-structure",
          "the selected file has no Claude conversation records",
        );
      }

      const orphans = chainEntries.filter(
        (entry) => entry.parentUuid !== null && !seenUuids.has(entry.parentUuid as string),
      ).length;
      if (orphans > 0) {
        complete = false;
        builder.warn(
          "claude.missing-parent",
          "some records name a parent that is not in this file, so part of the conversation is missing",
          orphans,
        );
      }

      const messages = await reconstruct({ sessionId, entries: chainEntries });
      if (messages.length < chainEntries.length) {
        // The chain walk could not place every record (a branch, an orphan, a
        // compaction relink). Say so rather than presenting a whole history.
        complete = false;
        builder.warn(
          "claude.chain-partial",
          "the reconstructed chain does not include every record in the file",
          chainEntries.length - messages.length,
        );
      }

      let firstUserText: string | null = null;
      for (const message of messages) {
        if (message.session_id && message.session_id !== sessionId) {
          throw new ImportError(
            "conflicting-identity",
            "the reconstructed chain contains a message from another session",
          );
        }
        const uuid = message.uuid ?? "";
        const at = timestamps.get(uuid) ?? null;
        const marks = classification.get(uuid) ?? { meta: false, compactSummary: false };
        const projected = message.message as ProjectedMessage | undefined;
        // `isMeta` prose is machine-generated: a historical system line, never
        // a user turn and never the title.
        const role: ImportSpeaker =
          marks.meta || marks.compactSummary
            ? "system"
            : message.type === "assistant"
              ? "assistant"
              : message.type === "system"
                ? "system"
                : "user";
        const label = marks.compactSummary
          ? "compacted summary (historical)"
          : marks.meta
            ? "system (historical)"
            : undefined;

        if (!projected || !Array.isArray(projected.content)) {
          builder.countUnknown(`message:${message.type}`);
          complete = false;
          builder.warn(
            "claude.unsupported-content",
            "some recorded content could not be read and is not in this snapshot",
          );
          continue;
        }

        for (const block of projected.content) {
          switch (block.type) {
            case "text": {
              if (marks.meta && isMetaConfiguration(block.text)) {
                // A recognized configuration wrapper: counted, not retained.
                builder.dropConfiguration();
                break;
              }
              if (role === "user" && firstUserText === null) firstUserText = block.text;
              builder.append({
                kind: "message",
                speaker: role,
                label,
                text: block.text,
                at,
                preTruncated: block.truncated,
              });
              break;
            }
            case "command":
              // Inert on purpose: a note that the user typed a command, not a
              // prompt, not a tool call, and never the transcript's title.
              builder.append({
                kind: "notice",
                label: `/${block.name} (historical)`,
                text: block.args.length > 0 ? `/${block.name} ${block.args}` : `/${block.name}`,
                at,
                preTruncated: block.truncated,
              });
              break;
            case "thinking":
              builder.append({
                kind: "thinking",
                text: block.thinking,
                at,
                preTruncated: block.truncated,
              });
              break;
            case "tool_use":
              builder.append({
                kind: "activity",
                name: block.name,
                text: block.input,
                at,
                preTruncated: block.truncated,
              });
              break;
            case "tool_result":
              builder.append({
                kind: "activity-result",
                name: "tool",
                text: block.content,
                failed: block.is_error,
                at,
                preTruncated: block.truncated,
              });
              break;
          }
        }
      }

      const { entries, warnings, unknownTypes } = builder.finish();
      const title =
        (summaryTitle ? deriveTitle(summaryTitle, limits.maxTitleChars) : null) ??
        (firstUserText ? deriveTitle(firstUserText, limits.maxTitleChars) : null);

      const envelope = {
        backend: "claude" as const,
        format: CLAUDE_TRANSCRIPT_FORMAT,
        nativeId: sessionId,
        title,
        sourcePath: source.filePath,
        sourceBytes: source.bytes,
        sourceSha256: source.sha256,
        // Claude records a `cwd`, but it is dropped with the rest of the
        // environment fields; provenance for this backend is the path alone.
        cwd: null,
        startedAt: firstAt,
        endedAt: lastAt,
        counts: builder.counts,
        unknownTypes,
        warnings,
        complete,
      };
      // The whole snapshot — entries and envelope — has to fit the byte cap,
      // and `counts.normalizedBytes` is what it actually measured.
      builder.sealEnvelope(envelope);
      return { ...envelope, entries };
    },
  };
}

/** A tool call's input, flattened to text. Never executed, never structured. */
function describeToolInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return "(unreadable tool input)";
  }
}

/** A tool result, flattened to text with attachments dropped. */
function describeToolResult(
  content: unknown,
  builder: TranscriptBuilder,
  onAttachment: () => void,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return "";
    try {
      return JSON.stringify(content) ?? "";
    } catch {
      return "(unreadable tool result)";
    }
  }
  const parts: string[] = [];
  for (const rawPart of content) {
    const part = asRecord(rawPart);
    if (!part) continue;
    if (part.type === "text") {
      const text = asString(part.text);
      if (text) parts.push(text);
      continue;
    }
    onAttachment();
  }
  return parts.join("\n");
}
