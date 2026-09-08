/**
 * Settings ▸ Members (P16, ADR-0007 "Local identity boundary").
 *
 * These are **named local execution profiles**, not logins. capygen is a
 * single-Windows-user application; nothing here authenticates a person, and a
 * label is an unauthenticated display string. The page says so at the top and
 * never uses sign-in vocabulary — the header line is the interface's part of
 * that contract, not decoration.
 *
 * What a profile decides is what a session may *do*: a viewer inspects history
 * but cannot dispatch a turn or answer a tool approval, an editor dispatches
 * and answers ordinary approvals under the current restrictions, and an owner
 * additionally manages restrictions and grants. Main resolves that from the
 * persisted assignment; this page only edits the assignment, and every refusal
 * main returns is shown where the control that asked for it is.
 */
import { useMemo, useState } from "react";
import { InfoIcon, ShieldIcon } from "lucide-react";
import type { LocalMember, LocalMemberRole } from "@capygen/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ConfigRow,
  RowError,
  SectionError,
  SectionLoading,
  SettingInput,
  SettingSelect,
  SettingsCard,
} from "@/components/settings/primitives";
import { PolicyRefusal, PolicyUnavailable } from "@/components/settings/PolicyStates";
import {
  policyErrorMessage,
  usePolicyQuery,
  withPolicyMessage,
} from "@/components/settings/useLocalPolicy";
import { useRowActions } from "@/components/settings/useIntegrations";
import { ipc } from "@/lib/ipc";
import { useAppStore } from "@/store/appStore";

const ROLE_OPTIONS: { value: LocalMemberRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "editor", label: "Editor" },
  { value: "viewer", label: "Viewer" },
];

/** What each role may actually do — the same three sentences everywhere. */
const ROLE_BLURB: Record<LocalMemberRole, string> = {
  owner: "Runs turns and answers approvals, and may edit restrictions and revoke grants.",
  editor: "Runs turns and answers ordinary approvals under the current restrictions.",
  viewer: "Reads history only — cannot run a turn or approve a tool call.",
};

const ROLE_BADGE: Record<LocalMemberRole, "default" | "outline" | "warning"> = {
  owner: "default",
  editor: "outline",
  viewer: "warning",
};

export function MembersSection() {
  const members = usePolicyQuery(
    () => ipc().invoke("policy.members.list", {}),
    [],
    // Another window renaming, re-roling or deleting a profile — or a
    // reassignment that demoted one — changes this list.
    { invalidateOn: ["members", "subjects"] },
  );

  return (
    <div data-testid="settings-members" className="flex flex-col gap-6">
      {/* No heading of our own: `SettingsPage` already renders the section's
          name as the page's `<h1>`, and a second "Members" underneath it is
          the same word twice rather than a hierarchy. */}
      <IdentityBoundaryNote />

      {members.unavailable ? (
        <PolicyUnavailable
          what="Execution profiles"
          busy={members.loading}
          onRetry={() => void members.reload()}
          testId="members-unavailable"
        />
      ) : members.error ? (
        <SectionError message={members.error} />
      ) : members.loading && members.data === null ? (
        <SectionLoading />
      ) : (
        <>
          <MemberList members={members.data?.members ?? []} reload={members.reload} />
          <CreateMember reload={members.reload} />
          <SessionAssignment members={members.data?.members ?? []} />
        </>
      )}
    </div>
  );
}

/**
 * ADR-0007 is explicit that member labels must not be presented as verified
 * identities. Two sentences, said once at the top: a caveat on every row would
 * be noise, and no caveat at all would leave this looking like an access-control
 * list for people.
 */
function IdentityBoundaryNote() {
  return (
    <p
      data-testid="members-identity-note"
      className="flex items-start gap-2.5 rounded-lg border border-border-weak bg-card/50 px-3.5 py-3 text-sm text-muted-foreground"
    >
      <InfoIcon className="size-4 shrink-0 translate-y-0.5" aria-hidden />
      <span>
        A profile decides what a session is allowed to do — it is not an account, and there is
        nothing to sign in to. Its name is a label you chose, not a verified identity, and anyone
        using this Windows account can change it.
      </span>
    </p>
  );
}

