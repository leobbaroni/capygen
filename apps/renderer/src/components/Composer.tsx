/**
 * The composer. Omnigent's shape: a rounded card with the textarea on top,
 * an attach/dictate + agent-picker/send action row under it, and a tray of
 * chips underneath — ported from
 * reference/omnigent/web/src/shell/NewChatDialog.tsx's `NewChatLandingScreen`
 * composer and its in-session counterpart in `pages/ChatPage.tsx`.
 *
 * Enter sends, Shift+Enter newlines — the desktop behaviour; the mobile/coarse
 * pointer exception in the reference does not apply to a Windows app.
 *
 * Slash menu (R14): typing `/` at the start of an empty line filters
 * `commands` as you type (substring, so `pilot` finds `/cockpit:pilot`,
 * grouped into sections by `SlashMenu`); Up/Down move the highlight, Escape
 * dismisses. Selecting a command (click or Enter) either runs it immediately
 * — an argument-less built-in like `/compact` — or inserts it with the caret
 * after it for a command that takes one (`argumentHint` set: `/model`,
 * `/effort`, or any backend/plugin command that declares one) so the
 * argument can be typed before it goes anywhere (`/model opus`,
 * `/cockpit:pilot what's next`). It lives outside the textarea's
 * `overflow-hidden` wrapper, as a direct child of the form, or the popup
 * would be clipped away above it.
 *
 * Harness/model picker (SPEC item 5): lists `harnesses` (from `harness.list`)
 * next to the send button. An agent's backend is fixed for its lifetime
 * (`Harness`: "one harness instance per agent" — CONTEXT.md), so what the
 * picker *does* with a choice depends on `lockBackend`, not on whether `agent`
 * happens to be set:
 *   - `lockBackend` false (the New Session landing, before `startSession` has
 *     run): every available backend is offered however many times the user
 *     changes their mind, and `onPickAgent` just remembers the choice, threaded
 *     into `sessions.create` as the lead agent's backend/model.
 *   - `lockBackend` true (an open, ongoing session): only that backend's own
 *     models are offered, and picking one dispatches through the *existing*
 *     `/model` built-in (R14) rather than any live "swap backends" operation,
 *     because there isn't one — the caller's `onPickAgent` is expected to route
 *     this to `send("/model <id>")`.
 *
 * Unavailable backends stay in the menu as disabled rows carrying
 * `HarnessInfo.reason`, so an expired Codex token or a missing API key reads as
 * a sentence the user can act on instead of an empty list.
 *
 * Attach is disabled until `chat.send` can carry a file
 * (packages/shared/src/ipc.ts): taking one, showing a chip and then dropping
 * it on send is worse than saying it is not available yet. The chip list and
 * `addFiles` stay so the panes phase only has to re-enable the button. The
 * mic toggles the store's `listening` flag, which is real: it drives the
 * mascot's `listening` state (`hooks/useMascotState.ts`) even though actual
 * speech-to-text is Phase 10 (R18/P18).
 *
 * `@mention` autocomplete (SPEC item B2.2, ADR-0002): typing `@` anywhere —
 * not only at the start of a line, unlike the slash menu — filters `agents`
 * by mention name/display name (`MentionMenu`); Up/Down move the highlight,
 * Enter or Tab insert the highlighted agent's `@mentionName` plus one
 * separating space, Escape dismisses. `agents` defaults to `[]`, which keeps
 * the popup from ever appearing (a solo session, or a caller that has not
 * loaded the roster yet) without a separate on/off prop. Detection is
 * caret-based (`activeMentionQuery`/`onSelect`), not "starts with", so a
 * mention mid-sentence works the same as one at the front.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  MicIcon,
  PaperclipIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import type { Agent, Backend, HarnessInfo, SlashCommand } from "@capygen/shared";
import { MentionMenu } from "@/components/MentionMenu";
import { SlashMenu, type McpToolMenuEntry } from "@/components/SlashMenu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { BACKEND_LABEL } from "@/lib/agentDisplay";
import { activeMentionQuery, insertMention, type MentionQuery } from "@/lib/mentions";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

export interface AgentChoice {
  backend: Backend;
  model: string;
}

export interface ComposerProps {
  onSubmit: (text: string) => void | Promise<void>;
  onInterrupt?: () => void;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Rendered in the tray under the textarea (project chip, mode chip, …). */
  tray?: ReactNode;
  /** Slash-command catalogue (R14) — built-ins plus the backend's own. */
  commands?: SlashCommand[];
  /**
   * The selected agent's MCP tools, shown for discovery only.
   *
   * Optional on purpose: a composer with no session behind it (the New Session
   * landing) has no agent to ask about, and the menu simply omits the section.
   * These rows are never selectable and never become a command — the agent
   * calls a tool, the user does not.
   */
  mcpTools?: McpToolMenuEntry[];
  /** Why there are no tool rows, when that is worth saying. */
  mcpStatus?: string | null;
  /** Backend/model catalogue for the picker (`harness.list`). Omitted or
   *  empty: the picker still shows the current/default choice, just with
   *  nothing to switch to. */
  harnesses?: HarnessInfo[];
  /** The agent the picker is showing, or `null`/undefined before one exists
   *  (a brand-new session on the New Session landing). */
  agent?: AgentChoice | null;
  /**
   * Narrow the picker to `agent`'s own backend. True only where an agent
   * genuinely exists (ChatPage): an agent's backend is fixed for its lifetime.
   *
   * Deliberately **not** derived from `agent != null`, which is what it used to
   * be — the landing passes `agent` too, just to label the button, so picking
   * "Codex" there locked the whole page to Codex with no way back to Claude
   * short of navigating away, for a session that did not exist yet.
   */
  lockBackend?: boolean;
  /** A different backend/model was chosen — see the file header for what
   *  "picking" means with vs. without `agent`. */
  onPickAgent?: (choice: AgentChoice) => void;
  /**
   * False for a backend that cannot run `/model` at all — the `api` backend,
   * whose `capabilities().slashCommands` is false and whose harness has no
   * leading-slash handling, so a pick would reach the provider as the literal
   * chat message "/model <id>" and the agent would keep its old model. The
   * picker then renders disabled, still labelled with the current model.
   */
  canPickModel?: boolean;
  /** Session agents the `@mention` menu can suggest (SPEC item B2.2). Empty
   *  (the default) keeps the menu from ever opening — a solo session's one
   *  agent has nothing worth mentioning. */
  agents?: Agent[];
  testId?: string;
}

