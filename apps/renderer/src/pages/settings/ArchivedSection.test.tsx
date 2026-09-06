/**
 * Settings ▸ Archived: seeds `appStore.sessions` directly (real zustand,
 * `setState` — the same pattern `HarnessesSection.test.tsx` uses) and spies
 * on the store's own `setShowArchived`/`archiveSession` rather than mocking
 * IPC, since this section is a thin view over the store, not a new channel.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SESSION_SETTINGS, type Session } from "@capygen/shared";
import { ArchivedSection } from "./ArchivedSection";
import { useAppStore } from "@/store/appStore";

const SESSIONS: Session[] = [
  {
    id: "ses_archived",
    projectId: "proj_1",
    mode: "solo",
    leadAgentId: "agent_1",
    title: "Old refactor",
    status: "idle",
    settings: DEFAULT_SESSION_SETTINGS,
    createdAt: 0,
    updatedAt: 1_700_000_000_000,
    archived: true,
  },
  {
    id: "ses_active",
    projectId: "proj_1",
    mode: "solo",
    leadAgentId: "agent_2",
    title: "Current work",
    status: "idle",
    settings: DEFAULT_SESSION_SETTINGS,
    createdAt: 0,
    updatedAt: 1_700_000_000_000,
    archived: false,
  },
];

beforeEach(() => {
  useAppStore.setState({
    sessions: SESSIONS,
    setShowArchived: vi.fn().mockResolvedValue(undefined),
    archiveSession: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  useAppStore.setState({ sessions: [] });
});

describe("ArchivedSection", () => {
  it("lists only archived sessions", () => {
    render(<ArchivedSection />);
    expect(screen.getByTestId("archived-row-ses_archived")).toHaveTextContent("Old refactor");
    expect(screen.queryByTestId("archived-row-ses_active")).not.toBeInTheDocument();
  });

  it("calls setShowArchived(true) on mount so the store fetches the archived list", () => {
    render(<ArchivedSection />);
    expect(useAppStore.getState().setShowArchived).toHaveBeenCalledWith(true);
  });

  it("Unarchive calls archiveSession(id, false)", async () => {
    const user = userEvent.setup();
    render(<ArchivedSection />);

    await user.click(screen.getByTestId("archived-restore-ses_archived"));

    await waitFor(() => expect(useAppStore.getState().archiveSession).toHaveBeenCalledWith("ses_archived", false));
  });
});
