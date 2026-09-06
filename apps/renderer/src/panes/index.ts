/**
 * Side-effect aggregator (SPEC R16, `workspace/registry.ts`'s own doc
 * comment: "importing that module ... is what actually runs every pane's
 * registration side effect"). `WorkspaceHost` does `import "@/panes"` once;
 * every line below is what actually runs each pane module's own
 * `registerPane(...)` call — the pane files themselves own the registration
 * (see `registerPane` at the bottom of e.g. `browser/BrowserPane.tsx`), this
 * file only has to import them so that code executes.
 *
 * Task B3 owns `browser/`, `terminal/`, `tasks/`, `servers/`; every other
 * line is another Phase 5 task's pane, added here as it lands.
 */
import "./browser/BrowserPane";
import "./terminal/TerminalPane";
import "./tasks/TasksPane";
import "./servers/ServersPane";
import "./files/FilesPane";
import "./editor/EditorPane";
import "./diff/DiffPane";
import "./agents/AgentsWorkspacePane";

export { openInBrowserPane, onOpenInBrowserPane } from "./browserBus";
