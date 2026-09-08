/**
 * Settings ▸ Members (P16). Covers what the page must get right about a
 * surface that is *not* an account list: the exact payloads it sends, the
 * built-in owner's protections, every refusal main can answer with, and the
 * difference between "no profiles" and "could not ask".
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSchema, type LocalMember, type Session } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { MembersSection } from "./MembersSection";

// Hoisted: `appStore` reads `hasBridge()` at module init, which runs before a
// plain `let` in this file is initialized.
const invoke = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({ bridge: true }));
/** Event listeners the components registered, by channel. */
const listeners = vi.hoisted(() => new Map<string, Array<(payload: unknown) => void>>());
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({
    invoke,
    on: (channel: string, listener: (payload: unknown) => void) => {
      const forChannel = listeners.get(channel) ?? [];
      forChannel.push(listener);
      listeners.set(channel, forChannel);
      return () => {
        const rest = (listeners.get(channel) ?? []).filter((l) => l !== listener);
        listeners.set(channel, rest);
      };
    },
  }),
  hasBridge: () => shell.bridge,
}));

const emit = (payload: { area: string; sessionId: string | null }): void => {
  for (const listener of [...(listeners.get("policy.changed") ?? [])]) listener(payload);
};

const OWNER: LocalMember = {
  id: "mbr_builtin_owner", label: "Owner", role: "owner", builtIn: true, createdAt: 0, updatedAt: 0,
};
const REVIEWER: LocalMember = {
  id: "mbr_reviewer", label: "Reviewer", role: "viewer", builtIn: false, createdAt: 1, updatedAt: 1,
};

/** Electron re-throws a handler rejection behind its own prefix. */
const refusal = (code: string) =>
  Promise.reject(
    new Error(`Error invoking remote method 'capygen:invoke': Error: local policy request refused: ${code}`),
  );

/** Parsed, so a fixture that the IPC contract would reject fails here first. */
const session = (over: Partial<Session> = {}): Session =>
  SessionSchema.parse({
    id: "ses_1", projectId: "prj_1", mode: "solo", leadAgentId: null, title: "Alpha run",
    status: "idle", archived: false, createdAt: 0, updatedAt: 0, ...over,
  });

function setSessions(sessions: Session[]): void {
  useAppStore.setState({ sessions, projects: [], selectedProjectId: null, agents: [] });
}

beforeEach(() => {
  shell.bridge = true;
  listeners.clear();
  setSessions([]);
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === "policy.members.list") return Promise.resolve({ members: [OWNER, REVIEWER] });
    if (channel === "policy.members.create") return Promise.resolve({ member: REVIEWER });
    if (channel === "policy.members.update") return Promise.resolve({ member: REVIEWER });
    if (channel === "policy.members.remove") return Promise.resolve({ removed: true });
    if (channel === "policy.session.subject.get") {
      return Promise.resolve({ subject: { sessionId: "ses_1", member: OWNER, explicit: false } });
    }
    if (channel === "policy.session.subject.assign") {
      return Promise.resolve({ subject: { sessionId: "ses_1", member: REVIEWER, explicit: true } });
    }
    return Promise.resolve({});
  });
});

