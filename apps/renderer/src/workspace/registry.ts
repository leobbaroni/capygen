/**
 * The pane registry: how a `PaneKind` becomes a dockview panel.
 *
 * `WorkspaceHost` is the only reader — it turns `listPanes()` into both the
 * dockview `components` map (`kind -> component`) and the toolbar's toggle
 * buttons, in one declared order (`PANE_KINDS`, `@capygen/shared`). A pane
 * package (`panes/files`, `panes/editor`, …) registers itself once, at
 * module load, by calling `registerPane` — the same "own module owns its
 * registration" shape `apps/desktop/src/ipc/handlers.ts` uses for channels.
 *
 * Task B3 (browser/terminal/tasks/servers) registers into this same map from
 * `apps/renderer/src/panes/index.ts` — importing that module (done once, in
 * `WorkspaceHost`) is what actually runs every pane's registration side
 * effect. A kind nobody registered simply has no toolbar button and no
 * dockview `components` entry; `WorkspaceHost` never assumes all eight exist.
 */
import { PANE_KINDS, type PaneKind } from "@capygen/shared";
import type { PaneRegistration } from "./types";

const registry = new Map<PaneKind, PaneRegistration>();

export function registerPane(registration: PaneRegistration): void {
  registry.set(registration.kind, registration);
}

export function getPaneRegistration(kind: PaneKind): PaneRegistration | undefined {
  return registry.get(kind);
}

/** Every registered pane, in `PANE_KINDS`' declared order — a stable order
 *  is what keeps the toolbar's buttons from reshuffling as panes register. */
export function listPaneRegistrations(): PaneRegistration[] {
  return PANE_KINDS.map((kind) => registry.get(kind)).filter(
    (r): r is PaneRegistration => r !== undefined,
  );
}

/** Reset for tests — module-level state would otherwise leak registrations
 *  (and their mocked components) across test files. */
export function __resetPaneRegistryForTests(): void {
  registry.clear();
}
