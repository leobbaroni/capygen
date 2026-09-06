/**
 * `@mention` autocomplete popup (SPEC item B2.2): lists the session's agents
 * matching whatever the user typed after "@", the same shape as `SlashMenu`
 * (filtering/highlighting/keyboard nav owned by `Composer`; this is
 * presentation only) so the two popups feel like one family.
 */
import type { Agent } from "@capygen/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { BACKEND_LABEL } from "@/lib/agentDisplay";
import { cn } from "@/lib/utils";

export interface MentionMenuProps {
  agents: Agent[];
  highlightedIndex: number;
  onHover: (index: number) => void;
  onSelect: (agent: Agent) => void;
}

export function MentionMenu({ agents, highlightedIndex, onHover, onSelect }: MentionMenuProps) {
  if (agents.length === 0) {
    return (
      <div
        data-testid="mention-menu"
        className="absolute bottom-full left-0 mb-1.5 w-full max-w-sm rounded-lg border border-border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-menu"
      >
        No matching agents
      </div>
    );
  }

  return (
    <ul
      data-testid="mention-menu"
      role="listbox"
      className="absolute bottom-full left-0 mb-1.5 max-h-72 w-full max-w-sm overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-menu"
    >
      {agents.map((agent, i) => (
        <li key={agent.id}>
          <button
            type="button"
            role="option"
            aria-selected={i === highlightedIndex}
            data-testid="mention-menu-item"
            data-highlighted={i === highlightedIndex || undefined}
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(agent)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
              i === highlightedIndex
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/60",
            )}
          >
            <AgentAvatar agent={agent} size={20} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-mono">@{agent.mentionName}</span>
              <span className="truncate text-xs text-muted-foreground">
                {agent.displayName} · {BACKEND_LABEL[agent.backend]}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
