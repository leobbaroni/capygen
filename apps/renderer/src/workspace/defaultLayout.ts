/**
 * The layout a project opens with the first time it has no saved
 * `WorkspaceLayout` row (`layout.get` returned `null`) — or when a saved one
 * fails to load (an unknown pane kind from a future version, corrupt JSON).
 *
 * Mirrors the reference workspace rail's own default (CLAUDE.md's Design
 * Reference brief): Files and Agents as tabs in one group, Agents active —
 * `ChatPage`'s old "Agents" toggle opened straight onto the roster, and this
 * keeps that first impression while the tab strip also offers Files.
 */
import type { DockviewApi } from "dockview-react";
import { getPaneRegistration } from "./registry";
import type { WorkspacePaneParams } from "./types";

export function buildDefaultLayout(api: DockviewApi, params: WorkspacePaneParams): void {
  const files = getPaneRegistration("files");
  const agents = getPaneRegistration("agents");

  if (files) {
    api.addPanel({ id: "files", component: "files", title: files.title, params });
  }
  if (agents) {
    api.addPanel({
      id: "agents",
      component: "agents",
      title: agents.title,
      params,
      position: files ? { referencePanel: "files", direction: "within" } : undefined,
    });
  }
  // Agents is the pane a plain click on the old toggle used to show —
  // keep that the active tab rather than whichever `addPanel` left focused.
  api.getPanel("agents")?.api.setActive();
}
