/**
 * Settings ▸ Sharing (P15, item A).
 *
 * The interesting failures here are resource- and honesty-shaped: a staged
 * handle left pinned in the worker, a save dialog opened for a format that
 * cannot be written, a sender's claim shown as a fact, or a conflicting bundle
 * offered as importable.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SessionSchema, type ShareEntry, type Session } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { SharingSection } from "./SharingSection";

const invoke = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigate,
}));

const HANDLE = "a".repeat(32);
const IMPORT_HANDLE = "b".repeat(32);

const entry = (index: number): ShareEntry =>
  ({ index, at: null, label: "Assistant", truncated: false,
     kind: "message", speaker: "assistant", text: `Reply ${index}` }) as ShareEntry;

const session = (over: Partial<Session> = {}): Session =>
  SessionSchema.parse({
    id: "ses_1", projectId: "prj_1", mode: "solo", leadAgentId: null, title: "Alpha run",
    status: "idle", archived: false, createdAt: 0, updatedAt: 0, ...over,
  });

const SOURCE = {
  title: "Alpha run", mode: "solo" as const, startedAt: null, endedAt: null,
  agents: [{ label: "Assistant", backend: "claude" as const, model: "claude-opus-5" }],
};
const COUNTS = {
  entries: 60, messages: 60, thinking: 0, activities: 0, notices: 0, truncatedTexts: 0,
  droppedInteractive: 0, droppedThinking: 4, droppedWidgets: 0, droppedUsage: 0, redactions: 0,
};

const exportPreview = (over: Record<string, unknown> = {}) => ({
  handle: HANDLE, sessionId: "ses_1", origin: "live", source: SOURCE, counts: COUNTS,
  omissions: [{ kind: "thinking", count: 4, claimed: true, description: "reasoning withheld" }],
  entryCount: 60, commentCount: 0, includesReasoning: false,
  json: { bytes: 1024, withinLimit: true, limit: 33554432, suggestedFileName: "alpha.json" },
  html: { bytes: 2048, withinLimit: true, limit: 100663296, suggestedFileName: "alpha.html" },
  expiresAt: 9e12, ...over,
});

const importPreview = (over: Record<string, unknown> = {}) => ({
  handle: IMPORT_HANDLE, bundleId: "c".repeat(32), createdAt: "2026-09-07T10:00:00Z",
  appVersion: "0.1.0", source: SOURCE, counts: COUNTS,
  omissions: [{ kind: "redactions", count: 2, claimed: true, description: "spans redacted" }],
  entryCount: 60, commentCount: 1, destinationProjectId: "prj_1", expiresAt: 9e12, ...over,
});

function setStore(projectId: string | null): void {
  useAppStore.setState({
    sessions: [session()],
    projects: projectId === null ? [] : [
      { id: projectId, name: "capygen", path: "C:/dev/capygen", layout: null, devServers: null, createdAt: 0, updatedAt: 0 },
    ],
    selectedProjectId: projectId,
  });
}

const view = () => render(<MemoryRouter><SharingSection /></MemoryRouter>);

beforeEach(() => {
  setStore("prj_1");
  navigate.mockReset();
  invoke.mockReset();
  invoke.mockImplementation((channel: string, args: { offset?: number }) => {
    if (channel === "sharing.export.preview") return Promise.resolve(exportPreview());
    if (channel === "sharing.export.entries" || channel === "sharing.import.entries") {
      const start = args?.offset ?? 0;
      return Promise.resolve(Array.from({ length: Math.min(25, 60 - start) }, (_, i) => entry(start + i)));
    }
    if (channel === "sharing.export.comments" || channel === "sharing.import.comments") {
      return Promise.resolve([]);
    }
    if (channel === "sharing.export.save") {
      return Promise.resolve({ format: "json", fileName: "alpha.json", bytes: 1024 });
    }
    if (channel === "sharing.import.pick") return Promise.resolve(importPreview());
    if (channel === "sharing.import.commit") {
      return Promise.resolve({ session: session({ id: "ses_shared" }), duplicate: false });
    }
    return Promise.resolve({ ok: true });
  });
});

const stageExport = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.selectOptions(await screen.findByTestId("share-export-session"), "ses_1");
  await user.click(screen.getByTestId("share-export-stage"));
  return screen.findByTestId("share-export-preview");
};

describe("SharingSection ▸ export", () => {
  it("stages a snapshot and pages its entries and comments", async () => {
    const user = userEvent.setup();
    view();
    await stageExport(user);

    expect(invoke).toHaveBeenCalledWith("sharing.export.preview", {
      sessionId: "ses_1", includeReasoning: false,
    });
    expect(invoke).toHaveBeenCalledWith("sharing.export.entries", { handle: HANDLE, offset: 0, limit: 25 });
    expect(invoke).toHaveBeenCalledWith("sharing.export.comments", { handle: HANDLE, offset: 0, limit: 25 });

    await user.click(screen.getByTestId("share-export-next"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.export.entries", { handle: HANDLE, offset: 25, limit: 25 }),
    );
    expect(screen.getByTestId("share-export-range")).toHaveTextContent("26–50 of 60");
  });

  it("keeps reasoning out by default and re-stages when it is turned on", async () => {
    const user = userEvent.setup();
    view();
    await stageExport(user);

    await user.click(screen.getByTestId("share-export-reasoning"));
    // The staged snapshot was projected without reasoning, so it no longer
    // answers the question being asked; it is released rather than reused.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.export.cancel", { handle: HANDLE }),
    );
    expect(screen.queryByTestId("share-export-preview")).toBeNull();

    await user.click(screen.getByTestId("share-export-stage"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.export.preview", {
        sessionId: "ses_1", includeReasoning: true,
      }),
    );
  });

  it("reports each format's measured size and saves the chosen one", async () => {
    const user = userEvent.setup();
    view();
    await stageExport(user);

    expect(screen.getByTestId("share-export-size-json")).toHaveTextContent("1.0 KiB of 32.0 MiB");
    await user.click(screen.getByTestId("share-export-save-json"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.export.save", { handle: HANDLE, format: "json" }),
    );
    expect(await screen.findByTestId("share-export-saved")).toHaveTextContent("alpha.json");
  });

  it("refuses an over-limit web page before any dialog, and points at the JSON", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.export.preview") {
        return Promise.resolve(exportPreview({
          html: { bytes: 200000000, withinLimit: false, limit: 100663296, suggestedFileName: "a.html" },
        }));
      }
      if (channel === "sharing.export.entries") return Promise.resolve([entry(0)]);
      if (channel === "sharing.export.comments") return Promise.resolve([]);
      return Promise.resolve({ ok: true });
    });
    view();
    await stageExport(user);

    expect(screen.getByTestId("share-export-save-html")).toBeDisabled();
    expect(screen.getByTestId("share-export-over-html")).toBeInTheDocument();
    const fallback = screen.getByTestId("share-export-html-fallback");
    expect(fallback).toHaveTextContent(/over the/i);
    expect(fallback).toHaveTextContent(/same reviewed content and does fit/i);
    // Nothing was written and no save was attempted.
    expect(invoke.mock.calls.some((c) => c[0] === "sharing.export.save")).toBe(false);
  });

  it("shows the omission tallies as claims", async () => {
    const user = userEvent.setup();
    view();
    await stageExport(user);
    expect(screen.getByTestId("share-export-omissions-thinking")).toHaveTextContent("claimed");
    expect(screen.getByTestId("share-export-omissions-thinking")).toHaveTextContent("reasoning withheld");
  });

  it("releases the handle on discard, on switching session and on unmount", async () => {
    const user = userEvent.setup();
    const { unmount } = view();
    await stageExport(user);

    await user.click(screen.getByTestId("share-export-discard"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.export.cancel", { handle: HANDLE }),
    );

    await stageExport(user);
    await user.selectOptions(screen.getByTestId("share-export-session"), "");
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === "sharing.export.cancel")).toHaveLength(2),
    );

    await stageExport(user);
    unmount();
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === "sharing.export.cancel")).toHaveLength(3),
    );
  });

  it("releases the handle when staging fails part-way", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.export.preview") return Promise.resolve(exportPreview());
      if (channel === "sharing.export.entries") return Promise.reject(new Error("worker gone"));
      if (channel === "sharing.export.comments") return Promise.resolve([]);
      return Promise.resolve({ ok: true });
    });
    view();
    await user.selectOptions(await screen.findByTestId("share-export-session"), "ses_1");
    await user.click(screen.getByTestId("share-export-stage"));

    expect(await screen.findByTestId("share-export-error")).toHaveTextContent("worker gone");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.export.cancel", { handle: HANDLE }),
    );
    expect(screen.queryByTestId("share-export-preview")).toBeNull();
  });

  it("keeps the handle when the save dialog is cancelled", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.export.preview") return Promise.resolve(exportPreview());
      if (channel === "sharing.export.entries") return Promise.resolve([entry(0)]);
      if (channel === "sharing.export.comments") return Promise.resolve([]);
      if (channel === "sharing.export.save") return Promise.resolve(null);
      return Promise.resolve({ ok: true });
    });
    view();
    await stageExport(user);
    await user.click(screen.getByTestId("share-export-save-json"));

    // A cancelled dialog is not a failure: the reviewed snapshot survives so
    // another format can still be written from it.
    await waitFor(() => expect(screen.getByTestId("share-export-preview")).toBeInTheDocument());
    expect(screen.queryByTestId("share-export-saved")).toBeNull();
    expect(invoke.mock.calls.some((c) => c[0] === "sharing.export.cancel")).toBe(false);
  });
});

describe("SharingSection ▸ import", () => {
  it("previews a picked bundle, then commits and opens it", async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByTestId("share-import-pick"));
    await screen.findByTestId("share-import-preview");

    expect(invoke).toHaveBeenCalledWith("sharing.import.pick", { projectId: "prj_1" });
    expect(invoke).toHaveBeenCalledWith("sharing.import.entries", { handle: IMPORT_HANDLE, offset: 0, limit: 25 });
    expect(screen.getByTestId("share-import-claim-note")).toHaveTextContent(/Nothing here has been verified/i);
    expect(screen.getByTestId("share-import-omissions-redactions")).toHaveTextContent("claimed");

    await user.click(screen.getByTestId("share-import-commit"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.import.commit", { handle: IMPORT_HANDLE }),
    );
    expect(navigate).toHaveBeenCalledWith("/c/ses_shared");
    // A consumed handle must not be cancelled afterwards.
    expect(invoke.mock.calls.some((c) => c[0] === "sharing.import.cancel")).toBe(false);
  });

  it("does nothing when the file dialog is cancelled", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) =>
      channel === "sharing.import.pick" ? Promise.resolve(null) : Promise.resolve({ ok: true }));
    view();
    await user.click(await screen.findByTestId("share-import-pick"));
    await waitFor(() => expect(screen.getByTestId("share-import-pick")).not.toBeDisabled());
    expect(screen.queryByTestId("share-import-preview")).toBeNull();
    expect(screen.queryByTestId("share-import-error")).toBeNull();
  });

  it("names an already-imported bundle rather than duplicating it", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.import.pick") {
        return Promise.resolve(importPreview({ existingSessionId: "ses_old" }));
      }
      if (channel === "sharing.import.entries") return Promise.resolve([entry(0)]);
      if (channel === "sharing.import.comments") return Promise.resolve([]);
      return Promise.resolve({ ok: true });
    });
    view();
    await user.click(await screen.findByTestId("share-import-pick"));
    expect(await screen.findByTestId("share-import-duplicate")).toHaveTextContent(/already open here/i);
    expect(screen.getByTestId("share-import-commit")).toHaveTextContent("Open the existing session");
  });

  it("refuses a bundle whose id is taken by different content", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.import.pick") {
        return Promise.resolve(importPreview({ conflictingBundleId: true }));
      }
      if (channel === "sharing.import.entries") return Promise.resolve([entry(0)]);
      if (channel === "sharing.import.comments") return Promise.resolve([]);
      return Promise.resolve({ ok: true });
    });
    view();
    await user.click(await screen.findByTestId("share-import-pick"));
    expect(await screen.findByTestId("share-import-conflict")).toHaveTextContent(/same id must always carry/i);
    expect(screen.getByTestId("share-import-commit")).toBeDisabled();
  });

  it("releases a staged import on discard and on unmount", async () => {
    const user = userEvent.setup();
    const { unmount } = view();
    await user.click(await screen.findByTestId("share-import-pick"));
    await screen.findByTestId("share-import-preview");

    await user.click(screen.getByTestId("share-import-discard"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.import.cancel", { handle: IMPORT_HANDLE }),
    );

    await user.click(screen.getByTestId("share-import-pick"));
    await screen.findByTestId("share-import-preview");
    unmount();
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === "sharing.import.cancel")).toHaveLength(2),
    );
  });

  it("asks for a project before offering to open a file", async () => {
    setStore(null);
    view();
    expect(await screen.findByTestId("share-import-no-project")).toBeInTheDocument();
    expect(screen.queryByTestId("share-import-pick")).toBeNull();
  });
});

describe("SharingSection ▸ one operation at a time", () => {
  it("reads entries and comments serially, never concurrently on one handle", async () => {
    const user = userEvent.setup();
    // Main admits a single operation per handle; a second overlapping read is
    // refused with "already being saved or imported" and the preview is lost.
    // This mock fails exactly the way main does if the page overlaps them.
    let inFlight = 0;
    const order: string[] = [];
    invoke.mockImplementation(async (channel: string, args: { offset?: number }) => {
      if (channel === "sharing.export.preview") return exportPreview();
      if (channel === "sharing.export.entries" || channel === "sharing.export.comments") {
        if (inFlight > 0) throw new Error("this share is already being saved or imported");
        inFlight += 1;
        order.push(channel);
        await Promise.resolve();
        inFlight -= 1;
        return channel === "sharing.export.entries"
          ? [entry(args?.offset ?? 0)]
          : [];
      }
      return { ok: true };
    });

    view();
    await stageExport(user);
    expect(order).toEqual(["sharing.export.entries", "sharing.export.comments"]);
    expect(screen.queryByTestId("share-export-error")).toBeNull();
    expect(screen.getByTestId("share-export-preview")).toBeInTheDocument();
  });

  it("does the same for a picked import", async () => {
    const user = userEvent.setup();
    let inFlight = 0;
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "sharing.import.pick") return importPreview();
      if (channel === "sharing.import.entries" || channel === "sharing.import.comments") {
        if (inFlight > 0) throw new Error("this share is already being saved or imported");
        inFlight += 1;
        await Promise.resolve();
        inFlight -= 1;
        return channel === "sharing.import.entries" ? [entry(0)] : [];
      }
      return { ok: true };
    });

    view();
    await user.click(await screen.findByTestId("share-import-pick"));
    expect(await screen.findByTestId("share-import-preview")).toBeInTheDocument();
    expect(screen.queryByTestId("share-import-error")).toBeNull();
  });
});

describe("SharingSection ▸ a late answer belongs to the generation that asked", () => {
  /** A staging call the case releases by hand. */
  const deferredPreview = () => {
    const gate: { release: ((value: unknown) => void) | null } = { release: null };
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.export.preview") {
        return new Promise((resolve) => { gate.release = resolve; });
      }
      if (channel === "sharing.export.entries") return Promise.resolve([entry(0)]);
      if (channel === "sharing.export.comments") return Promise.resolve([]);
      return Promise.resolve({ ok: true });
    });
    return gate;
  };

  it("releases a snapshot that arrives after the panel is gone", async () => {
    const user = userEvent.setup();
    const gate = deferredPreview();
    const { unmount } = view();
    await user.selectOptions(await screen.findByTestId("share-export-session"), "ses_1");
    await user.click(screen.getByTestId("share-export-stage"));

    unmount();
    gate.release?.(exportPreview());
    // Nothing else will ever hold that handle, so it must not be left pinned.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.export.cancel", { handle: HANDLE }),
    );
  });

  it("releases a snapshot that arrives after the reasoning toggle changed", async () => {
    const user = userEvent.setup();
    const gate = deferredPreview();
    view();
    await user.selectOptions(await screen.findByTestId("share-export-session"), "ses_1");
    await user.click(screen.getByTestId("share-export-stage"));

    // The question changed while the answer was in flight.
    await user.click(screen.getByTestId("share-export-reasoning"));
    gate.release?.(exportPreview());

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.export.cancel", { handle: HANDLE }),
    );
    // And the stale snapshot must not be shown under the new setting.
    expect(screen.queryByTestId("share-export-preview")).toBeNull();
  });

  it("does not let an old page land on a newer snapshot", async () => {
    const user = userEvent.setup();
    const pagers: Array<(value: unknown) => void> = [];
    invoke.mockImplementation((channel: string, args: { offset?: number }) => {
      if (channel === "sharing.export.preview") return Promise.resolve(exportPreview());
      if (channel === "sharing.export.comments") return Promise.resolve([]);
      if (channel === "sharing.export.entries") {
        if ((args?.offset ?? 0) === 0) return Promise.resolve([entry(0)]);
        return new Promise((resolve) => { pagers.push(resolve); });
      }
      return Promise.resolve({ ok: true });
    });
    view();
    await stageExport(user);

    await user.click(screen.getByTestId("share-export-next"));
    // Discard while the page is in flight, then let it answer.
    await user.click(screen.getByTestId("share-export-discard"));
    pagers[0]?.([entry(99)]);

    await waitFor(() => expect(screen.queryByTestId("share-export-preview")).toBeNull());
    expect(screen.queryByTestId("share-export-entry-99")).toBeNull();
  });

  it("releases the handle after a save, since main does not consume it", async () => {
    const user = userEvent.setup();
    view();
    await stageExport(user);
    await user.click(screen.getByTestId("share-export-save-json"));

    await waitFor(() => expect(screen.getByTestId("share-export-saved")).toBeInTheDocument());
    // `sharing.export.save` leaves the reservation in place; forgetting the
    // handle would pin the worker's memory until it expired.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.export.cancel", { handle: HANDLE }),
    );
  });

  it("never cancels a handle a commit consumed", async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByTestId("share-import-pick"));
    await screen.findByTestId("share-import-preview");
    await user.click(screen.getByTestId("share-import-commit"));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/c/ses_shared"));
    expect(invoke.mock.calls.some((c) => c[0] === "sharing.import.cancel")).toBe(false);
  });
});

