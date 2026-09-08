/**
 * The received-bundle reader (P15, item B).
 *
 * The cases that matter are the ones where a plausible reader would be wrong:
 * asking the *native* import channels for a shared bundle, rendering a sender's
 * text as markup, presenting their claims as verified facts, or offering a
 * continuation this build cannot perform.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareArtifact, ShareComment, ShareEntry } from "@capygen/shared";
import { SharedTranscript } from "./SharedTranscript";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const entry = (index: number, over: Partial<ShareEntry> = {}): ShareEntry =>
  ({
    index, at: null, label: "Assistant", truncated: false,
    kind: "message", speaker: "assistant", text: `Reply ${index}`, ...over,
  }) as ShareEntry;

const ARTIFACT: ShareArtifact = {
  sessionId: "ses_1",
  bundleId: "a".repeat(32),
  contentSha256: "b".repeat(64),
  schemaVersion: 1,
  appVersion: "0.1.0",
  bundleCreatedAt: "2026-09-07T10:00:00Z",
  importedAt: 1,
  source: {
    title: "Refactor the importer", mode: "solo", startedAt: null, endedAt: null,
    agents: [{ label: "Assistant", backend: "claude", model: "claude-opus-5" }],
  },
  counts: {
    entries: 60, messages: 60, thinking: 0, activities: 0, notices: 0,
    truncatedTexts: 0, droppedInteractive: 2, droppedThinking: 5,
    droppedWidgets: 0, droppedUsage: 0, redactions: 3,
  },
  entryCount: 60,
  commentCount: 2,
};

const COMMENTS: ShareComment[] = [
  { id: "c".repeat(32), entryIndex: 0, author: "Reviewer", body: "Looks right",
    createdAt: "2026-09-07T11:00:00Z", replyToId: null, resolved: false },
  { id: "d".repeat(32), entryIndex: null, author: "Reviewer", body: "Whole-session note",
    createdAt: "2026-09-07T11:05:00Z", replyToId: null, resolved: true },
];

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string, args: { offset?: number }) => {
    if (channel === "sharing.get") return Promise.resolve(ARTIFACT);
    if (channel === "sharing.entries") {
      const start = args?.offset ?? 0;
      return Promise.resolve(
        Array.from({ length: Math.min(50, 60 - start) }, (_, i) => entry(start + i)),
      );
    }
    if (channel === "sharing.comments") return Promise.resolve(COMMENTS);
    if (channel === "sharing.notes.list") return Promise.resolve({ notes: [], total: 0 });
    return Promise.resolve(null);
  });
});

describe("SharedTranscript", () => {
  it("reads the sharing channels, never the native import ones", async () => {
    render(<MemoryRouter><SharedTranscript sessionId="ses_1" /></MemoryRouter>);
    await screen.findByTestId("shared-entry-0");

    expect(invoke).toHaveBeenCalledWith("sharing.get", { sessionId: "ses_1" });
    expect(invoke).toHaveBeenCalledWith("sharing.entries", { sessionId: "ses_1", offset: 0, limit: 50 });
    expect(invoke).toHaveBeenCalledWith("sharing.comments", { sessionId: "ses_1", offset: 0, limit: 50 });
    // A shared bundle has no row in the native transcript tables.
    for (const channel of invoke.mock.calls.map((c) => c[0])) {
      expect(String(channel).startsWith("imports.")).toBe(false);
    }
  });

  it("names the artifact as a read-only bundle", async () => {
    render(<MemoryRouter><SharedTranscript sessionId="ses_1" /></MemoryRouter>);
    expect(await screen.findByTestId("shared-badge")).toHaveTextContent("shared bundle");
    expect(screen.getByText("read-only")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Refactor the importer" })).toBeInTheDocument();
  });

  it("presents the sender's labels and tallies as claims, not facts", async () => {
    render(<MemoryRouter><SharedTranscript sessionId="ses_1" /></MemoryRouter>);
    const note = await screen.findByTestId("shared-claim-note");
    expect(note).toHaveTextContent(/written by whoever exported this bundle/i);
    expect(note).toHaveTextContent(/not verified identities/i);

    const omissions = screen.getByTestId("shared-omissions");
    expect(omissions).toHaveTextContent(/5 reasoning/);
    expect(omissions).toHaveTextContent(/2 questions and approvals/);
    expect(omissions).toHaveTextContent(/3 redacted spans/);
    // A tally of what is absent cannot be checked, and the page says so.
    expect(omissions).toHaveTextContent(/cannot check what is not here/i);
  });

  it("renders entry text as text, never as markup", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.get") return Promise.resolve({ ...ARTIFACT, entryCount: 1, counts: { ...ARTIFACT.counts, entries: 1 } });
      if (channel === "sharing.entries") {
        return Promise.resolve([entry(0, { text: "<img src=x onerror=alert(1)><b>bold</b>" })]);
      }
      if (channel === "sharing.comments") return Promise.resolve([]);
      if (channel === "sharing.notes.list") return Promise.resolve({ notes: [], total: 0 });
      return Promise.resolve(null);
    });
    render(<MemoryRouter><SharedTranscript sessionId="ses_1" /></MemoryRouter>);
    const article = await screen.findByTestId("shared-entry-0");
    expect(article).toHaveTextContent("<img src=x onerror=alert(1)><b>bold</b>");
    expect(article.querySelector("img")).toBeNull();
    expect(article.querySelector("b")).toBeNull();
  });

  it("offers continuation as a new session, never as a resume", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><SharedTranscript sessionId="ses_1" /></MemoryRouter>);
    await screen.findByTestId("shared-entry-0");

    // The action's own wording has to carry the distinction, because "Continue"
    // alone reads as "carry on where they left off", which a bundle cannot do.
    const open = screen.getByTestId("shared-continue-open");
    expect(open).toHaveTextContent(/new session/i);
    await user.click(open);
    expect(await screen.findByTestId("shared-continue")).toHaveTextContent(/is not resumed/i);
  });

  it("pages entries against what is actually stored", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><SharedTranscript sessionId="ses_1" /></MemoryRouter>);
    await screen.findByTestId("shared-entry-0");
    expect(screen.getByTestId("shared-range")).toHaveTextContent("1–50 of 60");
    expect(screen.getByTestId("shared-prev")).toBeDisabled();

    await user.click(screen.getByTestId("shared-next"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.entries", { sessionId: "ses_1", offset: 50, limit: 50 }),
    );
    expect(await screen.findByTestId("shared-range")).toHaveTextContent("51–60 of 60");
    expect(screen.getByTestId("shared-next")).toBeDisabled();
  });

  it("shows the bundle's comments as unauthenticated labels", async () => {
    render(<MemoryRouter><SharedTranscript sessionId="ses_1" /></MemoryRouter>);
    const comments = await screen.findByTestId("shared-comments");
    expect(comments).toHaveTextContent(/not accounts and were not verified/i);
    expect(screen.getByTestId(`shared-comment-${"c".repeat(32)}`)).toHaveTextContent("Looks right");
    // A whole-session note is anchored to nothing, and says so.
    expect(screen.getByTestId(`shared-comment-${"d".repeat(32)}`)).toHaveTextContent("whole session");
    expect(screen.getByTestId(`shared-comment-${"d".repeat(32)}`)).toHaveTextContent("resolved");
  });

  it("says so when the bundle carries no comments", async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.get") return Promise.resolve({ ...ARTIFACT, commentCount: 0 });
      if (channel === "sharing.entries") return Promise.resolve([entry(0)]);
      if (channel === "sharing.comments") return Promise.resolve([]);
      if (channel === "sharing.notes.list") return Promise.resolve({ notes: [], total: 0 });
      return Promise.resolve(null);
    });
    render(<MemoryRouter><SharedTranscript sessionId="ses_1" /></MemoryRouter>);
    expect(await screen.findByTestId("shared-comments-empty")).toBeInTheDocument();
  });

  it("surfaces a read failure instead of an empty transcript", async () => {
    invoke.mockImplementation(() => Promise.reject(new Error("artifact is gone")));
    render(<MemoryRouter><SharedTranscript sessionId="ses_1" /></MemoryRouter>);
    expect(await screen.findByTestId("shared-error")).toHaveTextContent("artifact is gone");
    expect(screen.queryByTestId("shared-entry-0")).toBeNull();
  });
});

describe("SharedTranscript ▸ a snapshot belongs to its own session", () => {
  it("never shows the previous bundle's title, claims or comments under a new session", async () => {
    const pending: Array<() => void> = [];
    invoke.mockImplementation((channel: string, args: { sessionId?: string }) => {
      if (channel === "sharing.notes.list") return Promise.resolve({ notes: [], total: 0 });
      if (args?.sessionId === "ses_2") {
        // The second session answers slowly; the first must not stand in.
        return new Promise((resolve) => {
          pending.push(() =>
            resolve(
              channel === "sharing.get"
                ? { ...ARTIFACT, sessionId: "ses_2", source: { ...ARTIFACT.source, title: "Second bundle" } }
                : [],
            ),
          );
        });
      }
      if (channel === "sharing.get") return Promise.resolve(ARTIFACT);
      if (channel === "sharing.entries") return Promise.resolve([entry(0)]);
      if (channel === "sharing.comments") return Promise.resolve(COMMENTS);
      return Promise.resolve(null);
    });

    const { rerender } = render(<MemoryRouter><SharedTranscript sessionId="ses_1" /></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Refactor the importer" })).toBeInTheDocument();

    rerender(<MemoryRouter><SharedTranscript sessionId="ses_2" /></MemoryRouter>);
    // Before the new session answers, the old bundle's identity is gone —
    // not left on screen under the new session's name.
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Refactor the importer" })).toBeNull(),
    );
    expect(screen.queryByTestId("shared-omissions")).toBeNull();
    expect(screen.queryByTestId(`shared-comment-${"c".repeat(32)}`)).toBeNull();

    // The reader asks serially, so each release admits the next call.
    for (let i = 0; i < 6 && pending.length > 0; i += 1) {
      pending.shift()?.();
      await waitFor(() => expect(true).toBe(true));
    }
    expect(await screen.findByRole("heading", { name: "Second bundle" })).toBeInTheDocument();
  });

  it("pages the sender's comments rather than showing only the first page", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string, args: { offset?: number }) => {
      if (channel === "sharing.get") return Promise.resolve({ ...ARTIFACT, commentCount: 120 });
      if (channel === "sharing.entries") return Promise.resolve([entry(0)]);
      if (channel === "sharing.notes.list") return Promise.resolve({ notes: [], total: 0 });
      if (channel === "sharing.comments") {
        const at = args?.offset ?? 0;
        return Promise.resolve([{ ...COMMENTS[0]!, id: "c".repeat(32), body: `their note at ${at}` }]);
      }
      return Promise.resolve(null);
    });
    render(<MemoryRouter><SharedTranscript sessionId="ses_1" /></MemoryRouter>);

    expect(await screen.findByTestId("shared-comments-range")).toHaveTextContent("1–50 of 120");
    await user.click(screen.getByTestId("shared-comments-next"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.comments", { sessionId: "ses_1", offset: 50, limit: 50 }),
    );
    expect(await screen.findByText("their note at 50")).toBeInTheDocument();
  });
});