export function Composer({
  onSubmit,
  onInterrupt,
  busy = false,
  disabled = false,
  placeholder = "Describe a task…",
  autoFocus = true,
  tray,
  commands = [],
  mcpTools,
  mcpStatus = null,
  harnesses = [],
  agent = null,
  lockBackend = false,
  onPickAgent,
  canPickModel = true,
  agents = [],
  testId = "composer",
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  /** The exact draft Escape closed the menu for; editing it reopens the menu. */
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);
  /** The exact `@query` Escape closed the mention menu for — same pattern as
   *  `slashDismissedFor`, compared by the surrounding draft since the query
   *  itself carries no stable identity across renders. */
  const [mentionDismissedFor, setMentionDismissedFor] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listening = useAppStore((s) => s.listening);
  const setListening = useAppStore((s) => s.setListening);

  // G1: the composer is focused and usable the moment the window paints.
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // Grow with the content up to a cap, then scroll inside.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  // Never leave the mascot stuck "listening" if this composer unmounts
  // (route change) while the mic is toggled on.
  useEffect(() => () => setListening(false), [setListening]);

  const slashActive =
    value.startsWith("/") &&
    !value.slice(1).includes(" ") &&
    !disabled &&
    value !== slashDismissedFor;
  const filteredCommands = useMemo(() => {
    if (!slashActive) return [];
    // Substring, not prefix: plugin commands are namespaced (`/cockpit:pilot`),
    // so typing what you remember of the name has to find them.
    const query = value.slice(1).toLowerCase();
    return commands.filter((c) => c.name.slice(1).toLowerCase().includes(query));
  }, [slashActive, value, commands]);
  /**
   * The menu also opens when the only thing to show is informational.
   *
   * It used to require at least one slash command, which hid the MCP section
   * entirely on any backend that publishes none — the API backend, or a Claude
   * session before its commands have loaded. Those are exactly the cases where
   * a person most wants to see what tools the agent has.
   *
   * Opening it changes no keyboard semantics: Arrow keys and Enter below stay
   * gated on `filteredCommands.length`, so with nothing selectable Enter still
   * submits the message and the arrows still move the caret. An informational
   * row cannot be highlighted, chosen, or turned into a command.
   */
  const hasMcpInfo = (mcpTools?.length ?? 0) > 0 || mcpStatus !== null;
  const slashMenuOpen = slashActive && (commands.length > 0 || hasMcpInfo);

  // `@mention` autocomplete (SPEC item B2.2) — same "open whenever there is
  // anything to offer, filter separately" shape as the slash menu just
  // above, so `onKeyDown` only ever intercepts keys when a highlighted row
  // genuinely exists.
  const mentionActive =
    mentionQuery !== null && !slashActive && !disabled && value !== mentionDismissedFor;
  const filteredAgents = useMemo(() => {
    if (!mentionActive || !mentionQuery) return [];
    const query = mentionQuery.query.toLowerCase();
    return agents.filter(
      (a) => a.mentionName.toLowerCase().includes(query) || a.displayName.toLowerCase().includes(query),
    );
  }, [mentionActive, mentionQuery, agents]);
  const mentionMenuOpen = mentionActive && agents.length > 0;

  useEffect(() => {
    setHighlighted(0);
  }, [value]);

  /**
   * Send `text`, and put it back in the draft if it could not go — shared by
   * `submit()` (whatever is currently typed) and an argument-less slash
   * command run straight from the menu (SPEC R14).
   *
   * The draft is cleared first so the composer feels instant, which means a
   * rejected `chat.send` (an unknown session, a backend that refused) would
   * otherwise destroy what the user typed with nothing shown anywhere.
   */
  async function sendText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === "" || disabled) return;
    const keptFiles = files;
    setValue("");
    setFiles([]);
    setSendError(null);
    // A stale in-progress "@query" would otherwise survive the programmatic
    // clear above (setValue doesn't fire the textarea's own onChange/onSelect)
    // and could reopen the mention menu against indices that no longer match
    // the now-empty draft.
    setMentionQuery(null);
    setMentionDismissedFor(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setValue((current) => (current === "" ? trimmed : current));
      setFiles(keptFiles);
      setSendError(err instanceof Error ? err.message : String(err));
      ref.current?.focus();
    }
  }

  async function submit(): Promise<void> {
    await sendText(value);
  }

  /**
   * A command with no `argumentHint` (SPEC R14: "Enter runs argument-less
   * commands") sends immediately; one that takes an argument is written into
   * the composer instead, caret after it, so the argument can be typed
   * before anything is sent — the only way `/model opus` or
   * `/cockpit:pilot what's next` can be dispatched at all.
   */
  function selectCommand(command: SlashCommand): void {
    setSlashDismissedFor(null);
    if (!command.argumentHint) {
      void sendText(command.name);
      return;
    }
    setValue(`${command.name} `);
    ref.current?.focus();
  }

  /**
   * Inserts the picked agent's `@mentionName` in place of the in-progress
   * query (SPEC item B2.2). No explicit caret placement, deliberately —
   * same as `selectCommand` just above: setting a controlled textarea's
   * `.value` resets its selection to the end of the new text as a normal
   * DOM side effect, which is exactly where the caret belongs for the
   * common case (a mention typed at the point the user is currently
   * writing). An explicit `setSelectionRange` inside a `requestAnimationFrame`
   * was tried and dropped — it fired *after* `user.type`'s next keystrokes
   * in fast/scripted typing, yanking the caret back mid-word.
   */
  function selectMention(picked: Agent): void {
    if (!mentionQuery) return;
    const result = insertMention(value, mentionQuery, picked.mentionName);
    setMentionDismissedFor(null);
    setMentionQuery(null);
    setValue(result.text);
    ref.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // Escape closes the menu whatever it is showing — an informational-only
    // menu is still something the user asked to be rid of.
    if (slashMenuOpen && event.key === "Escape") {
      event.preventDefault();
      setSlashDismissedFor(value);
      return;
    }
    // Everything below moves or chooses a *command*, so it stays gated on
    // there being one: with only informational rows, these keys belong to the
    // textarea exactly as they did before this menu could open.
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted((h) => (h + 1) % filteredCommands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((h) => (h - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const command = filteredCommands[highlighted] ?? filteredCommands[0];
        if (command) selectCommand(command);
        return;
      }
    }
    if (mentionMenuOpen && filteredAgents.length > 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionDismissedFor(value);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted((h) => (h + 1) % filteredAgents.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((h) => (h - 1 + filteredAgents.length) % filteredAgents.length);
        return;
      }
      if (
        (event.key === "Enter" || event.key === "Tab") &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        const picked = filteredAgents[highlighted] ?? filteredAgents[0];
        if (picked) selectMention(picked);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  function addFiles(list: FileList | null): void {
    if (!list || list.length === 0) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
  }

  // Harness/model picker (SPEC item 5). Only the backends `harness.list`
  // reports available can be *chosen*; `lockBackend` narrows that to the open
  // agent's own backend (an agent cannot switch backends — see the header).
  const locked = lockBackend && agent ? agent.backend : null;
  const pickableHarnesses = harnesses.filter(
    (h) => h.available && (!locked || h.backend === locked),
  );
  // Unavailable backends are shown, disabled, with the reason `harness.list`
  // computed (`no Claude login found — run \`claude login\``, an expired Codex
  // token, a missing API key). They used to be filtered out entirely, so a user
  // whose token had expired saw "No models available" and no way to learn why.
  const unavailableHarnesses = locked ? [] : harnesses.filter((h) => !h.available);
  const pickerLabel = agent
    ? `${BACKEND_LABEL[agent.backend]} · ${agent.model}`
    : "Choose model";

  function pick(backend: Backend, model: string): void {
    setAgentMenuOpen(false);
    onPickAgent?.({ backend, model });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      data-testid={testId}
      className={cn(
        "relative z-10 flex w-full flex-col rounded-2xl border border-border bg-card dark:bg-card-solid",
        "transition-shadow duration-150 has-[textarea:focus]:shadow-[var(--composer-shadow-focus)]",
      )}
    >
      {slashMenuOpen ? (
        <SlashMenu
          commands={filteredCommands}
          mcpTools={mcpTools}
          mcpStatus={mcpStatus}
          highlightedIndex={highlighted}
          onHover={setHighlighted}
          onSelect={selectCommand}
        />
      ) : mentionMenuOpen ? (
        <MentionMenu
          agents={filteredAgents}
          highlightedIndex={highlighted}
          onHover={setHighlighted}
          onSelect={selectMention}
        />
      ) : null}

      <div className="relative overflow-hidden px-4 pt-3">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
            const next = e.target.value;
            setValue(next);
            setMentionQuery(activeMentionQuery(next, e.target.selectionStart ?? next.length));
          }}
          onKeyDown={onKeyDown}
          onSelect={(e: SyntheticEvent<HTMLTextAreaElement>) => {
            const el = e.currentTarget;
            setMentionQuery(activeMentionQuery(el.value, el.selectionStart ?? el.value.length));
          }}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          spellCheck={false}
          data-testid={`${testId}-input`}
          aria-label="Message"
          className="max-h-[220px] min-h-[24px] overflow-y-auto"
        />
      </div>

      {sendError ? (
        <p
          role="alert"
          data-testid={`${testId}-error`}
          className="px-4 pt-1 text-xs text-destructive"
        >
          Could not send: {sendError}
        </p>
      ) : null}

      {files.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-4 pb-1">
          {files.map((file, i) => (
            <span
              key={`${file.name}-${i}`}
              className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              <span className="max-w-32 truncate">{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                className="ml-0.5 rounded-full hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-2.5">
        <div className="flex items-center gap-0.5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
            data-testid={`${testId}-file-input`}
          />
          {/* Disabled on purpose: `chat.send` carries only text, so accepting
              a file here would show a chip and then drop it silently. */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled
            onClick={() => fileInputRef.current?.click()}
            title="Attachments arrive with the file panes (Phase 5)"
            aria-label="Attach files"
            data-testid={`${testId}-attach`}
          >
            <PaperclipIcon className="size-4" />
          </Button>
          <Button
            type="button"
            variant={listening ? "secondary" : "ghost"}
            size="icon-sm"
            disabled={disabled}
            onClick={() => setListening(!listening)}
            title={listening ? "Stop dictation" : "Dictate"}
            aria-label={listening ? "Stop dictation" : "Dictate"}
            aria-pressed={listening}
            data-testid={`${testId}-mic`}
          >
            <MicIcon className={cn("size-4", listening && "text-destructive")} />
          </Button>
        </div>

        <div className="flex min-w-0 items-center gap-1.5">
          <div className="relative flex items-center rounded-lg transition-colors hover:bg-muted">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 pr-1.5"
              onClick={() => setAgentMenuOpen((v) => !v)}
              aria-expanded={agentMenuOpen}
              // `canPickModel === false` is a backend with no command layer
              // (`ApiHarness.capabilities().slashCommands`), where picking a
              // model used to send the literal text "/model <id>" to the
              // provider as a chat message and change nothing. The button
              // still names the current model; it just stops pretending to be
              // a control.
              disabled={canPickModel === false}
              title={canPickModel === false ? "This backend has no /model command." : undefined}
              data-testid={`${testId}-agent-picker`}
            >
              <span className="max-w-40 truncate">{pickerLabel}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
            </Button>
            {agentMenuOpen ? (
              <ul
                role="listbox"
                data-testid={`${testId}-agent-menu`}
                className="absolute right-0 bottom-full z-20 mb-1 max-h-72 min-w-52 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm shadow-menu"
              >
                {pickableHarnesses.length === 0 && unavailableHarnesses.length === 0 ? (
                  <li className="px-2 py-1.5 text-xs text-muted-foreground">
                    No models available
                  </li>
                ) : null}
                {pickableHarnesses.map((harness) => (
                  <li key={harness.backend}>
                    {!locked ? (
                      <div className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
                        {harness.label}
                      </div>
                    ) : null}
                    {harness.models.map((model) => {
                      const isCurrent =
                        agent?.backend === harness.backend && agent.model === model.id;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          role="option"
                          aria-selected={isCurrent}
                          data-testid={`${testId}-agent-option`}
                          onClick={() => pick(harness.backend, model.id)}
                          className={cn(
                            "w-full rounded-md px-2 py-1.5 text-left text-foreground hover:bg-accent",
                            isCurrent && "bg-accent",
                          )}
                        >
                          {locked ? model.label : `${harness.label} — ${model.label}`}
                        </button>
                      );
                    })}
                  </li>
                ))}
                {unavailableHarnesses.map((harness) => (
                  <li
                    key={harness.backend}
                    data-testid={`${testId}-agent-unavailable`}
                    data-backend={harness.backend}
                    className="px-2 py-1.5 opacity-60"
                    title={harness.reason ?? "unavailable"}
                  >
                    <div className="text-xs font-medium text-muted-foreground">
                      {harness.label}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {harness.reason ?? "unavailable"}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {busy ? (
            <Button
              variant="secondary"
              size="icon-sm"
              onClick={onInterrupt}
              aria-label="Stop"
              data-testid={`${testId}-stop`}
            >
              <SquareIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon-sm"
              disabled={disabled || value.trim() === ""}
              aria-label="Send"
              data-testid={`${testId}-send`}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {tray ? (
        <div className="flex flex-wrap items-center gap-1 border-t border-border-weak px-2 py-1.5">
          {tray}
        </div>
      ) : null}
    </form>
  );
}
