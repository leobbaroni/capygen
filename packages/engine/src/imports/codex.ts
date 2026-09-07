/**
 * Codex rollout JSONL → normalized import snapshot.
 *
 * The wire shapes here are read off the pinned Rust sources for
 * `rust-v0.153.4` (COMPAT):
 *   codex-rs/history/src/lib.rs            — `RolloutLine { timestamp, ordinal?, #[serde(flatten)] item }`
 *   codex-rs/history/src/rollout_payload.rs — `RolloutItemWire`, `#[serde(tag = "type", rename_all = "snake_case")]`,
 *                                             every variant carrying its `payload`
 *   codex-rs/protocol/src/protocol.rs       — `SessionMeta` / `SessionMetaLine`, `HistoryPosition`, `EventMsg`
 *   codex-rs/protocol/src/models.rs         — `ResponseItem` (`Message`, `AgentMessage`, `Reasoning`,
 *                                             `FunctionCall`, `FunctionCallOutput`, `CustomToolCall`
 *                                             `{ call_id, name, input }`, `CustomToolCallOutput`
 *                                             sharing `FunctionCallOutputBody`), `ContentItem`,
 *                                             `AgentMessageInputContent`
 *
 * Three things in that format matter more than the rest:
 *
 * 1. **Canonical items beat event echoes — but only per duplicate.** A rollout
 *    records model-visible `response_item` records *and* `event_msg` records
 *    that echo user/assistant text for UI replay. An echo is dropped only when
 *    a canonical message with the same speaker and the same text exists; every
 *    other echo stays where the source put it, and a snapshot that mixes both
 *    says so and reports itself incomplete rather than quietly deleting turns.
 *
 * 2. **`history_base` is a reference, not history.** When `SessionMeta` carries
 *    a `history_base` (`HistoryPosition { thread_id, end_ordinal_exclusive,
 *    end_byte_offset }`) the earlier turns live in a *different* rollout file.
 *    This parser never opens it: the snapshot is marked incomplete instead.
 *
 * 3. **Anything model-visible we cannot read makes the snapshot incomplete.**
 *    An unrecognized `response_item` variant, an encrypted agent message, a
 *    dropped image — each is history the transcript had and this snapshot does
 *    not, so `complete` goes false and a warning names it.
 */
import { TranscriptBuilder, clampLabel, deriveTitle, validTimestamp } from "./builder.js";
import type { CollectorSource, TranscriptCollector } from "./collector.js";
import type { ImportLimits } from "./limits.js";
import { ImportError, type ImportSpeaker, type ImportedTranscript } from "./types.js";

export const CODEX_TRANSCRIPT_FORMAT = "codex-rollout/rust-v0.153.4";

/** Thread ids are UUIDs on the wire (`ThreadId`). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every `RolloutItemWire` tag, so detection does not have to guess. */
export const CODEX_ROLLOUT_TYPES = new Set([
  "session_meta",
  "response_item",
  "inter_agent_communication",
  "inter_agent_communication_metadata",
  "compacted",
  "turn_context",
  "token_usage_record",
  "world_state",
  "security_risk_score",
  "event_msg",
  "realtime_item",
]);

/**
 * Rollout record types whose payloads are configuration, telemetry or
 * environment: turn context (model, approval policy, sandbox policy, cwd),
 * token accounting, world state, risk scoring, agent plumbing. Counted, never
 * retained.
 */
const CONFIGURATION_ITEMS = new Set([
  "turn_context",
  "token_usage_record",
  "world_state",
  "security_risk_score",
  "inter_agent_communication_metadata",
]);

/**
 * Text fragments Codex *injects* into a user- or developer-role message: they
 * are model context, not something a person typed.
 *
 * The markers are the ones in the pinned tree
 * (`core/src/context/contextual_user_message.rs`'s
 * `CONTEXTUAL_USER_FRAGMENT_MATCHERS` and `core/src/event_mapping.rs`'s
 * `CONTEXTUAL_DEVELOPER_PREFIXES`), where `parse_user_message` refuses to build
 * a user message out of them. This is a recognition list, deliberately not a
 * "strip anything that looks like a tag" rule — a person can perfectly well
 * type `<user_shell_command>` in a question about XML, and that stays.
 *
 * The literal user markers below are pinned to
 * `codex-rs/protocol/src/protocol.rs` at `rust-v0.153.4` (lines 113–136);
 * developer markers come from the same tag's `core/src/event_mapping.rs`.
 */
