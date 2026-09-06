/**
 * `/dev/workspace` — fixture project for visual QA and the B2 screenshot
 * evidence (`e2e-out/workspace-files.png`, `e2e-out/workspace-editor.png`).
 *
 * Unlike `DevAgentsPage` (which seeds the zustand store — `AgentsPane` reads
 * from it), the Files/Editor/Diff panes call `ipc()` directly, and `ipc()`
 * throws outright with no bridge (`lib/ipc.ts`: "the renderer must run
 * inside the Electron shell"). This route is loaded in a plain browser tab
 * by the screenshot script, not inside Electron, so there is no real bridge
 * to answer `fs.*`/`git.*`/`layout.*` — a fake one is installed instead,
 * answering with a small in-memory fixture project.
 *
 * The install is a **module-level** side effect, not inside a React effect:
 * it must run before anything calls `ipc()` (which caches its client on
 * first use), and `App.tsx` only imports this module in dev builds, so the
 * whole thing is a no-op — this route does not exist — in production. It is
 * also guarded on `!hasBridge()`, so inside the real Electron shell (where
 * the preload script already set `window.capygen` before any renderer code
 * runs) this never overwrites the real bridge.
 */
import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, IPC_BRIDGE_KEY } from "@capygen/shared";
import { WorkspaceHost } from "@/workspace/WorkspaceHost";
import { hasBridge } from "@/lib/ipc";

const PROJECT_ID = "project-fixture-workspace";
const SESSION_ID = "session-fixture-workspace";

interface FixtureEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
}

const TREE: Record<string, FixtureEntry[]> = {
  "": [
    { path: "src", name: "src", kind: "dir" },
    { path: "package.json", name: "package.json", kind: "file" },
    { path: "README.md", name: "README.md", kind: "file" },
  ],
  src: [
    { path: "src/App.tsx", name: "App.tsx", kind: "file" },
    { path: "src/mascot.ts", name: "mascot.ts", kind: "file" },
    { path: "src/styles.css", name: "styles.css", kind: "file" },
  ],
};

const CONTENTS: Record<string, string> = {
  "package.json": '{\n  "name": "capygen-fixture",\n  "private": true,\n  "version": "1.0.0"\n}\n',
  "README.md": "# capygen fixture\n\nA fixture project for the /dev/workspace screenshot route.\n",
  "src/App.tsx":
    'import { Mascot } from "./mascot";\n\nexport function App() {\n  return <Mascot state="idle" />;\n}\n',
  "src/mascot.ts":
    'export type MascotState = "idle" | "thinking" | "working";\n\nexport function Mascot({ state }: { state: MascotState }) {\n  return state;\n}\n',
  "src/styles.css": ":root {\n  --brand: #ffb703;\n}\n",
};

function installFixtureBridge(): void {
  const bridge = {
    channels: { invoke: [] as string[], events: [] as string[] },
    subscribe: () => () => undefined,
    async invoke(channel: string, payload: Record<string, unknown>): Promise<unknown> {
      switch (channel) {
        // `App.tsx`'s `init()` fires on every route once a bridge exists —
        // real shapes here so that `Promise.all` resolves instead of
        // rejecting on a schema mismatch (this page never reads the store,
        // but a silently-broken `init()` is still confusing noise to debug
        // around later).
        case "settings.get":
          return DEFAULT_SETTINGS;
        case "projects.list":
        case "sessions.list":
        case "chat.listCommands":
        case "harness.list":
          return [];
        case "layout.get":
          return null;
        case "layout.set":
          return { projectId: PROJECT_ID, layoutJson: payload.layoutJson, updatedAt: Date.now() };
        case "fs.list":
          return { entries: TREE[String(payload.dir ?? "")] ?? [], truncated: false };
        case "fs.search": {
          const query = String(payload.query ?? "").toLowerCase();
          const all = Object.values(TREE).flat();
          return { entries: all.filter((e) => e.path.toLowerCase().includes(query)), truncated: false };
        }
        case "fs.read": {
          const path = String(payload.path ?? "");
          const content = CONTENTS[path] ?? "";
          return { path, content, encoding: "utf8", size: content.length, truncated: false, binary: false };
        }
        case "fs.write":
        case "fs.watch":
        case "fs.unwatch":
          return { ok: true };
        case "git.status":
          return {
            branch: "main",
            ahead: 1,
            behind: 0,
            entries: [
              { path: "src/App.tsx", status: "M" },
              { path: "src/new-feature.ts", status: "??" },
            ],
          };
        case "git.diff":
          return [
            {
              path: String(payload.path ?? "src/App.tsx"),
              unified:
                '@@ -1,4 +1,5 @@\n import { Mascot } from "./mascot";\n \n export function App() {\n+  console.log("rendering");\n   return <Mascot state="idle" />;\n }\n',
            },
          ];
        case "git.commit":
          return { ok: true, sha: "abc1234" };
        default:
          return { ok: true };
      }
    },
  };
  (window as unknown as Record<string, unknown>)[IPC_BRIDGE_KEY] = bridge;
}

if (typeof window !== "undefined" && !hasBridge()) {
  installFixtureBridge();
}

export function DevWorkspacePage() {
  // Rendering waits one tick past the module-level bridge install so a
  // hot-reload of just this component (bridge already installed) behaves
  // identically to a cold load.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return null;

  return (
    <div className="flex min-h-0 flex-1" data-testid="dev-workspace-page">
      <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
        Fixture chat column — the workspace to the right is the thing under
        test. Dev-only route, never part of a production build.
      </div>
      <WorkspaceHost projectId={PROJECT_ID} sessionId={SESSION_ID} onClose={() => undefined} />
    </div>
  );
}
