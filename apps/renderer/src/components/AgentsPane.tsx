/**
 * Agents pane (SPEC item B2.3, R13): a right-side workspace rail listing the
 * session's top-level agents and the sub-agents each has spawned (subagent
 * blocks grouped by `parentAgentId`), modelled on the reference's Agents
 * rail (`reference/omnigent/web/src/pages/ChatPage.tsx`/`AppShell.tsx`)
 * adapted to capygen's plain top-level-agent + subagent-block shape — there
 * is no nested child-session tree here, just one flat roster and each
 * agent's own spawns.
 *
 * Clicking a top-level agent's row pushes `AgentInfoDrawer` in over the tree
 * (a "Back" arrow returns); "+ Add agent" opens `AddAgentDialog` in `live`
 * mode, shown only in round-table sessions.
 *
 * The roster is editable, not append-only: each row carries "Make lead"
 * (`agents.setLead`) and "Remove" (`agents.remove`), and the info drawer edits
 * the agent's own sub-agent routing rule (`agents.update`). Without those the
 * three store methods and their IPC channels had no caller at all — an agent
 * added with the wrong backend could never be taken out again, the crown was
 * display-only, and R12's per-agent routing was unreachable after creation.
 *
 * This is a fixed-width side panel, not a dockable pane — the real dockview
 * workspace (Files/Editor/Diff/Browser/Terminal/Agents/Tasks/Servers, SPEC
 * R16/R17) is Phase 5; `ChatPage` toggles this one from its own header
 * button in the meantime.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, CrownIcon, PlusIcon, Trash2Icon, UsersIcon, XIcon } from "lucide-react";
import type { Agent, SubagentBlock } from "@capygen/shared";
import { AddAgentDialog } from "@/components/AddAgentDialog";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentInfoDrawer } from "@/components/AgentInfoDrawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/appStore";

const SUBAGENT_STATUS_VARIANT = {
  spawned: "outline",
  running: "info",
  done: "success",
  error: "destructive",
} as const;

export interface AgentsPaneProps {
  sessionId: string;
  onClose: () => void;
  /** [C] Overrides the fixed-width aside shell for the dockview panel that
   *  wraps this component (`panes/agents/AgentsWorkspacePane.tsx`). As a
   *  right-docked aside it is a 288px column with a left rule; inside a
   *  dockview panel that same markup is a 288px card pinned to the top-left
   *  of a panel of any size, with a border floating in the middle of the
   *  workspace and bare group background beside it — and Agents is the
   *  default layout's *active tab*, so that was the workspace's first
   *  impression. */
  className?: string;
}

export function AgentsPane({ sessionId, onClose, className }: AgentsPaneProps) {
  const agents = useAppStore((s) => s.agents);
  const blocks = useAppStore((s) => s.blocks);
  const harnesses = useAppStore((s) => s.harnesses);
  const session = useAppStore((s) => s.sessions.find((x) => x.id === sessionId));
  const setLead = useAppStore((s) => s.setLead);
  const removeAgent = useAppStore((s) => s.removeAgent);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const subagentsByParent = useMemo(() => {
    const map = new Map<string, SubagentBlock[]>();
    for (const block of Object.values(blocks)) {
      if (block.kind !== "subagent" || block.sessionId !== sessionId) continue;
      const parentId = block.parentAgentId;
      if (!parentId) continue;
      const bucket = map.get(parentId);
      if (bucket) bucket.push(block);
      else map.set(parentId, [block]);
    }
    return map;
  }, [blocks, sessionId]);

  const ordered = [...agents].sort((a, b) => a.order - b.order);
  const selectedAgent = ordered.find((a) => a.id === selectedAgentId) ?? null;

  return (
    <aside
      data-testid="agents-pane"
      className={cn("flex w-72 shrink-0 flex-col border-l border-border-weak bg-card", className)}
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border-weak px-3">
        <UsersIcon className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-sm font-medium text-foreground">Agents</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close agents pane"
          data-testid="agents-pane-close"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      {selectedAgent ? (
        <AgentInfoDrawer agent={selectedAgent} onBack={() => setSelectedAgentId(null)} />
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto p-2" data-testid="agents-tree">
            {ordered.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">No agents yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {ordered.map((agent) => (
                  <AgentTreeRow
                    key={agent.id}
                    agent={agent}
                    subagents={subagentsByParent.get(agent.id) ?? []}
                    onSelect={() => setSelectedAgentId(agent.id)}
                    onMakeLead={() => void setLead(sessionId, agent.id)}
                    // The last agent is not removable: a session with an empty
                    // roster answers nothing, and `resolveTargets` would have
                    // no lead to fall back to.
                    onRemove={
                      ordered.length > 1
                        ? () => {
                            if (selectedAgentId === agent.id) setSelectedAgentId(null);
                            void removeAgent(agent.id);
                          }
                        : null
                    }
                  />
                ))}
              </ul>
            )}
          </div>

          {session?.mode === "round-table" ? (
            <div className="border-t border-border-weak p-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-center gap-1.5"
                onClick={() => setAddOpen(true)}
                data-testid="agents-pane-add"
              >
                <PlusIcon className="size-3.5" />
                Add agent
              </Button>
            </div>
          ) : null}
        </>
      )}

      <AddAgentDialog
        mode="live"
        sessionId={sessionId}
        open={addOpen}
        onOpenChange={setAddOpen}
        harnesses={harnesses}
        existingMentionNames={agents.map((a) => a.mentionName.toLowerCase())}
      />
    </aside>
  );
}

