/**
 * Wraps the existing `AgentsPane` (SPEC R13, Phase 4) as a dockview panel —
 * the whole of item B2.5. `AgentsPane` itself is untouched (its own tests,
 * `AgentsPane.test.tsx`, import and exercise it directly and stay green
 * unmodified); this file only adapts its `onClose` prop to the dockview
 * panel's own `api.close()` so the pane's internal header X button still
 * does something sensible when it is a dockview tab instead of `ChatPage`'s
 * old fixed-width aside.
 *
 * `AgentsPane` keeps its historical `w-72` (288px) width rather than
 * stretching to fill the panel — a deliberate scope cut: it is a fully
 * working, already-tested component, and re-laying it out to fill an
 * arbitrary panel width was not worth risking its passing test suite for.
 * `WorkspaceHost`'s minimum width (300px) stays just wide enough that this
 * never clips.
 */
import { UsersIcon } from "lucide-react";
import { AgentsPane } from "@/components/AgentsPane";
import { registerPane } from "@/workspace/registry";
import type { WorkspacePaneProps } from "@/workspace/types";

function AgentsWorkspacePane({ params, api }: WorkspacePaneProps) {
  return <AgentsPane sessionId={params.sessionId} onClose={() => api.close()} />;
}

registerPane({ kind: "agents", title: "Agents", icon: UsersIcon, component: AgentsWorkspacePane });