const INJECTED_USER_PREFIXES = [
  "# AGENTS.md instructions",
  "<user_shell_command>",
  "<subagent_notification>",
  "<recommended_plugins>",
  "<codex_internal_context",
  "<goal_context>",
  "<user_instructions>",
  "<environment_context>",
];

/** Injected fragments that record something structural worth showing. */
const STRUCTURAL_USER_PREFIXES: ReadonlyArray<{ prefix: string; label: string; text: string }> = [
  {
    prefix: "<turn_aborted>",
    label: "interrupted (historical)",
    text: "(the previous turn was interrupted)",
  },
];

/** `CONTEXTUAL_DEVELOPER_PREFIXES` from the pinned `core/src/event_mapping.rs`. */
const INJECTED_DEVELOPER_PREFIXES = [
  "<permissions instructions>",
  "<model_switch>",
  "<managed_developer_instructions>",
  "<persistent_mode>",
  "<multi_agent_role>",
  "<git_attribution>",
  "<personality_spec>",
  "<token_budget>",
  "<rollout_budget>",
  "<apps_instructions>",
  "<collaboration_mode>",
  "<multi_agent_mode>",
  "<environments_instructions>",
  "<plugins_instructions>",
  "<realtime_conversation>",
  "<skills_instructions>",
  "<tools>",
  "<context_window>",
  "<context_window_guidance>",
];

/** `LegacyApplyPatchExecCommandWarning::matches_text`, verbatim. */
function isLegacyApplyPatchWarning(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("Warning: apply_patch was requested via ") &&
    trimmed.endsWith("Use the apply_patch tool instead of exec_command.")
  );
}

function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  const trimmed = text.trimStart();
  return prefixes.some((prefix) =>
    trimmed.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase(),
  );
}

