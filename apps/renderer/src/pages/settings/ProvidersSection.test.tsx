/**
 * Settings ▸ API keys (SPEC item 5): `secrets.*` IPC mocked, so the page's own
 * has/set/remove wiring is what's under test, not `safeStorage` (that's
 * `apps/desktop/src/ipc/secrets.ts`'s own unit tests).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersSection } from "./ProvidersSection";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === "secrets.has") return Promise.resolve({ has: false, source: "none" });
    return Promise.resolve({ ok: true });
  });
});

describe("ProvidersSection", () => {
  it("lists all three providers and asks secrets.has for each on mount", async () => {
    render(<ProvidersSection />);
    await waitFor(() => expect(screen.getAllByTestId("provider-status-unset")).toHaveLength(3));
    expect(invoke).toHaveBeenCalledWith("secrets.has", { provider: "anthropic" });
    expect(invoke).toHaveBeenCalledWith("secrets.has", { provider: "openai" });
    expect(invoke).toHaveBeenCalledWith("secrets.has", { provider: "openrouter" });
    expect(screen.getByTestId("provider-row-anthropic")).toHaveTextContent("Anthropic");
  });

  it("shows 'Key set' and offers Remove when secrets.has says true", async () => {
    invoke.mockImplementation((channel: string, args: { provider: string }) => {
      if (channel === "secrets.has") {
        const stored = args.provider === "anthropic";
        return Promise.resolve({ has: stored, source: stored ? "stored" : "none" });
      }
      return Promise.resolve({ ok: true });
    });
    render(<ProvidersSection />);
    await waitFor(() =>
      expect(within(screen.getByTestId("provider-row-anthropic")).getByTestId("provider-status-set")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("provider-anthropic-remove")).toBeInTheDocument();
    // A provider with no key offers no Remove button.
    expect(screen.queryByTestId("provider-openai-remove")).not.toBeInTheDocument();
  });

  it("sets a key: the masked input never shows it back, and it never reaches secrets.set unmasked", async () => {
    const user = userEvent.setup();
    render(<ProvidersSection />);
    await waitFor(() => expect(screen.getAllByTestId("provider-status-unset")).toHaveLength(3));

    await user.click(screen.getByTestId("provider-anthropic-set"));
    const input = screen.getByTestId("provider-anthropic-input");
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, "sk-ant-secret");
    await user.click(screen.getByTestId("provider-anthropic-save"));

    expect(invoke).toHaveBeenCalledWith("secrets.set", { provider: "anthropic", value: "sk-ant-secret" });
    // Saved: the input is gone, and the value never reappears anywhere on the page.
    await waitFor(() => expect(screen.queryByTestId("provider-anthropic-input")).not.toBeInTheDocument());
    expect(screen.queryByText("sk-ant-secret")).not.toBeInTheDocument();
  });

  it("says which environment variable supplies a key rather than 'Not set'", async () => {
    invoke.mockImplementation((channel: string, args: { provider: string }) => {
      if (channel === "secrets.has") {
        const env = args.provider === "anthropic";
        return Promise.resolve({ has: env, source: env ? "environment" : "none" });
      }
      return Promise.resolve({ ok: true });
    });
    render(<ProvidersSection />);
    const row = await waitFor(() => screen.getByTestId("provider-row-anthropic"));
    await waitFor(() =>
      expect(within(row).getByTestId("provider-status-env")).toHaveTextContent(
        "From ANTHROPIC_API_KEY",
      ),
    );
    // An environment key is not ours to delete, so no Remove button.
    expect(screen.queryByTestId("provider-anthropic-remove")).not.toBeInTheDocument();
  });

  it("removes a key via secrets.delete", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string, args: { provider: string }) => {
      if (channel === "secrets.has") {
        const stored = args.provider === "openai";
        return Promise.resolve({ has: stored, source: stored ? "stored" : "none" });
      }
      return Promise.resolve({ ok: true });
    });
    render(<ProvidersSection />);
    await waitFor(() => expect(screen.getByTestId("provider-openai-remove")).toBeInTheDocument());

    await user.click(screen.getByTestId("provider-openai-remove"));
    expect(invoke).toHaveBeenCalledWith("secrets.delete", { provider: "openai" });
  });

  it("shows an error and keeps the field open when saving fails", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "secrets.has") return Promise.resolve({ has: false, source: "none" });
      if (channel === "secrets.set") return Promise.reject(new Error("no OS-level encryption"));
      return Promise.resolve({ ok: true });
    });
    render(<ProvidersSection />);
    await waitFor(() => expect(screen.getAllByTestId("provider-status-unset")).toHaveLength(3));

    await user.click(screen.getByTestId("provider-anthropic-set"));
    await user.type(screen.getByTestId("provider-anthropic-input"), "x");
    await user.click(screen.getByTestId("provider-anthropic-save"));

    expect(await screen.findByRole("alert")).toHaveTextContent("no OS-level encryption");
    expect(screen.getByTestId("provider-anthropic-input")).toBeInTheDocument();
  });
});
