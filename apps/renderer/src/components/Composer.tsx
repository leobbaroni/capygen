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
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  MicIcon,
  PaperclipIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import type { Backend, HarnessInfo, SlashCommand } from "@capygen/shared";
import { SlashMenu } from "@/components/SlashMenu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

export interface AgentChoice {
  backend: Backend;
  model: string;
}

const BACKEND_LABEL: Record<Backend, string> = {
  claude: "Claude Code",
  codex: "Codex",
  api: "API model",
};

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
  harnesses = [],
  agent = null,
  lockBackend = false,
  onPickAgent,
  testId = "composer",
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  /** The exact draft Escape closed the menu for; editing it reopens the menu. */
  const [slashDismissedFor, setSlashDismissedFor] = useState<string | null>(null);
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
  const slashMenuOpen = slashActive && commands.length > 0;

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

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (slashMenuOpen && filteredCommands.length > 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashDismissedFor(value);
        return;
      }
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
          highlightedIndex={highlighted}
          onHover={setHighlighted}
          onSelect={selectCommand}
        />
      ) : null}

      <div className="relative overflow-hidden px-4 pt-3">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
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