function MemberList({ members, reload }: { members: LocalMember[]; reload: () => Promise<void> }) {
  const rows = useRowActions();
  /**
   * Names being typed, by profile id.
   *
   * The input was bound straight to `member.label` and saved on every
   * keystroke, which meant one request per character and — worse — a reload
   * landing mid-word replaced what was being typed with the persisted value.
   * A draft is local until it is saved, and a refused save keeps it so the
   * text is not lost.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftFor = (member: LocalMember): string => drafts[member.id] ?? member.label;
  const setDraft = (id: string, value: string) =>
    setDrafts((prev) => ({ ...prev, [id]: value }));
  const clearDraft = (id: string) =>
    setDrafts((prev) => {
      if (prev[id] === undefined) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

  async function update(member: LocalMember, patch: { label?: string; role?: LocalMemberRole }) {
    await ipc().invoke("policy.members.update", { memberId: member.id, ...patch });
    await reload();
  }

  /** Save a name only when it actually changed; drop the draft once it lands. */
  async function saveName(member: LocalMember): Promise<void> {
    const next = draftFor(member).trim();
    if (next === "" || next === member.label) {
      clearDraft(member.id);
      return;
    }
    await rows.run(
      `${member.id}:label`,
      withPolicyMessage(async () => {
        await update(member, { label: next });
        clearDraft(member.id);
      }),
    );
  }

  async function remove(member: LocalMember) {
    await ipc().invoke("policy.members.remove", { memberId: member.id });
    await reload();
  }

  if (members.length === 0) {
    return (
      <p data-testid="members-empty" className="text-sm text-muted-foreground">
        No execution profiles yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="members-list">
      {members.map((member) => (
        <SettingsCard key={member.id} testId={`member-row-${member.id}`}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={ROLE_BADGE[member.role]}>{member.role}</Badge>
                {member.builtIn ? (
                  <Badge variant="outline" data-testid={`member-builtin-${member.id}`}>
                    <ShieldIcon className="mr-1 size-3" aria-hidden />
                    built-in
                  </Badge>
                ) : null}
              </div>
              {member.builtIn ? (
                // The built-in owner is what every session with no explicit
                // choice resolves to, so renaming or demoting it would
                // retroactively change sessions nobody reassigned.
                <p className="truncate text-sm font-medium text-foreground">{member.label}</p>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={draftFor(member)}
                    disabled={rows.busy(`${member.id}:label`)}
                    onChange={(event) => setDraft(member.id, event.target.value)}
                    onBlur={() => void saveName(member)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveName(member);
                      }
                      if (event.key === "Escape") clearDraft(member.id);
                    }}
                    aria-label={`Name for ${member.label}`}
                    data-testid={`member-label-${member.id}`}
                    className="w-full max-w-xs rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-foreground-tertiary focus:border-ring disabled:opacity-50"
                  />
                  {draftFor(member).trim() !== member.label ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={rows.busy(`${member.id}:label`) || draftFor(member).trim() === ""}
                      data-testid={`member-label-save-${member.id}`}
                      // `onMouseDown`: a click on Save blurs the input first,
                      // and the blur handler would have already saved and
                      // cleared the draft before this button ever fired.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void saveName(member)}
                    >
                      Save
                    </Button>
                  ) : null}
                </div>
              )}
              <p className="text-xs text-muted-foreground">{ROLE_BLURB[member.role]}</p>
              {rows.errorFor(`${member.id}:label`) ? (
                <RowError
                  message={rows.errorFor(`${member.id}:label`) as string}
                  testId={`member-error-${member.id}`}
                />
              ) : null}
              {rows.errorFor(member.id) ? (
                <RowError
                  message={rows.errorFor(member.id) as string}
                  testId={`member-error-${member.id}`}
                />
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <SettingSelect
                value={member.role}
                disabled={member.builtIn || rows.busy(member.id)}
                onChange={(value) =>
                  void rows.run(
                    member.id,
                    withPolicyMessage(() => update(member, { role: value as LocalMemberRole })),
                  )
                }
                options={ROLE_OPTIONS}
                data-testid={`member-role-${member.id}`}
                aria-label={`Role for ${member.label}`}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={member.builtIn || rows.busy(member.id)}
                data-testid={`member-remove-${member.id}`}
                aria-label={`Delete ${member.label}`}
                onClick={() => void rows.run(member.id, withPolicyMessage(() => remove(member)))}
              >
                Delete
              </Button>
            </div>
          </div>
          {member.builtIn ? (
            <p className="text-xs text-muted-foreground" data-testid={`member-builtin-note-${member.id}`}>
              Every session that has not chosen a profile runs as this one, so it cannot be renamed,
              given another role, or deleted.
            </p>
          ) : null}
        </SettingsCard>
      ))}
    </div>
  );
}