function AgentTreeRow({
  agent,
  subagents,
  onSelect,
  onMakeLead,
  onRemove,
}: {
  agent: Agent;
  subagents: SubagentBlock[];
  onSelect: () => void;
  onMakeLead: () => void;
  /** Null when this agent cannot be removed (it is the only one left). */
  onRemove: (() => void) | null;
}) {
  // `useState(subagents.length > 0)` alone latched the value from the first
  // render: opening the pane *before* an agent spawns anything left the row
  // collapsed for the rest of the session, however many sub-agents arrived —
  // the tree would show a disclosure triangle and nothing under it. Auto-open
  // when the first one appears; after that the user's own toggle stands.
  const [open, setOpen] = useState(subagents.length > 0);
  const hadSubagents = useRef(subagents.length > 0);
  useEffect(() => {
    if (subagents.length > 0 && !hadSubagents.current) {
      hadSubagents.current = true;
      setOpen(true);
    }
  }, [subagents.length]);
  return (
    <li data-testid="agents-tree-row" data-agent-id={agent.id}>
      <div className="flex items-center gap-1">
        {subagents.length > 0 ? (
          <button
            type="button"
            aria-label={open ? "Collapse" : "Expand"}
            data-testid="agents-tree-toggle"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 text-muted-foreground"
          >
            <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          <span className="w-3.5 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          data-testid="agent-tree-select"
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-accent/50"
        >
          <AgentAvatar agent={agent} size={18} />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{agent.displayName}</span>
        </button>
        {agent.role === "lead" ? (
          <CrownIcon className="size-3 shrink-0 text-warning" aria-label="Lead agent" />
        ) : (
          <button
            type="button"
            data-testid="agent-make-lead"
            aria-label={`Make ${agent.displayName} the lead agent`}
            title="Make lead"
            onClick={onMakeLead}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-warning"
          >
            <CrownIcon className="size-3" />
          </button>
        )}
        {onRemove ? (
          <button
            type="button"
            data-testid="agent-remove"
            aria-label={`Remove ${agent.displayName}`}
            title="Remove from this session"
            onClick={onRemove}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent/50 hover:text-destructive"
          >
            <Trash2Icon className="size-3" />
          </button>
        ) : null}
      </div>
      {open && subagents.length > 0 ? (
        <ul className="ml-6 flex flex-col gap-0.5 border-l border-border-weak pl-2">
          {subagents.map((sub) => (
            <li
              key={sub.id}
              data-testid="agents-tree-subagent"
              className="flex items-center gap-1.5 px-1.5 py-1 text-xs"
            >
              {/* The name has priority over the model id: it is the thing
                  the tree exists to show, and a `shrink-0` model id used to
                  push it down to "re…" inside this 288px rail. `title`
                  makes the truncated form recoverable either way. */}
              <span className="min-w-0 flex-1 truncate text-foreground" title={sub.name}>
                {sub.name}
              </span>
              {sub.model ? (
                <span className="min-w-0 max-w-24 truncate text-muted-foreground" title={sub.model}>
                  {sub.model}
                </span>
              ) : null}
              <Badge variant={SUBAGENT_STATUS_VARIANT[sub.status]}>{sub.status}</Badge>
              {sub.costUsd ? (
                <span className="shrink-0 text-muted-foreground">${sub.costUsd.toFixed(4)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
