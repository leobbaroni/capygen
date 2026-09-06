import { afterEach, describe, expect, it } from "vitest";
import {
  __resetPaneRegistryForTests,
  getPaneRegistration,
  listPaneRegistrations,
  registerPane,
} from "./registry";

const Icon = () => null;

afterEach(() => {
  __resetPaneRegistryForTests();
});

describe("pane registry", () => {
  it("returns undefined for a kind nobody registered", () => {
    expect(getPaneRegistration("terminal")).toBeUndefined();
    expect(listPaneRegistrations()).toEqual([]);
  });

  it("returns a registered pane by kind", () => {
    registerPane({ kind: "files", title: "Files", icon: Icon, component: () => null });
    expect(getPaneRegistration("files")?.title).toBe("Files");
  });

  it("lists registrations in PANE_KINDS order regardless of registration order", () => {
    registerPane({ kind: "agents", title: "Agents", icon: Icon, component: () => null });
    registerPane({ kind: "files", title: "Files", icon: Icon, component: () => null });
    // PANE_KINDS = files, editor, diff, browser, terminal, agents, tasks, servers
    expect(listPaneRegistrations().map((r) => r.kind)).toEqual(["files", "agents"]);
  });

  it("a later registration for the same kind replaces the earlier one", () => {
    registerPane({ kind: "files", title: "Files v1", icon: Icon, component: () => null });
    registerPane({ kind: "files", title: "Files v2", icon: Icon, component: () => null });
    expect(getPaneRegistration("files")?.title).toBe("Files v2");
    expect(listPaneRegistrations()).toHaveLength(1);
  });
});
