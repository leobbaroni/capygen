/**
 * Wraps the existing `AgentsPane` (SPEC R13, Phase 4) as a dockview panel —
 * the whole of item B2.5. `AgentsPane` itself is untouched (its own tests,
 * `AgentsPane.test.tsx`, import and exercise it directly and stay green
 * unmodified); this file only adapts its `onClose` prop to the dockview
 * panel's own `api.close()` so the pane's internal header X button still
 * does something sensible when it is a dockview tab instead of `ChatPage`'s
 * old fixed-width aside.
 *
 * `AgentsPane`'s own markup is the right-docked aside `ChatPage` used before
 * this phase: `w-72 shrink-0 border-l`, and no `h-full`. Inside a dockview
 * panel that renders as a 288px card in the top-left corner of a panel of
 * any size, with a vertical rule floating in the middle of the workspace and
 * bare group background to the right of it — and Agents is the default
 * layout's active tab, so it was the first thing anyone saw. The pane takes
 * a `className` for exactly this: fill the panel, drop the aside's rule.
 */
import { UsersIcon } from "lucide-react";
import { AgentsPane } from "@/components/AgentsPane";
import { registerPane } from "@/workspace/registry";
import type { WorkspacePaneProps } from "@/workspace/types";

function AgentsWorkspacePane({ params, api }: WorkspacePaneProps) {
  return (
    <AgentsPane
      sessionId={params.sessionId}
      onClose={() => api.close()}
      className="h-full w-full border-l-0"
    />
  );
}

registerPane({ kind: "agents", title: "Agents", icon: UsersIcon, component: AgentsWorkspacePane });