describe("SharingSection ▸ comments are reachable, not just sampled", () => {
  it("pages comments separately from entries, with an honest total", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string, args: { offset?: number }) => {
      if (channel === "sharing.export.preview") {
        return Promise.resolve(exportPreview({ commentCount: 60 }));
      }
      if (channel === "sharing.export.entries") return Promise.resolve([entry(args?.offset ?? 0)]);
      if (channel === "sharing.export.comments") {
        const at = args?.offset ?? 0;
        return Promise.resolve([{
          id: "c".repeat(32), entryIndex: null, author: "Reviewer",
          body: `note at ${at}`, createdAt: "2026-09-07T11:00:00Z",
          replyToId: null, resolved: false,
        }]);
      }
      return Promise.resolve({ ok: true });
    });
    view();
    await stageExport(user);

    expect(screen.getByTestId("share-export-comments-range")).toHaveTextContent("1–25 of 60");
    await user.click(screen.getByTestId("share-export-comments-next"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.export.comments", {
        handle: HANDLE, offset: 25, limit: 25,
      }),
    );
    expect(await screen.findByText("note at 25")).toBeInTheDocument();
    // Entry paging is untouched by comment paging.
    expect(screen.getByTestId("share-export-range")).toHaveTextContent("1–25 of 60");
  });
});

