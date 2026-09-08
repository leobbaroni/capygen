import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { expect, it, vi, beforeEach } from "vitest";
import { AutomationsPage } from "./AutomationsPage";

let automations: unknown[] = [];
const listeners = new Map<string, (payload: unknown) => void>();
const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === "projects.list") return [{ id: "p1", name: "Demo", path: "C:/demo", createdAt: 1, updatedAt: 1, layout: null, devServers: null }];
  if (channel === "sessions.list") return [{ id: "s1", projectId: "p1", title: "Source", mode: "solo", leadAgentId: "a1", status: "idle", settings: { hopCap: 3, parallelAgents: false }, createdAt: 1, updatedAt: 1, archived: false }];
  if (channel === "agents.list") return [{ id: "a1", sessionId: "s1", name: "Claude", displayName: "Claude", mentionName: "claude", backend: "claude", model: "sonnet", role: "lead", order: 0, config: null, createdAt: 1 }];
  if (channel === "automations.list") return automations;
  if (channel === "automations.create") return {};
  return [];
});
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke, on: (channel: string, listener: (payload: unknown) => void) => { listeners.set(channel, listener); return () => listeners.delete(channel); } }) }));

beforeEach(() => { invoke.mockClear(); automations = []; listeners.clear(); });

it("creates an automation using the selected existing project agent and schedule", async () => {
  const user = userEvent.setup();
  render(<AutomationsPage />);
  await waitFor(() => expect(screen.getByText("No automations yet.")).toBeTruthy());
  await user.click(screen.getByRole("button", { name: "New automation" }));
  await user.click(screen.getByLabelText("Name"));
  await user.paste("Morning check");
  await user.click(screen.getByLabelText("Prompt"));
  await user.paste("Review the open work");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("automations.create", expect.objectContaining({ name: "Morning check", prompt: "Review the open work", projectId: "p1", agentId: "a1", rrule: "FREQ=DAILY;INTERVAL=1", timeZone: expect.any(String), scheduleAnchorAt: expect.any(Number) })));
});

it("waits for choices before enabling creation", async () => {
  render(<AutomationsPage />);
  expect((screen.getByRole("button", { name: "New automation" }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect((screen.getByRole("button", { name: "New automation" }) as HTMLButtonElement).disabled).toBe(false));
});

it("keeps edit project and schedule identity, and updates an open run history", async () => {
  const user = userEvent.setup();
  const automation = { id: "aut", projectId: "p1", agentId: "a1", name: "Existing", prompt: "Check", rrule: "FREQ=DAILY;INTERVAL=1", timeZone: "America/New_York", scheduleAnchorAt: 1000, enabled: true, nextRunAt: 2000, lastRunStatus: null };
  automations = [automation];
  render(<MemoryRouter><AutomationsPage /></MemoryRouter>);
  await screen.findByRole("button", { name: "Edit" });
  await user.click(screen.getByRole("button", { name: "Edit" }));
  expect((screen.getByLabelText("Project") as HTMLSelectElement).disabled).toBe(true);
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "Renamed");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(invoke).toHaveBeenCalledWith("automations.update", expect.objectContaining({ id: "aut", patch: expect.objectContaining({ timeZone: "America/New_York", scheduleAnchorAt: 1000, name: "Renamed" }) }));
  await user.click(screen.getByRole("button", { name: "Run history" }));
  await screen.findByText("No runs yet.");
  act(() => listeners.get("automationRun.changed")?.({ id: "run", automationId: "aut", status: "succeeded", firedAt: 3000, sessionId: "s1" }));
  await screen.findByText("succeeded");
  await user.click(screen.getByRole("button", { name: "Hide run history" }));
  expect(screen.queryByText("succeeded")).toBeNull();
});
