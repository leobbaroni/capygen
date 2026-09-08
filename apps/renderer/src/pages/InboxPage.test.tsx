import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { InboxPage } from "./InboxPage";
const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke, on: () => () => {} }) }));
const item = { id: "in_1", kind: "completed", title: "Unread", body: "Done", sessionId: "s1", turnId: "t1", targetBlockId: null, requestId: null, createdAt: 1, readAt: null, resolvedAt: 1 };
beforeEach(() => { let unread = true; invoke.mockReset(); invoke.mockImplementation((channel: string) => {
  if (channel === "inbox.list") return Promise.resolve({ items: unread ? [item] : [], unreadCount: unread ? 1 : 0 });
  unread = false; return Promise.resolve({ ...item, readAt: 2 });
}); });
describe("InboxPage", () => {
  it("shows unread items only and removes an item after marking it read", async () => { const user = userEvent.setup(); render(<MemoryRouter><InboxPage /></MemoryRouter>); expect(await screen.findByText("Unread")).toBeInTheDocument(); await user.click(screen.getByRole("button", { name: "Mark read" })); await waitFor(() => expect(screen.queryByText("Unread")).not.toBeInTheDocument()); expect(invoke).toHaveBeenCalledWith("inbox.markRead", { id: "in_1", read: true }); });
});
