/**
 * Shared shapes between the workspace host and every registered pane
 * (SPEC R16-R17, CONTEXT.md §Pane).
 *
 * A registered pane is a plain React component rendered inside a dockview
 * panel; dockview hands it `{ params, api, containerApi }` (see
 * `IDockviewPanelProps` in `dockview-core`) — `WorkspacePaneProps` is that
 * shape narrowed to the one params bag every capygen pane needs
 * (`projectId`/`sessionId`) plus whatever extra the opener passed
 * (`WorkspaceHost.openPane`'s `params` argument, e.g. the Editor pane's
 * `initialFilePath`).
 */
import type { ComponentType } from "react";
import type { DockviewApi, DockviewPanelApi } from "dockview-react";
import type { PaneKind } from "@capygen/shared";

/** Every capygen pane's params bag carries at least these two; a pane may
 *  read further ad-hoc fields off the same object (never required, since a
 *  restored layout replays only what `toJSON` captured — see each pane's own
 *  `params.<field>` read). */
export interface WorkspacePaneParams {
  projectId: string;
  sessionId: string;
  [key: string]: unknown;
}

export interface WorkspacePaneProps<P extends WorkspacePaneParams = WorkspacePaneParams> {
  params: P;
  api: DockviewPanelApi;
  containerApi: DockviewApi;
}

export interface PaneRegistration {
  kind: PaneKind;
  /** Dockview tab title. */
  title: string;
  icon: ComponentType<{ className?: string }>;
  component: ComponentType<WorkspacePaneProps>;
}
