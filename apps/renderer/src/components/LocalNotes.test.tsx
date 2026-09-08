/**
 * Local notes (P15 item C, renderer).
 *
 * The distinctions worth pinning: a note is this machine's and is labelled as
 * such, the renderer never supplies an author, and replying to the sender's
 * comment goes through the local table rather than editing what they sent.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalNoteDto } from "@capygen/shared";
import { LocalNotes } from "./LocalNotes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => true,
}));

const note = (over: Partial<LocalNoteDto> = {}): LocalNoteDto => ({
  id: "note_1", sessionId: "ses_1", anchor: { kind: "session" },
  authorLabel: "You", body: "my remark", resolved: false,
  replyToId: null, replyToReceivedId: null, createdAt: 1, updatedAt: 1, ...over,
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === "sharing.notes.list") return Promise.resolve({ notes: [note()], total: 1 });
    if (channel === "sharing.notes.create") return Promise.resolve({ note: note({ id: "note_2" }) });
    if (channel === "sharing.notes.update") return Promise.resolve({ note: note({ resolved: true }) });
    if (channel === "sharing.notes.remove") return Promise.resolve({ removed: true });
    return Promise.resolve({});
  });
});

describe("LocalNotes", () => {
  it("says a note stays here and does not change the bundle", async () => {
    render(<LocalNotes sessionId="ses_1" entryCount={5} />);
    const root = await screen.findByTestId("local-notes");
    expect(root).toHaveTextContent(/stay on this machine/i);
    expect(root).toHaveTextContent(/not part of the received bundle/i);
    expect(await screen.findByTestId("local-note-note_1")).toHaveTextContent("yours");
  });

  it("creates a note without ever supplying an author", async () => {
    const user = userEvent.setup();
    render(<LocalNotes sessionId="ses_1" entryCount={5} />);
    await screen.findByTestId("local-notes-draft");

    await user.type(screen.getByTestId("local-notes-draft"), "  a thought  ");
    await user.selectOptions(screen.getByTestId("local-notes-anchor"), "2");
    await user.click(screen.getByTestId("local-notes-add"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.notes.create", {
        sessionId: "ses_1", anchor: { kind: "entry", entryIndex: 2 }, body: "a thought",
      }),
    );
    // The author is main's to decide; a renderer that could name one would make
    // the label a claim rather than a fact about where the note came from.
    const payload = invoke.mock.calls.find((c) => c[0] === "sharing.notes.create")?.[1] as object;
    expect(Object.keys(payload)).not.toContain("authorLabel");
  });

  it("will not submit an empty note", async () => {
    const user = userEvent.setup();
    render(<LocalNotes sessionId="ses_1" entryCount={5} />);
    await user.type(await screen.findByTestId("local-notes-draft"), "   ");
    expect(screen.getByTestId("local-notes-add")).toBeDisabled();
    expect(invoke.mock.calls.some((c) => c[0] === "sharing.notes.create")).toBe(false);
  });

  it("edits, resolves and deletes through the contract", async () => {
    const user = userEvent.setup();
    render(<LocalNotes sessionId="ses_1" entryCount={5} />);
    await user.click(await screen.findByTestId("local-note-edit-open-note_1"));
    await user.clear(screen.getByTestId("local-note-edit-note_1"));
    await user.type(screen.getByTestId("local-note-edit-note_1"), "revised");
    await user.click(screen.getByTestId("local-note-save-note_1"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.notes.update", { noteId: "note_1", body: "revised" }),
    );

    await user.click(screen.getByTestId("local-note-resolve-note_1"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.notes.update", { noteId: "note_1", resolved: true }),
    );

    await user.click(screen.getByTestId("local-note-delete-note_1"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.notes.remove", { noteId: "note_1" }),
    );
  });

  it("replies to the sender's comment as a local note, not by editing theirs", async () => {
    const user = userEvent.setup();
    const onReplyHandled = vi.fn();
    render(
      <LocalNotes
        sessionId="ses_1"
        entryCount={5}
        replyTo={{ receivedId: "e".repeat(32), author: "Reviewer" }}
        onReplyHandled={onReplyHandled}
      />,
    );
    expect(await screen.findByTestId("local-notes-replying")).toHaveTextContent("Reviewer");

    await user.type(screen.getByTestId("local-notes-draft"), "answering you");
    await user.click(screen.getByTestId("local-notes-add"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("sharing.notes.create", {
        sessionId: "ses_1", anchor: { kind: "session" }, body: "answering you",
        replyToReceivedId: "e".repeat(32),
      }),
    );
    // Nothing writes to the sender's own comments.
    expect(invoke.mock.calls.some((c) => String(c[0]).includes("sharing.comments"))).toBe(false);
    expect(onReplyHandled).toHaveBeenCalled();
  });

  it("surfaces a refusal rather than pretending the note was written", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "sharing.notes.list") return Promise.resolve({ notes: [], total: 0 });
      if (channel === "sharing.notes.create") {
        return Promise.reject(new Error("entry 9 is past the end of this artifact"));
      }
      return Promise.resolve({});
    });
    render(<LocalNotes sessionId="ses_1" entryCount={5} />);
    await user.type(await screen.findByTestId("local-notes-draft"), "note");
    await user.click(screen.getByTestId("local-notes-add"));
    expect(await screen.findByTestId("local-notes-error")).toHaveTextContent(/past the end/);
  });
});
