import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { useAppStore } from "@/store/appStore";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke }), hasBridge: () => true }));
beforeEach(() => {
  useAppStore.setState({ listening: false });
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === "dictation.availability") return Promise.resolve({ available: true, languages: ["en-GB"], message: null });
    if (channel === "dictation.cancel") return Promise.resolve({ ok: true });
    return Promise.resolve({ text: "Run the tests", error: null, cancelled: false });
  });
});

describe("composer local dictation", () => {
  it("shows the installed language before recording and appends the phrase without sending", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getByLabelText("Dictation language")).toHaveValue("en-GB"));
    expect(invoke).not.toHaveBeenCalledWith("dictation.recognize", expect.anything());
    await user.type(screen.getByLabelText("Message"), "Please:");
    await user.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("Please: Run the tests"));
    expect(invoke).toHaveBeenCalledWith("dictation.recognize", { requestId: expect.any(String), language: "en-GB" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(useAppStore.getState().listening).toBe(false);
  });

  it("cancels by recording identity and drops a late transcript", async () => {
    let resolve!: (result: unknown) => void;
    invoke.mockImplementation((channel: string) => {
      if (channel === "dictation.availability") return Promise.resolve({ available: true, languages: ["en-GB"], message: null });
      if (channel === "dictation.recognize") return new Promise(done => { resolve = done; });
      return Promise.resolve({ ok: true });
    });
    const user = userEvent.setup();
    render(<Composer onSubmit={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Dictate" }));
    expect(useAppStore.getState().listening).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel dictation" }));
    const args = invoke.mock.calls.find(call => call[0] === "dictation.recognize")?.[1];
    expect(invoke).toHaveBeenCalledWith("dictation.cancel", { requestId: args.requestId });
    await act(async () => { resolve({ text: "late text", error: null, cancelled: false }); });
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(useAppStore.getState().listening).toBe(false);
  });
});
