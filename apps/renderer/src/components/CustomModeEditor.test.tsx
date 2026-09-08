import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CustomModeDocumentSchema } from "@capygen/shared";
import { CustomModeEditor } from "./CustomModeEditor";

const crew = CustomModeDocumentSchema.parse({ version: 1, title: "Original", description: "Keep this", defaultWorker: "worker",
  roster: [
    { id: "lead", label: "Lead", role: "lead", roleLabel: "Architect", instructions: "Think carefully", target: { backend: "codex", model: "fixture", effort: "low" } },
    { id: "worker", label: "Worker", role: "worker", target: { backend: "codex", model: "fixture", effort: "low" } },
  ], routing: [{ id: "first", taskKinds: ["design"], target: "worker" }, { id: "fallback", target: "worker" }] });
const invoke = vi.fn(async (channel: string, _args: unknown) => {
  if (channel === "customMode.capabilities") return [{ backend: "codex", label: "Codex", available: true, defaultModel: "fixture", models: [{ id: "fixture", label: "Fixture", efforts: ["low"] }] }];
  if (channel === "sessions.get") return { session: { settings: { crew } }, agents: [] };
  throw new Error("Session has an unanswered permission");
});
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke }) }));

it("preserves the complete document across visual and JSON edits, ordered rules and failed Apply", async () => {
  render(<CustomModeEditor sessionId="session-fixture" />);
  await screen.findByDisplayValue("Original");
  fireEvent.change(screen.getByLabelText("Crew title"), { target: { value: "Edited" } });
  fireEvent.click(screen.getByRole("button", { name: "Move rule 2 up" }));
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  const expected = { ...crew, title: "Edited", routing: [...crew.routing].reverse() };
  expect(JSON.parse((screen.getByLabelText("Crew JSON") as HTMLTextAreaElement).value)).toEqual(expected);
  fireEvent.change(screen.getByLabelText("Crew JSON"), { target: { value: JSON.stringify({ ...expected, description: "JSON edit" }) } });
  fireEvent.click(screen.getByRole("button", { name: "Visual" }));
  expect(screen.getByLabelText("Description")).toHaveValue("JSON edit");
  fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply crew" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unanswered permission"));
  expect(invoke).toHaveBeenCalledWith("customMode.apply", { sessionId: "session-fixture", crew: { ...expected, description: "JSON edit" } });
  expect(screen.getByLabelText("Person 1 instructions")).toHaveValue("Think carefully");
  expect(screen.getByLabelText("Crew title")).toHaveValue("Edited");
});
