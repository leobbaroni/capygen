/**
 * Slash-command menu (R14): filtered as the user types after `/`, built-ins
 * first then the backend's own commands/skills/plugin commands — the source
 * badge tells them apart. `Composer` owns the open/highlight state and the
 * filtering; this is the popup's presentation only.
 */
import type { SlashCommand } from "@capygen/shared";
import { cn } from "@/lib/utils";

const SOURCE_LABEL: Record<SlashCommand["source"], string> = {
  builtin: "built-in",
  backend: "backend",
  skill: "skill",
  plugin: "plugin",
};

export interface SlashMenuProps {
  commands: SlashCommand[];
  highlightedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}

export function SlashMenu({ commands, highlightedIndex, onSelect, onHover }: SlashMenuProps) {
  if (commands.length === 0) {
    return (
      <div
        data-testid="slash-menu"
        className="absolute bottom-full left-0 mb-1.5 w-full max-w-sm rounded-lg border border-border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-menu"
      >
        No matching commands
      </div>
    );
  }

  return (
    <ul
      data-testid="slash-menu"
      role="listbox"
      className="absolute bottom-full left-0 mb-1.5 max-h-64 w-full max-w-sm overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-menu"
    >
      {commands.map((command, i) => (
        <li key={command.name}>
          <button
            type="button"
            role="option"
            aria-selected={i === highlightedIndex}
            data-testid="slash-menu-item"
            data-highlighted={i === highlightedIndex || undefined}
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(command)}
            className={cn(
              "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm",
              i === highlightedIndex
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/60",
            )}
          >
            <span className="flex min-w-0 flex-col">
              <span className="font-mono">{command.name}</span>
              {command.description ? (
                <span className="truncate text-xs text-muted-foreground">
                  {command.description}
                </span>
              ) : null}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {SOURCE_LABEL[command.source]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