describe("MembersSection", () => {
  it("says these are execution profiles rather than accounts, in two sentences", async () => {
    render(<MembersSection />);
    const note = await screen.findByTestId("members-identity-note");
    expect(note).toHaveTextContent(/not an account/i);
    expect(note).toHaveTextContent(/nothing to sign in to/i);
    expect(note).toHaveTextContent(/not a verified identity/i);
    // Two sentences, not a paragraph.
    expect((note.textContent ?? "").split(".").filter((part) => part.trim() !== ""))
      .toHaveLength(2);
    // The page denies sign-in in words, and offers no credential control to
    // back the claim up.
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByLabelText(/password|username|email/i)).toBeNull();
  });

  it("does not repeat the heading the settings page already renders", async () => {
    render(<MembersSection />);
    await screen.findByTestId("members-identity-note");
    // `SettingsPage` renders "Members" as the page <h1>; the section adds none.
    expect(screen.queryByRole("heading", { name: "Members" })).toBeNull();
  });

  it("lists each profile with its role and what that role may do", async () => {
    render(<MembersSection />);
    const row = await screen.findByTestId(`member-row-${REVIEWER.id}`);
    expect(within(row).getByTestId(`member-role-${REVIEWER.id}`)).toHaveValue("viewer");
    expect(row).toHaveTextContent(/cannot run a turn or approve/i);
  });

  it("protects the built-in owner from rename, demotion and deletion", async () => {
    render(<MembersSection />);
    const row = await screen.findByTestId(`member-row-${OWNER.id}`);
    expect(within(row).getByTestId(`member-builtin-${OWNER.id}`)).toBeInTheDocument();
    expect(within(row).getByTestId(`member-role-${OWNER.id}`)).toBeDisabled();
    expect(within(row).getByTestId(`member-remove-${OWNER.id}`)).toBeDisabled();
    // No editable name field at all for the built-in profile.
    expect(within(row).queryByTestId(`member-label-${OWNER.id}`)).toBeNull();
    expect(within(row).getByTestId(`member-builtin-note-${OWNER.id}`)).toHaveTextContent(
      /cannot be renamed/i,
    );
  });

  it("creates a profile with exactly the label and role that were entered", async () => {
    const user = userEvent.setup();
    render(<MembersSection />);
    await screen.findByTestId("member-create");

    await user.type(screen.getByTestId("member-create-label"), "  Auditor  ");
    await user.selectOptions(screen.getByTestId("member-create-role"), "editor");
    await user.click(screen.getByTestId("member-create-submit"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.members.create", { label: "Auditor", role: "editor" }),
    );
    // No actor, member id or role claiming authority is ever sent.
    const payload = invoke.mock.calls.find((c) => c[0] === "policy.members.create")?.[1] as object;
    expect(Object.keys(payload).sort()).toEqual(["label", "role"]);
    // The list is re-read rather than patched locally.
    expect(invoke.mock.calls.filter((c) => c[0] === "policy.members.list")).toHaveLength(2);
  });

  it("refuses to submit a blank profile name", async () => {
    const user = userEvent.setup();
    render(<MembersSection />);
    await screen.findByTestId("member-create");
    await user.type(screen.getByTestId("member-create-label"), "   ");
    expect(screen.getByTestId("member-create-submit")).toBeDisabled();
    expect(invoke.mock.calls.some((c) => c[0] === "policy.members.create")).toBe(false);
  });

  it("edits a name as a draft and saves it once, not per keystroke", async () => {
    const user = userEvent.setup();
    render(<MembersSection />);
    const input = await screen.findByTestId(`member-label-${REVIEWER.id}`);

    await user.clear(input);
    await user.type(input, "Auditor");
    // Eight interactions, still nothing written.
    expect(invoke.mock.calls.some((c) => c[0] === "policy.members.update")).toBe(false);
    expect(input).toHaveValue("Auditor");

    await user.click(screen.getByTestId(`member-label-save-${REVIEWER.id}`));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.members.update", {
        memberId: REVIEWER.id,
        label: "Auditor",
      }),
    );
    expect(invoke.mock.calls.filter((c) => c[0] === "policy.members.update")).toHaveLength(1);
  });

  it("keeps what is being typed when a reload lands mid-edit", async () => {
    const user = userEvent.setup();
    const update: { release: (() => void) | null } = { release: null };
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.members.list") return Promise.resolve({ members: [OWNER, REVIEWER] });
      if (channel === "policy.members.update") {
        return new Promise((resolve) => { update.release = () => resolve({ member: REVIEWER }); });
      }
      return Promise.resolve({});
    });
    render(<MembersSection />);
    const input = await screen.findByTestId(`member-label-${REVIEWER.id}`);
    await user.clear(input);
    await user.type(input, "Auditor");
    await user.click(screen.getByTestId(`member-label-save-${REVIEWER.id}`));

    // The write is still in flight; the field must not snap back to "Reviewer".
    expect(input).toHaveValue("Auditor");
    update.release?.();
    await waitFor(() => expect(input).not.toBeDisabled());
  });

  it("keeps the draft editable when the rename is refused", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.members.list") return Promise.resolve({ members: [OWNER, REVIEWER] });
      if (channel === "policy.members.update") return refusal("invalid-request");
      return Promise.resolve({});
    });
    render(<MembersSection />);
    const input = await screen.findByTestId(`member-label-${REVIEWER.id}`);
    await user.clear(input);
    await user.type(input, "Auditor");
    await user.click(screen.getByTestId(`member-label-save-${REVIEWER.id}`));

    expect(await screen.findByTestId(`member-error-${REVIEWER.id}`)).toHaveTextContent(/not valid/i);
    // The typing survives the refusal so it can be corrected, not retyped.
    expect(input).toHaveValue("Auditor");
  });

  it("saves a name on Enter and abandons it on Escape", async () => {
    const user = userEvent.setup();
    render(<MembersSection />);
    const input = await screen.findByTestId(`member-label-${REVIEWER.id}`);

    await user.clear(input);
    await user.type(input, "Auditor{Escape}");
    expect(input).toHaveValue(REVIEWER.label);
    expect(invoke.mock.calls.some((c) => c[0] === "policy.members.update")).toBe(false);

    await user.clear(input);
    await user.type(input, "Auditor{Enter}");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.members.update", {
        memberId: REVIEWER.id,
        label: "Auditor",
      }),
    );
  });

  it("writes nothing when the name is unchanged", async () => {
    const user = userEvent.setup();
    render(<MembersSection />);
    const input = await screen.findByTestId(`member-label-${REVIEWER.id}`);
    await user.click(input);
    await user.tab();
    expect(invoke.mock.calls.some((c) => c[0] === "policy.members.update")).toBe(false);
  });

  it("explains an unexpected failure without repeating its raw text", async () => {
    invoke.mockImplementation((channel: string) =>
      channel === "policy.members.list"
        ? Promise.reject(new Error("SQLITE_CANTOPEN: unable to open C:/Users/tuga/AppData/capygen.db"))
        : Promise.resolve({}),
    );
    render(<MembersSection />);
    const error = await screen.findByTestId("section-error");
    expect(error).toHaveTextContent(/Something went wrong reading the local policy service/i);
    expect(error).not.toHaveTextContent(/SQLITE_CANTOPEN|AppData/);
  });

  it("sends a role change as a patch on that profile", async () => {
    const user = userEvent.setup();
    render(<MembersSection />);
    await screen.findByTestId(`member-role-${REVIEWER.id}`);
    await user.selectOptions(screen.getByTestId(`member-role-${REVIEWER.id}`), "editor");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.members.update", {
        memberId: REVIEWER.id,
        role: "editor",
      }),
    );
  });

  it("shows the refusal when a profile is still assigned, and keeps the row", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.members.list") return Promise.resolve({ members: [OWNER, REVIEWER] });
      if (channel === "policy.members.remove") return refusal("member-assigned");
      return Promise.resolve({});
    });
    render(<MembersSection />);
    await user.click(await screen.findByTestId(`member-remove-${REVIEWER.id}`));

    const error = await screen.findByTestId(`member-error-${REVIEWER.id}`);
    expect(error).toHaveTextContent(/still assigned to one or more sessions/i);
    // The refusal never leaks the raw wire text.
    expect(error).not.toHaveTextContent(/local policy request refused/i);
    expect(screen.getByTestId(`member-row-${REVIEWER.id}`)).toBeInTheDocument();
  });

  it("says the service is unavailable instead of showing an empty list", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(() => refusal("unavailable"));
    render(<MembersSection />);

    const note = await screen.findByTestId("members-unavailable");
    expect(note).toHaveTextContent(/not an empty list/i);
    expect(screen.queryByTestId("members-empty")).toBeNull();
    expect(screen.queryByTestId("member-create")).toBeNull();

    invoke.mockImplementation(() => Promise.resolve({ members: [OWNER] }));
    await user.click(screen.getByTestId("members-unavailable-retry"));
    expect(await screen.findByTestId(`member-row-${OWNER.id}`)).toBeInTheDocument();
  });

  it("reports unavailable outside the Electron shell without inventing a result", async () => {
    shell.bridge = false;
    render(<MembersSection />);
    expect(await screen.findByTestId("members-unavailable")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("MembersSection ▸ session assignment", () => {
  it("shows the built-in owner for a session that never chose a profile", async () => {
    const user = userEvent.setup();
    setSessions([session()]);
    render(<MembersSection />);
    await user.selectOptions(await screen.findByTestId("member-assignment-session"), "ses_1");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.session.subject.get", { sessionId: "ses_1" }),
    );
    expect(await screen.findByTestId("member-assignment-current-row")).toHaveTextContent(
      /runs as the built-in owner/i,
    );
    expect(screen.getByTestId("member-assignment-member")).toHaveValue(OWNER.id);
  });

  it("assigns a profile and re-reads the subject rather than assuming it stuck", async () => {
    const user = userEvent.setup();
    setSessions([session()]);
    render(<MembersSection />);
    await user.selectOptions(await screen.findByTestId("member-assignment-session"), "ses_1");
    await screen.findByTestId("member-assignment-member");

    await user.selectOptions(screen.getByTestId("member-assignment-member"), REVIEWER.id);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.session.subject.assign", {
        sessionId: "ses_1",
        memberId: REVIEWER.id,
      }),
    );
    expect(invoke.mock.calls.filter((c) => c[0] === "policy.session.subject.get").length)
      .toBeGreaterThanOrEqual(2);
  });

  it("surfaces a busy-session refusal and leaves the shown profile unchanged", async () => {
    const user = userEvent.setup();
    setSessions([session()]);
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.members.list") return Promise.resolve({ members: [OWNER, REVIEWER] });
      if (channel === "policy.session.subject.get") {
        return Promise.resolve({ subject: { sessionId: "ses_1", member: OWNER, explicit: false } });
      }
      if (channel === "policy.session.subject.assign") return refusal("session-busy");
      return Promise.resolve({});
    });
    render(<MembersSection />);
    await user.selectOptions(await screen.findByTestId("member-assignment-session"), "ses_1");
    await user.selectOptions(await screen.findByTestId("member-assignment-member"), REVIEWER.id);

    expect(await screen.findByTestId("member-assignment-refusal")).toHaveTextContent(
      /Finish or stop the current turn/i,
    );
    // The control fell back to what main still reports, not the failed pick.
    await waitFor(() => expect(screen.getByTestId("member-assignment-member")).toHaveValue(OWNER.id));
  });

  it("surfaces a read-only artifact refusal", async () => {
    const user = userEvent.setup();
    setSessions([session()]);
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.members.list") return Promise.resolve({ members: [OWNER, REVIEWER] });
      if (channel === "policy.session.subject.get") {
        return Promise.resolve({ subject: { sessionId: "ses_1", member: OWNER, explicit: false } });
      }
      if (channel === "policy.session.subject.assign") return refusal("read-only-artifact");
      return Promise.resolve({});
    });
    render(<MembersSection />);
    await user.selectOptions(await screen.findByTestId("member-assignment-session"), "ses_1");
    await user.selectOptions(await screen.findByTestId("member-assignment-member"), REVIEWER.id);

    expect(await screen.findByTestId("member-assignment-refusal")).toHaveTextContent(
      /read-only imported artifact/i,
    );
  });

  it("shows a missing assigned profile as a refusal, never as the owner", async () => {
    const user = userEvent.setup();
    setSessions([session()]);
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.members.list") return Promise.resolve({ members: [OWNER, REVIEWER] });
      if (channel === "policy.session.subject.get") return Promise.resolve({ subject: null });
      return Promise.resolve({});
    });
    render(<MembersSection />);
    await user.selectOptions(await screen.findByTestId("member-assignment-session"), "ses_1");

    expect(await screen.findByTestId("member-assignment-missing")).toHaveTextContent(
      /no longer exists, so it cannot run/i,
    );
    expect(screen.getByTestId("member-assignment-member")).toHaveValue("");
  });

  it("says there is nothing to assign when the app has no sessions", async () => {
    render(<MembersSection />);
    expect(await screen.findByTestId("member-assignment-empty")).toHaveTextContent(/No sessions yet/i);
  });
});

