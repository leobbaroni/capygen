/**
 * Open a file in the (singleton) Editor pane, creating it if it is not
 * already docked somewhere. Shared by the Files pane (double-click) and
 * anything else that ends up wanting the same thing (a future Diff pane
 * "open file" action).
 *
 * The Editor pane itself owns multiple *open files* as its own internal tab
 * strip (SPEC item B2.3's "tabs per open file") — there is exactly one
 * dockview panel of kind `editor`, so a second call while one is already
 * open must reach the live component instance rather than create a second
 * panel. A brand-new panel gets the path through `params.initialFilePath`
 * (no race: the component does not exist yet to race against); an
 * already-mounted one gets it through `openFileBus`, which only reaches a
 * *subscribed* listener — i.e. a component already past its mount effect.
 */
import { getPaneRegistration } from "./registry";
import { requestOpenFile } from "./openFileBus";
import type { WorkspacePaneParams } from "./types";
import type { DockviewApi } from "dockview-react";

export function openFileInEditor(
  containerApi: DockviewApi,
  params: WorkspacePaneParams,
  path: string,
): void {
  const existing = containerApi.getPanel("editor");
  if (existing) {
    existing.api.setActive();
    requestOpenFile(path);
    return;
  }
  const editor = getPaneRegistration("editor");
  if (!editor) return;
  containerApi.addPanel({
    id: "editor",
    component: "editor",
    title: editor.title,
    params: { ...params, initialFilePath: path },
  });
}
