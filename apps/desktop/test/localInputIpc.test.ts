import { expect, it, vi } from "vitest";
import { createLocalInputHandlers } from "../src/ipc/localInput.js";

it("only cancels the owning recording and forwards its selected language", async () => {
  let resolve!: (value: { text: string; error: null; cancelled: boolean }) => void;
  const recognize = vi.fn(() => new Promise<{ text: string; error: null; cancelled: boolean }>(done => { resolve = done; }));
  const cancel = vi.fn(() => ({ ok: true }));
  const handlers = createLocalInputHandlers({
    dictation: { availability: vi.fn(), recognize, cancel }, terminals: { attach: vi.fn() },
  });
  const pending = handlers["dictation.recognize"]({ requestId: "current", language: "en-GB" });
  expect(recognize).toHaveBeenCalledWith("en-GB");
  expect(handlers["dictation.cancel"]({ requestId: "old" })).toEqual({ ok: false });
  expect(cancel).not.toHaveBeenCalled();
  expect((await handlers["dictation.recognize"]({ requestId: "other", language: "en-US" })).error).toMatch(/already/);
  expect(handlers["dictation.cancel"]({ requestId: "current" })).toEqual({ ok: true });
  resolve({ text: "", error: null, cancelled: true });
  await pending;
});