describe("MembersSection ▸ another window changed something", () => {
  it("re-reads the profile list when members or subjects change", async () => {
    const { act } = await import("@testing-library/react");
    render(<MembersSection />);
    await screen.findByTestId(`member-row-${REVIEWER.id}`);
    const before = invoke.mock.calls.filter((c) => c[0] === "policy.members.list").length;

    await act(async () => { emit({ area: "members", sessionId: null }); });
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === "policy.members.list").length)
        .toBeGreaterThan(before),
    );
  });

  it("ignores an area this view does not depend on", async () => {
    const { act } = await import("@testing-library/react");
    render(<MembersSection />);
    await screen.findByTestId(`member-row-${REVIEWER.id}`);
    const before = invoke.mock.calls.filter((c) => c[0] === "policy.members.list").length;

    await act(async () => { emit({ area: "grants", sessionId: null }); });
    expect(invoke.mock.calls.filter((c) => c[0] === "policy.members.list").length).toBe(before);
  });

  it("re-reads a session's subject only for that session", async () => {
    const user = userEvent.setup();
    const { act } = await import("@testing-library/react");
    setSessions([session()]);
    render(<MembersSection />);
    await user.selectOptions(await screen.findByTestId("member-assignment-session"), "ses_1");
    await screen.findByTestId("member-assignment-member");
    const before = invoke.mock.calls.filter((c) => c[0] === "policy.session.subject.get").length;

    await act(async () => { emit({ area: "subjects", sessionId: "ses_other" }); });
    expect(invoke.mock.calls.filter((c) => c[0] === "policy.session.subject.get").length).toBe(before);

    await act(async () => { emit({ area: "subjects", sessionId: "ses_1" }); });
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === "policy.session.subject.get").length)
        .toBeGreaterThan(before),
    );
  });

  it("treats a change with no session as touching every read in its area", async () => {
    const user = userEvent.setup();
    const { act } = await import("@testing-library/react");
    setSessions([session()]);
    render(<MembersSection />);
    await user.selectOptions(await screen.findByTestId("member-assignment-session"), "ses_1");
    await screen.findByTestId("member-assignment-member");
    const before = invoke.mock.calls.filter((c) => c[0] === "policy.session.subject.get").length;

    await act(async () => { emit({ area: "subjects", sessionId: null }); });
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === "policy.session.subject.get").length)
        .toBeGreaterThan(before),
    );
  });

  it("stops listening once the view is gone", async () => {
    const { unmount } = render(<MembersSection />);
    await screen.findByTestId(`member-row-${REVIEWER.id}`);
    expect(listeners.get("policy.changed")?.length ?? 0).toBeGreaterThan(0);
    unmount();
    expect(listeners.get("policy.changed")?.length ?? 0).toBe(0);
  });
});