/** `EventMsg` variants that may echo text also present as a response item. */
const ECHO_EVENTS = new Set(["user_message", "agent_message"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The key an echo is matched on: same speaker, same text. */
function echoKey(speaker: ImportSpeaker, text: string): string {
  return `${speaker}\0${text.trim()}`;
}

function speakerFor(role: unknown): ImportSpeaker {
  const value = typeof role === "string" ? role.toLowerCase() : "";
  if (value === "assistant") return "assistant";
  if (value === "user") return "user";
  // `developer`, `system`, `tool` and anything else are system-side context.
  return "system";
}

export interface CodexCollectorDeps {
  limits: ImportLimits;
}

export function createCodexCollector(deps: CodexCollectorDeps): TranscriptCollector {
  const { limits } = deps;
  const builder = new TranscriptBuilder(limits);
  /**
   * How many times each canonical user/assistant text occurred. Multiplicity
   * matters: a conversation that says "yes" three times has three canonical
   * items and three echoes, and one canonical occurrence must not erase all of
   * them.
   */
  const canonicalText = new Map<string, number>();
  let canonicalConversationMessages = 0;
  let threadId: string | null = null;
  let firstUserText: string | null = null;
  let cwd: string | null = null;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let complete = true;

  const incomplete = (code: string, message: string): void => {
    complete = false;
    builder.warn(code, message);
  };

  const noteTime = (at: string | null): void => {
    if (!at) return;
    if (firstAt === null || at < firstAt) firstAt = at;
    if (lastAt === null || at > lastAt) lastAt = at;
  };

  const noteIdentity = (candidate: string | null, line: number): void => {
    if (!candidate) return;
    if (!UUID_PATTERN.test(candidate)) {
      throw new ImportError(
        "conflicting-identity",
        `line ${line} carries a thread id that is not a UUID`,
        line,
      );
    }
    if (threadId === null) {
      threadId = candidate;
      return;
    }
    if (threadId !== candidate) {
      throw new ImportError(
        "conflicting-identity",
        `line ${line} belongs to a different thread than the rest of the file`,
        line,
      );
    }
  };

  /** `ContentItem` / `FunctionCallOutputContentItem` → one string per text item. */
  const contentParts = (content: unknown): string[] => {
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    const parts: string[] = [];
    for (const rawPart of content) {
      const part = asRecord(rawPart);
      if (!part) continue;
      switch (part.type) {
        case "input_text":
        case "output_text": {
          const text = asString(part.text);
          if (text) parts.push(text);
          break;
        }
        case "input_image":
        case "input_audio":
          incomplete(
            "codex.multimodal-dropped",
            "recorded images and audio are not imported, so part of the recorded content is missing",
          );
          break;
        case "encrypted_content":
          // Opaque provider state; never text, never retained.
          break;
        default:
          builder.countUnknown(`content:${String(part.type)}`);
          incomplete(
            "codex.unsupported-content",
            "the rollout contains content this version cannot read; it is not in this snapshot",
          );
          break;
      }
    }
    return parts;
  };

  const contentToText = (content: unknown): string => contentParts(content).join("\n");

  const acceptSessionMeta = (payload: Record<string, unknown>, line: number): void => {
    noteIdentity(asString(payload.id) ?? asString(payload.session_id), line);
    if (cwd === null) {
      const recorded = asString(payload.cwd);
      cwd = recorded ? clampLabel(recorded, limits.maxPathChars) : null;
    }

    if (payload.history_base !== undefined && payload.history_base !== null) {
      // The referenced prefix file is deliberately not opened.
      incomplete(
        "codex.history-prefix-missing",
        "this thread continues an earlier rollout file; the earlier turns are not part of this snapshot",
      );
    }
    if (asString(payload.forked_from_id)) {
      incomplete(
        "codex.forked-thread",
        "this thread was forked from another one; the inherited turns are not part of this snapshot",
      );
    }
    // base_instructions, dynamic_tools, capability roots, memory mode, git info:
    // configuration and environment, counted rather than read.
    builder.dropConfiguration();
  };

  /** `ResponseItem::AgentMessage` — plaintext only when every part is text. */
  const acceptAgentMessage = (payload: Record<string, unknown>, at: string | null): void => {
    const content = Array.isArray(payload.content) ? payload.content : [];
    const parts: string[] = [];
    let encrypted = false;
    for (const rawPart of content) {
      const part = asRecord(rawPart);
      if (!part) continue;
      if (part.type === "input_text") {
        const text = asString(part.text);
        if (text) parts.push(text);
        continue;
      }
      if (part.type === "encrypted_content") {
        encrypted = true;
        continue;
      }
      builder.countUnknown(`agent_message:${String(part.type)}`);
    }
    if (encrypted || parts.length === 0) {
      // The pinned source only treats an agent message as readable when every
      // part is plaintext; anything else is history this snapshot lacks.
      incomplete(
        "codex.agent-message-unreadable",
        "an agent-to-agent message was encrypted or empty, so its text is not in this snapshot",
      );
      return;
    }
    const author = asString(payload.author) ?? "agent";
    const recipient = asString(payload.recipient) ?? "agent";
    builder.append({
      kind: "message",
      speaker: "assistant",
      label: clampLabel(`${author} → ${recipient} (historical)`, limits.maxLabelChars),
      text: parts.join("\n"),
      at,
    });
  };

  const acceptResponseItem = (payload: Record<string, unknown>, at: string | null): void => {
    switch (payload.type) {
      case "message": {
        const speaker = speakerFor(payload.role);
        const parts = contentParts(payload.content);
        const kept: string[] = [];
        let injected = 0;

        for (const part of parts) {
          const structural = STRUCTURAL_USER_PREFIXES.find((entry) =>
            startsWithAny(part, [entry.prefix]),
          );
          if (structural) {
            // Structural, so it is shown — as a notice, without its payload.
            injected += 1;
            builder.append({ kind: "notice", label: structural.label, text: structural.text, at });
            continue;
          }
          const isInjected =
            (speaker === "user" &&
              (startsWithAny(part, INJECTED_USER_PREFIXES) || isLegacyApplyPatchWarning(part))) ||
            (speaker === "system" && startsWithAny(part, INJECTED_DEVELOPER_PREFIXES));
          if (isInjected) {
            // Instruction/environment context Codex injected: counted, never
            // retained, never a title and never an echo key.
            injected += 1;
            builder.dropConfiguration();
            continue;
          }
          if (part.trim().length > 0) kept.push(part);
        }

        if (injected > 0 && kept.length > 0) {
          // A message that is part injected context and part real text: the
          // real text stays, but the split is a judgement call worth flagging.
          builder.warn(
            "codex.injected-context-mixed",
            "a message mixed injected context with ordinary text; only the ordinary text was kept",
          );
        }
        if (kept.length === 0) return;

        const text = kept.join("\n");
        if (speaker === "user" || speaker === "assistant") {
          canonicalConversationMessages += 1;
          const key = echoKey(speaker, text);
          canonicalText.set(key, (canonicalText.get(key) ?? 0) + 1);
        }
        if (speaker === "user" && firstUserText === null) firstUserText = text;
        builder.append({ kind: "message", speaker, text, at });
        return;
      }
      case "agent_message":
        acceptAgentMessage(payload, at);
        return;
      case "reasoning": {
        const summary = Array.isArray(payload.summary) ? payload.summary : [];
        const parts: string[] = [];
        for (const rawPart of summary) {
          const part = asRecord(rawPart);
          const text = part ? asString(part.text) : null;
          if (text) parts.push(text);
        }
        // `encrypted_content` is provider-opaque and never retained.
        if (parts.length > 0) builder.append({ kind: "thinking", text: parts.join("\n"), at });
        return;
      }
      case "function_call": {
        builder.append({
          kind: "activity",
          name: asString(payload.name) ?? "tool",
          text: asString(payload.arguments) ?? "",
          at,
        });
        return;
      }
      case "custom_tool_call": {
        // `{ call_id, name, input: String }` in the pinned models.rs — `input`,
        // not `execution`.
        builder.append({
          kind: "activity",
          name: asString(payload.name) ?? "tool",
          text: asString(payload.input) ?? "",
          at,
        });
        return;
      }
      case "local_shell_call": {
        const action = asRecord(payload.action);
        const command = action && Array.isArray(action.command) ? action.command : null;
        const text = command
          ? command.filter((part): part is string => typeof part === "string").join(" ")
          : "";
        builder.append({ kind: "activity", name: "shell", text, at });
        return;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        // Both carry `FunctionCallOutputBody`: a plain string, or an array of
        // content items.
        builder.append({
          kind: "activity-result",
          name: asString(payload.name) ?? "tool",
          text: contentToText(payload.output),
          at,
        });
        return;
      }
      case "tool_search_call":
      case "tool_search_output": {
        builder.append({
          kind: "activity",
          name: String(payload.type),
          text: asString(payload.execution) ?? "",
          at,
        });
        return;
      }
      default:
        // A model-visible item we cannot read is missing history, not noise.
        builder.countUnknown(`response_item:${String(payload.type)}`);
        incomplete(
          "codex.unsupported-items",
          "the rollout contains model-visible items this version cannot read; they are not in this snapshot",
        );
        return;
    }
  };

  const acceptEvent = (payload: Record<string, unknown>, at: string | null): void => {
    const type = typeof payload.type === "string" ? payload.type : "";
    if (ECHO_EVENTS.has(type)) {
      const text = asString(payload.message);
      if (!text) return;
      const speaker: ImportSpeaker = type === "agent_message" ? "assistant" : "user";
      if (
        speaker === "user" &&
        (startsWithAny(text, INJECTED_USER_PREFIXES) ||
          startsWithAny(
            text,
            STRUCTURAL_USER_PREFIXES.map((entry) => entry.prefix),
          ) ||
          isLegacyApplyPatchWarning(text))
      ) {
        // The same injected context, replayed for the UI. `parse_user_message`
        // in the pinned source refuses to build a user turn out of it, and so
        // does this: counted, never text. The canonical item is the authority
        // for anything structural.
        builder.dropConfiguration();
        return;
      }
      // Appended in source order and tagged; `resolveEchoes` decides at the end
      // whether a canonical copy made it redundant.
      builder.append({ kind: "message", speaker, text, at }, { speaker, text });
      return;
    }
    // Every other event is UI/telemetry plumbing (token counts, exec begin/end,
    // approvals, stream errors). Counted by type label only.
    builder.countUnknown(`event_msg:${type}`);
  };

  return {
    backend: "codex",

    accept({ line, value }) {
      const record = asRecord(value);
      if (!record) {
        throw new ImportError("unsupported-structure", `line ${line} is not a JSON object`, line);
      }
      builder.counts.records += 1;
      const at = validTimestamp(record.timestamp);
      noteTime(at);

      const type = typeof record.type === "string" ? record.type : "";
      const payload = asRecord(record.payload);
      if (!payload) {
        // `RolloutLine` always flattens a wire item that owns a `payload`.
        builder.countUnknown(record.type);
        return;
      }

      if (CONFIGURATION_ITEMS.has(type)) {
        builder.dropConfiguration();
        return;
      }
      switch (type) {
        case "session_meta":
          acceptSessionMeta(payload, line);
          return;
        case "response_item":
          acceptResponseItem(payload, at);
          return;
        case "event_msg":
          acceptEvent(payload, at);
          return;
        case "compacted": {
          // History was replaced by a summary; what it replaced is gone.
          incomplete(
            "codex.compacted",
            "part of this thread was compacted away before it was recorded; the original turns are not in the file",
          );
          builder.append({
            kind: "notice",
            label: "compacted (historical)",
            text: asString(payload.message) ?? "(compacted)",
            at,
          });
          return;
        }
        case "inter_agent_communication":
          // Agent-to-agent conversation this version does not model.
          builder.countUnknown(type);
          incomplete(
            "codex.unsupported-items",
            "the rollout contains model-visible items this version cannot read; they are not in this snapshot",
          );
          return;
        case "realtime_item":
          // "Sparse, model-invisible facts" (pinned lib.rs): presentation only.
          builder.countUnknown(type);
          return;
        default:
          builder.countUnknown(record.type);
          return;
      }
    },

    finish(source: CollectorSource): ImportedTranscript {
      if (threadId === null) {
        throw new ImportError(
          "unsupported-structure",
          "the selected file has no Codex session_meta record",
        );
      }

      // Suppress an echo only while a canonical occurrence is left to account
      // for it; the fourth "yes" with three canonical items stays. Anything
      // kept holds its place in the source order.
      const budget = new Map(canonicalText);
      let keptEchoes = 0;
      builder.resolveEchoes((tag) => {
        const key = echoKey(tag.speaker, tag.text);
        const remaining = budget.get(key) ?? 0;
        if (remaining > 0) {
          budget.set(key, remaining - 1);
          return false;
        }
        keptEchoes += 1;
        return true;
      });

      if (keptEchoes > 0) {
        if (canonicalConversationMessages === 0) {
          // An event-only rollout: the echoes are all the text there is.
          builder.warn(
            "codex.event-echo-fallback",
            "this rollout records no canonical response items, so the transcript was read from event echoes",
            keptEchoes,
          );
        } else {
          // Mixed: some events matched a canonical item and some did not, so
          // this snapshot cannot claim to be a clean canonical history.
          complete = false;
          builder.warn(
            "codex.event-echo-mixed",
            "some replay events did not match a canonical item; they are kept in place and this snapshot may duplicate or miss text",
            keptEchoes,
          );
        }
      }
      if (firstUserText === null) {
        // No canonical user message: fall back to the first surviving one,
        // which for an event-only rollout is an echo.
        const firstUser = builder
          .list()
          .find((entry) => entry.kind === "message" && entry.speaker === "user");
        firstUserText = firstUser && firstUser.kind === "message" ? firstUser.text : null;
      }

      const { entries, warnings, unknownTypes } = builder.finish();
      const envelope = {
        backend: "codex" as const,
        format: CODEX_TRANSCRIPT_FORMAT,
        nativeId: threadId,
        title: firstUserText ? deriveTitle(firstUserText, limits.maxTitleChars) : null,
        sourcePath: source.filePath,
        sourceBytes: source.bytes,
        sourceSha256: source.sha256,
        cwd,
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