function CreateMember({ reload }: { reload: () => Promise<void> }) {
  const rows = useRowActions();
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<LocalMemberRole>("editor");
  const trimmed = label.trim();

  async function create() {
    await rows.run("create", withPolicyMessage(async () => {
      await ipc().invoke("policy.members.create", { label: trimmed, role });
      setLabel("");
      setRole("editor");
      await reload();
    }));
  }

  return (
    <SettingsCard title="Add a profile" testId="member-create">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">Name</span>
          <SettingInput
            value={label}
            onChange={setLabel}
            placeholder="Reviewer"
            data-testid="member-create-label"
            aria-label="New profile name"
          />
        </label>
        <label className="flex flex-col gap-1 sm:w-40">
          <span className="text-xs text-muted-foreground">Role</span>
          <SettingSelect
            value={role}
            onChange={(value) => setRole(value as LocalMemberRole)}
            options={ROLE_OPTIONS}
            data-testid="member-create-role"
            aria-label="New profile role"
          />
        </label>
        <Button
          size="sm"
          disabled={trimmed === "" || rows.busy("create")}
          data-testid="member-create-submit"
          onClick={() => void create()}
        >
          Add profile
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{ROLE_BLURB[role]}</p>
      {rows.errorFor("create") ? (
        <RowError message={rows.errorFor("create") as string} testId="member-create-error" />
      ) : null}
    </SettingsCard>
  );
}

/**
 * Which profile a session runs as.
 *
 * Main owns the answer, so the control reads it back rather than assuming its
 * own write succeeded — a busy session refuses an ordinary reassignment, and a
 * read-only imported artifact refuses one outright. Demotion to viewer is the
 * one reassignment that does not wait for quiet: it interrupts, which is why
 * the note below says so before the operator picks it.
 */
function SessionAssignment({ members }: { members: LocalMember[] }) {
  const sessions = useAppStore((s) => s.sessions);
  const live = useMemo(() => sessions.filter((s) => !s.archived), [sessions]);
  const [sessionId, setSessionId] = useState<string>("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = sessionId === "" ? null : sessionId;

  const subject = usePolicyQuery(
    async () =>
      selected === null ? null : await ipc().invoke("policy.session.subject.get", { sessionId: selected }),
    [selected],
    { invalidateOn: ["subjects", "members"], sessionId: selected },
  );

  async function assign(memberId: string) {
    if (selected === null) return;
    setBusy(true);
    setRefusal(null);
    try {
      await ipc().invoke("policy.session.subject.assign", { sessionId: selected, memberId });
      await subject.reload();
    } catch (error) {
      // A refusal is a real answer, not a failure to render: the assignment did
      // not happen, so the control must not look as though it did.
      setRefusal(policyErrorMessage(error));
      await subject.reload();
    } finally {
      setBusy(false);
    }
  }

  const current = subject.data?.subject ?? null;

  return (
    <SettingsCard
      title="Session execution profile"
      subtitle="Which profile a session runs as. This is the session's execution role, not the identity of the person at the keyboard."
      testId="member-assignment"
    >
      {live.length === 0 ? (
        <p data-testid="member-assignment-empty" className="text-sm text-muted-foreground">
          No sessions yet.
        </p>
      ) : (
        <>
          <ConfigRow label="Session" testId="member-assignment-session-row">
            <SettingSelect
              value={sessionId}
              onChange={(value) => {
                setSessionId(value);
                setRefusal(null);
              }}
              options={[
                { value: "", label: "Select a session…" },
                ...live.map((s) => ({ value: s.id, label: s.title || "Untitled session" })),
              ]}
              data-testid="member-assignment-session"
              aria-label="Session to assign a profile to"
            />
          </ConfigRow>

          {selected === null ? null : subject.unavailable ? (
            <PolicyUnavailable
              what="This session's profile"
              busy={subject.loading}
              onRetry={() => void subject.reload()}
              testId="member-assignment-unavailable"
            />
          ) : subject.error ? (
            <SectionError message={subject.error} />
          ) : (
            <>
              <ConfigRow
                label="Runs as"
                description={
                  current === null
                    ? undefined
                    : current.explicit
                      ? "Chosen for this session."
                      : "No profile chosen — this session runs as the built-in owner."
                }
                testId="member-assignment-current-row"
              >
                <SettingSelect
                  value={current?.member.id ?? ""}
                  disabled={busy || subject.loading}
                  onChange={(value) => void assign(value)}
                  options={[
                    ...(current === null ? [{ value: "", label: "No usable profile" }] : []),
                    ...members.map((m) => ({ value: m.id, label: `${m.label} (${m.role})` })),
                  ]}
                  data-testid="member-assignment-member"
                  aria-label="Execution profile for this session"
                />
              </ConfigRow>

              {current === null ? (
                // ADR-0007: a missing assigned profile never silently becomes
                // the owner. It is a refusal, and the page has to show it.
                <PolicyRefusal
                  testId="member-assignment-missing"
                  message="The profile assigned to this session no longer exists, so it cannot run. Choose another one."
                />
              ) : null}

              {refusal ? <PolicyRefusal message={refusal} testId="member-assignment-refusal" /> : null}

              <p className="text-xs text-muted-foreground">
                Changing to another running profile needs the session to be idle. Changing it to a{" "}
                <span className="font-medium text-foreground">viewer</span> applies immediately and
                interrupts whatever the session is doing, denying any approval that is waiting.
              </p>
            </>
          )}
        </>
      )}
    </SettingsCard>
  );
}
