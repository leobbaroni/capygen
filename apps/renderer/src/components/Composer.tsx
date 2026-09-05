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
 * `commands` as you type; Up/Down move the highlight, Enter or a click sends
 * the picked command straight through (matching the reference: "selecting
 * one sends it to the backend").
 *
 * Attach and mic are visual affordances for now: `chat.send` only carries
 * text (packages/shared/src/ipc.ts), so there is nowhere to put an
 * attachment yet — the chip list is kept locally and cleared on send. The
 * mic toggles the store's `listening` flag, which is real: it drives the
 * mascot's `listening` state (`hooks/useMascotState.ts`) even though actual
 * speech-to-text is Phase 10 (R18/P18).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  MicIcon,
  PaperclipIcon,
  SettingsIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import type { SlashCommand } from "@capygen/shared";
import { SlashMenu } from "@/components/SlashMenu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

export interface ComposerProps {
  onSubmit: (text: string) => void | Promise<void>;
  onInterrupt?: () => void;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Rendered in the tray under the textarea (project chip, mode chip, …). */
  tray?: React.ReactNode;
  /** Slash-command catalogue (R14) — built-ins plus the backend's own. */
  commands?: SlashCommand[];
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
  testId = "composer",
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
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

  const slashActive = value.startsWith("/") && !value.slice(1).includes(" ") && !disabled;
  const filteredCommands = useMemo(() => {
    if (!slashActive) return [];
    const query = value.slice(1).toLowerCase();
    return commands.filter((c) => c.name.slice(1).toLowerCase().startsWith(query));
  }, [slashActive, value, commands]);
  const slashMenuOpen = slashActive && commands.length > 0;

  useEffect(() => {
    setHighlighted(0);
  }, [value]);

  async function submit(): Promise<void> {
    const text = value.trim();
    if (text === "" || disabled) return;
    setValue("");
    setFiles([]);
    await onSubmit(text);
  }

  function selectCommand(command: SlashCommand): void {
    setValue("");
    void onSubmit(command.name);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
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
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  function addFiles(list: FileList | null): void {
    if (!list || list.length === 0) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
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
      <div className="relative overflow-hidden px-4 pt-3">
        {slashMenuOpen ? (
          <SlashMenu
            commands={filteredCommands}
            highlightedIndex={highlighted}
            onHover={setHighlighted}
            onSelect={selectCommand}
          />
        ) : null}
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
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            title="Attach files"
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
              <span className="max-w-28 truncate">Claude Code</span>
              <ChevronDownIcon className="size-3.5 shrink-0 opacity-60" />
            </Button>
            <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => navigate("/settings/harnesses")}
              title="Configure Claude Code"
              aria-label="Configure Claude Code"
              data-testid={`${testId}-agent-gear`}
            >
              <SettingsIcon className="size-4" />
            </Button>
            {agentMenuOpen ? (
              <ul
                role="listbox"
                data-testid={`${testId}-agent-menu`}
                className="absolute right-0 bottom-full z-20 mb-1 min-w-40 rounded-lg border border-border bg-popover p-1 text-sm shadow-menu"
              >
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected="true"
                    onClick={() => setAgentMenuOpen(false)}
                    className="w-full rounded-md px-2 py-1.5 text-left text-foreground hover:bg-accent"
                  >
                    Claude Code
                  </button>
                </li>
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
