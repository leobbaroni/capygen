/**
 * Slash-command menu (R14): filtered as the user types after `/`, grouped
 * into sections by `SlashCommand.source` — Built-ins, Skills, Plugins,
 * Backend commands, in that order, each only rendered when it has a match —
 * modelled on reference/omnigent/web/src/components/SlashCommandMenu.tsx's
 * "Commands"/"Skills" split, generalised to capygen's four sources.
 * `Composer` owns the open/highlight state and the filtering; this is the
 * popup's presentation only. The highlight index is flat across the whole
 * filtered+grouped list (the order `commands` already arrives in — built-ins
 * first, then the backend's own — so grouping here never disagrees with
 * `Composer`'s Up/Down index).
 */
import type { SlashCommand } from "@capygen/shared";
import { cn } from "@/lib/utils";

const SOURCE_SECTION: Record<SlashCommand["source"], string> = {
  builtin: "Built-ins",
  backend: "Backend commands",
  skill: "Skills",
  plugin: "Plugins",
};

/** Section display order — independent of whatever order `commands` arrives
 *  in, so a backend that lists its own commands before skills (or vice
 *  versa) still renders the same, familiar section order. */
const SECTION_ORDER: SlashCommand["source"][] = ["builtin", "skill", "plugin", "backend"];

export interface SlashMenuProps {
  commands: SlashCommand[];
  /** Session-effective MCP tools are discovery-only rows, never commands. */
  mcpTools?: McpToolMenuEntry[];
  /**
   * Why there are no tool rows, when that needs saying.
   *
   * A backend that cannot report its tools, one whose agent has not started,
   * and one that genuinely has none are three different facts. Showing an empty
   * section for all three tells a person nothing, so the reason is rendered in
   * the section instead.
   */
  mcpStatus?: string | null;
  highlightedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}

export interface McpToolMenuEntry {
  serverName: string;
  name: string;
}

export function SlashMenu({
  commands, mcpTools = [], mcpStatus = null, highlightedIndex, onSelect, onHover,
}: SlashMenuProps) {
  if (commands.length === 0 && mcpTools.length === 0 && mcpStatus === null) {
    return (
      <div
        data-testid="slash-menu"
        className="absolute bottom-full left-0 mb-1.5 w-full max-w-sm rounded-lg border border-border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-menu"
      >
        No matching commands
      </div>
    );
  }

  // The flat index every command row carries is its position in `commands` — the
  // same array Composer's Up/Down arithmetic uses — so grouping the *display*
  // by section never has to touch (or risk desyncing from) the keyboard index.
  const flatIndex = new Map(commands.map((c, i) => [c, i]));
  const sections = SECTION_ORDER.map((source) => ({
    source,
    items: commands.filter((c) => c.source === source),
  })).filter((s) => s.items.length > 0);

  return (
    <ul
      data-testid="slash-menu"
      role="listbox"
      className="absolute bottom-full left-0 mb-1.5 max-h-72 w-full max-w-sm overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-menu"
    >
      {commands.length === 0 ? null : sections.map(({ source, items }) => (
        <li key={source} data-testid="slash-menu-section">
          {sections.length > 1 ? (
            <div className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
              {SOURCE_SECTION[source]}
            </div>
          ) : null}
          <ul>
            {items.map((command) => {
              const i = flatIndex.get(command) ?? -1;
              return (
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
                      <span className="font-mono">
                        {command.name}
                        {command.argumentHint ? (
                          <span className="ml-1.5 font-sans text-xs text-muted-foreground">
                            {command.argumentHint}
                          </span>
                        ) : null}
                      </span>
                      {command.description ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {command.description}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
      {mcpTools.length > 0 || mcpStatus !== null ? (
        <li data-testid="slash-menu-mcp-section">
          <div className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">MCP tools</div>
          <div className="px-2 pb-1 text-xs text-muted-foreground">Called by the agent</div>
          {mcpStatus !== null ? (
            <div data-testid="slash-menu-mcp-status" className="px-2 pb-1.5 text-xs text-muted-foreground">
              {mcpStatus}
            </div>
          ) : null}
          <ul>
            {mcpTools.map((tool) => (
              <li key={`${tool.serverName}:${tool.name}`}>
                <div
                  role="option"
                  aria-disabled="true"
                  data-testid="slash-menu-mcp-tool"
                  className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground"
                >
                  <span className="break-words font-mono">{tool.name}</span>
                  <span className="break-words text-xs">{tool.serverName}</span>
                </div>
              </li>
            ))}
          </ul>
        </li>
      ) : null}
    </ul>
  );
}