describe("SharingSection ▸ the panel is usable again after an operation ends", () => {
  it("re-enables Prepare export after a successful save", async () => {
    const user = userEvent.setup();
    view();
    await stageExport(user);
    await user.click(screen.getByTestId("share-export-save-json"));
    await waitFor(() => expect(screen.getByTestId("share-export-saved")).toBeInTheDocument());

    // A save intentionally retires its own snapshot, which used to strand
    // `busy` at true and leave every control on the panel disabled.
    await waitFor(() => expect(screen.getByTestId("share-export-stage")).not.toBeDisabled());
    // And the panel really works again, not merely looks enabled.
    await user.click(screen.getByTestId("share-export-stage"));
    expect(await screen.findByTestId("share-export-preview")).toBeInTheDocument();
  });

  it("re-enables the picker after a successful commit", async () => {
    const user = userEvent.setup();
    view();
    await user.click(await screen.findByTestId("share-import-pick"));
    await screen.findByTestId("share-import-preview");
    await user.click(screen.getByTestId("share-import-commit"));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/c/ses_shared"));

    await waitFor(() => expect(screen.getByTestId("share-import-pick")).not.toBeDisabled());
  });

  it("re-enables after a failed save, not only a successful one", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.export.preview") return Promise.resolve(exportPreview());
      if (channel === "sharing.export.entries") return Promise.resolve([entry(0)]);
      if (channel === "sharing.export.comments") return Promise.resolve([]);
      if (channel === "sharing.export.save") return Promise.reject(new Error("EPERM"));
      return Promise.resolve({ ok: true });
    });
    view();
    await stageExport(user);
    await user.click(screen.getByTestId("share-export-save-json"));

    expect(await screen.findByTestId("share-export-error")).toHaveTextContent("EPERM");
    await waitFor(() => expect(screen.getByTestId("share-export-save-json")).not.toBeDisabled());
  });

  it("does not let a stale completion unlock a newer operation", async () => {
    const user = userEvent.setup();
    const saves: Array<(value: unknown) => void> = [];
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.export.preview") return Promise.resolve(exportPreview());
      if (channel === "sharing.export.entries") return Promise.resolve([entry(0)]);
      if (channel === "sharing.export.comments") return Promise.resolve([]);
      if (channel === "sharing.export.save") {
        return new Promise((resolve) => { saves.push(resolve); });
      }
      return Promise.resolve({ ok: true });
    });
    view();
    await stageExport(user);

    await user.click(screen.getByTestId("share-export-save-json"));
    expect(screen.getByTestId("share-export-save-json")).toBeDisabled();
    // Abandon it, then start a fresh snapshot that takes the lock for itself.
    await user.click(screen.getByTestId("share-export-discard"));
    await user.click(screen.getByTestId("share-export-stage"));
    await screen.findByTestId("share-export-preview");

    // The abandoned save now answers. It must not release a lock it no longer
    // owns, and must not clear the newer operation's state.
    saves[0]?.({ format: "json", fileName: "alpha.json", bytes: 1024 });
    await waitFor(() => expect(screen.getByTestId("share-export-preview")).toBeInTheDocument());
    expect(screen.queryByTestId("share-export-saved")).toBeNull();
  });
});
