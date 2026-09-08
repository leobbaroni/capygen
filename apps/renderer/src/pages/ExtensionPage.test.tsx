import { expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ExtensionPage } from "./ExtensionPage";

let resolveOpen: (value: { instanceId: string }) => void;
const invoke = vi.fn(async (channel: string) => {
  if (channel === "extensions.open") return await new Promise<{ instanceId: string }>((resolve) => { resolveOpen = resolve; });
  return { ok: true };
});
vi.mock("@/lib/ipc", () => ({ ipc: () => ({ invoke }) }));

it("closes an instance that finishes opening after unmount and disposes a reopened view", async () => {
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect = disconnect; });
  const page = () => <MemoryRouter initialEntries={["/extensions/page/example.pkg/example.pkg.page"]}><Routes><Route path="/extensions/page/:extensionId/:pageId" element={<ExtensionPage />} /></Routes></MemoryRouter>;
  const first = render(page());
  expect(screen.getByRole("status")).toHaveTextContent("Opening extension");
  expect(invoke).toHaveBeenCalledWith("extensions.open", expect.objectContaining({ extensionId: "example.pkg", pageId: "example.pkg.page" }));
  first.unmount();
  await act(async () => { resolveOpen({ instanceId: "old" }); });
  expect(invoke).toHaveBeenCalledWith("extensions.close", { instanceId: "old" });
  const second = render(page());
  await act(async () => { resolveOpen({ instanceId: "new" }); });
  await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  second.unmount();
  expect(invoke).toHaveBeenCalledWith("extensions.close", { instanceId: "new" });
  expect(disconnect).toHaveBeenCalledTimes(2);
  vi.unstubAllGlobals();
});
