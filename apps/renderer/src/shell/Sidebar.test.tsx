import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Session } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { Sidebar } from "./Sidebar";

// Deliberately not "capygen": the sidebar header carries the brand wordmark,
// which is the literal text "capygen", so a project of that name would make
// the grouping assertion below ambiguous.
const project: Project = {
  id: "proj-1",
  path: "C:/work/widget-shop",
  name: "widget-shop",
  layout: null,
  devServers: null,
  createdAt: 0,
  updatedAt: 0,
};

function session(overrides: Partial<Session>): Session {
  return {
    id: "s1",
    projectId: project.id,
    mode: "solo",
    leadAgentId: "a1",
    title: "Untitled session",
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    ...overrides,
  };
}

function renderSidebar(sessions: Session[]) {
  return render(
    <MemoryRouter>
      <Sidebar sessions={sessions} activeSessionId={null} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useAppStore.setState({ projects: [project], showArchived: false });
});

describe("Sidebar", () => {
  it("groups sessions under their project's name", () => {
    renderSidebar([session({ id: "s1", title: "First" })]);
    expect(screen.getByText("widget-shop")).toBeInTheDocument();
    expect(screen.getByText("First")).toBeInTheDocument();
  });

  it("carries the brand lockup at the top of the rail", () => {
    renderSidebar([]);
    const brand = screen.getByTestId("sidebar-brand");
    expect(within(brand).getByTestId("brand-logo")).toBeInTheDocument();
    expect(within(brand).getByTestId("brand-wordmark")).toHaveTextContent("capygen");
  });

  it("falls back to a loose-sessions bucket for an unknown project", () => {
    renderSidebar([session({ id: "s2", projectId: "unknown", title: "Orphan" })]);
    expect(screen.getByText("Loose sessions")).toBeInTheDocument();
  });

  it("filters the list by the search box", async () => {
    const user = userEvent.setup();
    renderSidebar([
      session({ id: "s1", title: "Fix the login bug" }),
      session({ id: "s2", title: "Write the changelog" }),
    ]);
    await user.type(screen.getByTestId("sidebar-search"), "login");
    expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
    expect(screen.queryByText("Write the changelog")).not.toBeInTheDocument();
  });

  it("hides archived sessions until 'Show archived' is checked", async () => {
    const user = userEvent.setup();
    const setShowArchived = vi.fn(async (show: boolean) => {
      useAppStore.setState({ showArchived: show });
    });
    useAppStore.setState({ setShowArchived });
    renderSidebar([session({ id: "s1", title: "Active" }), session({ id: "s2", title: "Old", archived: true })]);

    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByText("Old")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("sidebar-show-archived"));
    expect(setShowArchived).toHaveBeenCalledWith(true);
  });

  it("archives a session through the row's archive button", async () => {
    const user = userEvent.setup();
    const archiveSession = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ archiveSession });
    renderSidebar([session({ id: "s1", title: "Active" })]);

    const row = screen.getByTestId("session-row").closest("li")!;
    await user.click(within(row).getByTestId("session-archive-toggle"));

    expect(archiveSession).toHaveBeenCalledWith("s1", true);
  });
});
