/**
 * [C] Open a URL in the (singleton) Browser pane, creating the panel if it is
 * not docked anywhere yet — the second half of SPEC G6 ("one click starts it
 * … and opens it in the browser pane") and of R18.
 *
 * Exactly the shape `openInEditor.ts` already uses for the Editor pane, and
 * for the same reason: `browserBus` only reaches a *subscribed* listener, so
 * it can talk to a Browser pane that is already mounted but not to one that
 * does not exist yet. A brand-new panel therefore gets the address through
 * `params.initialUrl` (nothing to race against — the component has not been
 * created), and an existing one through the bus.
 *
 * Before this existed, the Servers pane's "Open in Browser pane" button was a
 * no-op whenever the Browser tab happened to be closed, which is the default
 * layout's state — the one case the button is most useful in.
 */
import { getPaneRegistration } from "./registry";
import { openInBrowserPane } from "@/panes/browserBus";
import type { WorkspacePaneParams } from "./types";
import type { DockviewApi } from "dockview-react";

export function openUrlInBrowserPane(
  containerApi: DockviewApi,
  params: WorkspacePaneParams,
  url: string,
): void {
  const existing = containerApi.getPanel("browser");
  if (existing) {
    existing.api.setActive();
    openInBrowserPane(url);
    return;
  }
  const browser = getPaneRegistration("browser");
  if (!browser) return;
  containerApi.addPanel({
    id: "browser",
    component: "browser",
    title: browser.title,
    params: { ...params, initialUrl: url },
  });
}
