import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import { useAppStore } from "@/store/appStore";

const invoke = vi.hoisted(() => vi.fn());
const on = vi.hoisted(() => vi.fn(() => vi.fn()));
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke, on }), hasBridge: () => true }));
beforeEach(() => {
  useAppStore.setState({ listening: false });
  invoke.mockReset();
  on.mockClear();
  invoke.mockImplementation((channel: string) => {
    if (channel === "dictation.availability") return Promise.resolve({ available: true, languages: ["en-GB"], message: null });
    if (channel === "dictation.cancel") return Promise.resolve({ ok: true });
    return Promise.resolve({ text: "Run the tests", error: null, cancelled: false });
  });
});

describe("composer local dictation", () => {
  it("offers setup only on click, then refreshes to automatic language detection", async () => {
    let refreshes = 0;
    invoke.mockImplementation((channel: string) => {
      if (channel === "dictation.availability") return Promise.resolve(refreshes++ === 0
        ? { available: false, languages: [], setupAvailable: true, message: "Install local speech" }
        : { available: true, languages: ["auto"], setupAvailable: true, message: null });
      if (channel === "dictation.setup") return Promise.resolve({ ok: true });
      if (channel === "dictation.recognize") return Promise.resolve({ text: "Detected phrase", error: null, cancelled: false });
      return Promise.resolve({ ok: true });
    });
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Install local speech" })).toBeVisible());
    expect(invoke).not.toHaveBeenCalledWith("dictation.setup", {});
    expect(invoke).not.toHaveBeenCalledWith("dictation.recognize", expect.anything());
    await user.click(screen.getByRole("button", { name: "Install local speech" }));
    expect(invoke).toHaveBeenCalledWith("dictation.setup", {});
    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toHaveAttribute("title", "Dictate locally — language detected automatically"));
    await user.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("Detected phrase"));
    expect(invoke).toHaveBeenCalledWith("dictation.recognize", { requestId: expect.any(String), language: "auto" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("exposes en-GB before recording and appends the phrase without sending", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toHaveAttribute("title", "Dictate locally in en-GB"));
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
    const onSubmit = vi.fn();
    render(<Composer onSubmit={onSubmit} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Dictate" }));
    expect(useAppStore.getState().listening).toBe(true);
    const args = invoke.mock.calls.find(call => call[0] === "dictation.recognize")?.[1];
    const progress = (on.mock.calls as unknown as [string, (payload: unknown) => void][]).find(call => call[0] === "dictation.progress")![1];
    act(() => progress({ requestId: "stale-request", state: "transcribing" }));
    expect(useAppStore.getState().listening).toBe(true);
    act(() => progress({ requestId: args.requestId, state: "transcribing" }));
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing locally");
    expect(useAppStore.getState().listening).toBe(false);
    expect(screen.getByRole("button", { name: "Cancel dictation" })).toBeEnabled();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel dictation" }));
    expect(invoke).toHaveBeenCalledWith("dictation.cancel", { requestId: args.requestId });
    await act(async () => { resolve({ text: "late text", error: null, cancelled: false }); });
    expect(screen.getByLabelText("Message")).toHaveValue("");
    act(() => progress({ requestId: args.requestId, state: "transcribing" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(useAppStore.getState().listening).toBe(false);
  });
});
