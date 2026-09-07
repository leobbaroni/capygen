import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi, beforeEach } from "vitest";
import { AutomationsPage } from "./AutomationsPage";

const invoke = vi.fn(async (channel: string) => {
  if (channel === "projects.list") return [{ id: "p1", name: "Demo", path: "C:/demo", createdAt: 1, updatedAt: 1, layout: null, devServers: null }];
  if (channel === "sessions.list") return [{ id: "s1", projectId: "p1", title: "Source", mode: "solo", leadAgentId: "a1", status: "idle", settings: { hopCap: 3, parallelAgents: false }, createdAt: 1, updatedAt: 1, archived: false }];
  if (channel === "agents.list") return [{ id: "a1", sessionId: "s1", name: "Claude", displayName: "Claude", mentionName: "claude", backend: "claude", model: "sonnet", role: "lead", order: 0, config: null, createdAt: 1 }];
  if (channel === "automations.list") return [];
  if (channel === "automations.create") return {};
  return [];
});
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke, on: () => () => {} }) }));

beforeEach(() => invoke.mockClear());

it("creates an automation using the selected existing project agent and schedule", async () => {
  const user = userEvent.setup();
  render(<AutomationsPage />);
  await waitFor(() => expect(screen.getByText("No automations yet.")).toBeTruthy());
  await user.click(screen.getByRole("button", { name: "New automation" }));
  await user.type(screen.getByLabelText("Name"), "Morning check");
  await user.type(screen.getByLabelText("Prompt"), "Review the open work");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("automations.create", expect.objectContaining({ projectId: "p1", agentId: "a1", rrule: "FREQ=DAILY;INTERVAL=1", timeZone: expect.any(String), scheduleAnchorAt: expect.any(Number) })));
});
