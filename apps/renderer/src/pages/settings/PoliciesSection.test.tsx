/**
 * Settings ▸ Policies (P17). The cases below are the ones where a plausible
 * page would be wrong rather than merely ugly: attribution that came from the
 * renderer instead of main, a boundary reported as enforceable when it is not,
 * a grant listing that carries what a grant matches on, an empty list standing
 * in for an unreachable service, and a refusal shown as a success.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSchema, SessionSchema, type Agent, type LocalPolicyRule, type Session } from "@capygen/shared";
import { useAppStore } from "@/store/appStore";
import { boundedRuleId, PoliciesSection } from "./PoliciesSection";

const invoke = vi.hoisted(() => vi.fn());
const shell = vi.hoisted(() => ({ bridge: true }));
vi.mock("@/lib/ipc", () => ({
  ipc: () => ({ invoke, on: () => () => {} }),
  hasBridge: () => shell.bridge,
}));

const RULE: LocalPolicyRule = {
  id: "lpr_1", scope: { kind: "global" }, boundary: "api-tool",
  pattern: "mcp__docs__*", decision: "deny", enabled: true, createdAt: 0, updatedAt: 0,
};

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

const agent = (over: Partial<Agent> = {}): Agent =>
  AgentSchema.parse({
    id: "agt_1", sessionId: "ses_1", name: "Assistant", displayName: "Assistant",
    mentionName: "assistant", backend: "api", model: "claude-opus-5", role: "member",
    createdAt: 0, ...over,
  });

const AVAILABILITY = {
  sessionId: "ses_1",
  agentId: "agt_1",
  backend: "api",
  boundaries: [
    { boundary: "api-tool", available: true, reason: null },
    { boundary: "codex-command-approval", available: false, reason: "unsupported-backend" },
  ],
};

function setStore(over: { sessions?: Session[]; agents?: Agent[]; projectId?: string | null } = {}) {
  useAppStore.setState({
    sessions: over.sessions ?? [],
    agents: over.agents ?? [],
    projects: [],
    selectedProjectId: over.projectId ?? null,
  });
}

beforeEach(() => {
  shell.bridge = true;
  setStore();
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === "policy.rules.list") return Promise.resolve({ rules: [RULE] });
    if (channel === "policy.rules.create") return Promise.resolve({ rule: RULE });
    if (channel === "policy.rules.update") return Promise.resolve({ rule: RULE });
    if (channel === "policy.rules.remove") return Promise.resolve({ removed: true });
    if (channel === "policy.grants.list") return Promise.resolve({ grants: [] });
    if (channel === "policy.grants.revoke") return Promise.resolve({ revoked: true });
    if (channel === "policy.audit.list") {
      return Promise.resolve({ records: [], nextCursor: null, truncated: false });
    }
    if (channel === "policy.boundaries.availability") return Promise.resolve(AVAILABILITY);
    if (channel === "agents.list") return Promise.resolve([agent()]);
    return Promise.resolve({});
  });
});

/** The section reads `?rule=` now, so every case mounts inside a router. */
function renderPolicies(initialEntry = "/settings/policies") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PoliciesSection />
    </MemoryRouter>,
  );
}

const openTab = async (user: ReturnType<typeof userEvent.setup>, tab: string) =>
  user.click(await screen.findByTestId(`policies-tab-${tab}`));

describe("PoliciesSection ▸ restrictions", () => {
  it("says the backend's own configuration stays authoritative", async () => {
    renderPolicies();
    expect(await screen.findByTestId("policies-authority-note")).toHaveTextContent(
      /never authorize one the backend denies/i,
    );
  });

  it("lists a rule with its scope, boundary, decision and enabled state", async () => {
    renderPolicies();
    const row = await screen.findByTestId(`rule-row-${RULE.id}`);
    expect(row).toHaveTextContent("mcp__docs__*");
    expect(row).toHaveTextContent("Global");
    expect(row).toHaveTextContent("API tool call");
    expect(within(row).getByTestId(`rule-decision-${RULE.id}`)).toHaveValue("deny");
    expect(within(row).getByTestId(`rule-enabled-${RULE.id}`)).toHaveAttribute("aria-checked", "true");
  });

  it("creates a global rule with the exact scope object the contract wants", async () => {
    const user = userEvent.setup();
    renderPolicies();
    await screen.findByTestId("rule-create");

    await user.selectOptions(screen.getByTestId("rule-create-boundary"), "claude-pre-tool");
    await user.selectOptions(screen.getByTestId("rule-create-decision"), "ask");
    await user.type(screen.getByTestId("rule-create-pattern"), "  Bash  ");
    await user.click(screen.getByTestId("rule-create-submit"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.rules.create", {
        scope: { kind: "global" },
        boundary: "claude-pre-tool",
        pattern: "Bash",
        decision: "ask",
        enabled: true,
      }),
    );
  });

  it("offers a scope only when this window can supply its id", async () => {
    renderPolicies();
    const scope = await screen.findByTestId("rule-create-scope");
    // No project selected and no sessions: global is the only honest option.
    expect(within(scope).queryByRole("option", { name: /Project/ })).toBeNull();
    expect(within(scope).queryByRole("option", { name: /Session/ })).toBeNull();

    setStore({ projectId: "prj_1", sessions: [session()] });
    await waitFor(() =>
      expect(within(screen.getByTestId("rule-create-scope")).getByRole("option", { name: /Project/ }))
        .toBeInTheDocument(),
    );
  });

  it("sends a session-scoped rule with the session it names", async () => {
    const user = userEvent.setup();
    setStore({ sessions: [session()] });
    renderPolicies();
    await screen.findByTestId("rule-create");

    await user.selectOptions(screen.getByTestId("rule-create-scope"), "session");
    await user.selectOptions(await screen.findByTestId("rule-create-session"), "ses_1");
    await user.type(screen.getByTestId("rule-create-pattern"), "Write");
    await user.click(screen.getByTestId("rule-create-submit"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "policy.rules.create",
        expect.objectContaining({ scope: { kind: "session", sessionId: "ses_1" } }),
      ),
    );
  });

  it("toggles and deletes through the contract, re-reading the list", async () => {
    const user = userEvent.setup();
    renderPolicies();
    await user.click(await screen.findByTestId(`rule-enabled-${RULE.id}`));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.rules.update", { ruleId: RULE.id, enabled: false }),
    );
    await user.click(screen.getByTestId(`rule-remove-${RULE.id}`));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.rules.remove", { ruleId: RULE.id }),
    );
  });

  it("shows an invalid pattern's refusal in words, not as the wire code", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: [] });
      if (channel === "policy.rules.create") return refusal("invalid-request");
      return Promise.resolve({});
    });
    renderPolicies();
    await user.type(await screen.findByTestId("rule-create-pattern"), "tool(args)");
    await user.click(screen.getByTestId("rule-create-submit"));

    const error = await screen.findByTestId("rule-create-error");
    expect(error).toHaveTextContent(/was not valid/i);
    expect(error).not.toHaveTextContent(/local policy request refused/i);
    // The refusal never echoes what was typed.
    expect(error).not.toHaveTextContent("tool(args)");
  });

  it("distinguishes an unreachable service from an empty rule list", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation(() => refusal("unavailable"));
    renderPolicies();

    expect(await screen.findByTestId("rules-unavailable")).toHaveTextContent(/not an empty list/i);
    expect(screen.queryByTestId("rules-empty")).toBeNull();

    invoke.mockImplementation(() => Promise.resolve({ rules: [RULE] }));
    await user.click(screen.getByTestId("rules-unavailable-retry"));
    expect(await screen.findByTestId(`rule-row-${RULE.id}`)).toBeInTheDocument();
  });
});

describe("PoliciesSection ▸ preview", () => {
  it("asks main for the attribution instead of matching in the renderer", async () => {
    const user = userEvent.setup();
    setStore({ sessions: [session()], agents: [agent()] });
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: [RULE] });
      if (channel === "policy.boundaries.availability") return Promise.resolve(AVAILABILITY);
      if (channel === "agents.list") return Promise.resolve([agent()]);
      if (channel === "policy.rules.preview") {
        return Promise.resolve({
          decision: "deny", source: "rule", ruleId: RULE.id, scopeKind: "global",
          scopeId: null, matchedRuleIds: [RULE.id, "lpr_2"], boundaryAvailable: true,
        });
      }
      return Promise.resolve({});
    });
    renderPolicies();
    await openTab(user, "preview");

    await user.selectOptions(await screen.findByTestId("preview-session"), "ses_1");
    await user.type(screen.getByTestId("preview-tool"), "mcp__docs__search");
    await user.click(screen.getByTestId("preview-run"));

    // The agent is part of the question, never averaged away.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.rules.preview", {
        sessionId: "ses_1", agentId: "agt_1", boundary: "api-tool", toolName: "mcp__docs__search",
      }),
    );
    expect(await screen.findByTestId("preview-decision")).toHaveTextContent("deny");
    expect(screen.getByTestId("preview-source-rule")).toHaveTextContent(RULE.id);
    expect(screen.getByTestId("preview-source-rule")).toHaveTextContent(/strongest of 2/i);
  });

  it("says a call with no matching restriction falls to the backend, not to 'allowed'", async () => {
    const user = userEvent.setup();
    setStore({ sessions: [session()], agents: [agent()] });
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: [] });
      if (channel === "policy.boundaries.availability") return Promise.resolve(AVAILABILITY);
      if (channel === "agents.list") return Promise.resolve([agent()]);
      if (channel === "policy.rules.preview") {
        return Promise.resolve({
          decision: "allow", source: "default", ruleId: null, scopeKind: null,
          scopeId: null, matchedRuleIds: [], boundaryAvailable: true,
        });
      }
      return Promise.resolve({});
    });
    renderPolicies();
    await openTab(user, "preview");
    await user.selectOptions(await screen.findByTestId("preview-session"), "ses_1");
    await user.type(screen.getByTestId("preview-tool"), "Bash");
    await user.click(screen.getByTestId("preview-run"));

    expect(await screen.findByTestId("preview-source-default")).toHaveTextContent(
      /backend's own permissions decide/i,
    );
  });

  it("reports this agent's unavailable boundaries with the reason main gave", async () => {
    const user = userEvent.setup();
    setStore({ sessions: [session()], agents: [agent()] });
    renderPolicies();
    await openTab(user, "preview");
    await user.selectOptions(await screen.findByTestId("preview-session"), "ses_1");

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.boundaries.availability", {
        sessionId: "ses_1", agentId: "agt_1",
      }),
    );
    const unavailable = await screen.findByTestId("availability-codex-command-approval");
    expect(unavailable).toHaveTextContent(/unavailable/i);
    expect(unavailable).toHaveTextContent(/no such interception point/i);
    expect(screen.getByTestId("availability-api-tool")).toHaveTextContent(/available/i);
  });

  it("warns when the previewed boundary is one this agent cannot enforce", async () => {
    const user = userEvent.setup();
    setStore({ sessions: [session()], agents: [agent()] });
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: [] });
      if (channel === "policy.boundaries.availability") return Promise.resolve(AVAILABILITY);
      if (channel === "agents.list") return Promise.resolve([agent()]);
      if (channel === "policy.rules.preview") {
        return Promise.resolve({
          decision: "deny", source: "rule", ruleId: "lpr_9", scopeKind: "global",
          scopeId: null, matchedRuleIds: ["lpr_9"], boundaryAvailable: false,
        });
      }
      return Promise.resolve({});
    });
    renderPolicies();
    await openTab(user, "preview");
    await user.selectOptions(await screen.findByTestId("preview-session"), "ses_1");
    await user.selectOptions(screen.getByTestId("preview-boundary"), "codex-command-approval");
    await user.type(screen.getByTestId("preview-tool"), "shell");
    await user.click(screen.getByTestId("preview-run"));

    expect(await screen.findByTestId("preview-boundary-unavailable")).toHaveTextContent(
      /cannot enforce that point/i,
    );
  });

  it("shows a refused preview as a refusal, never as a decision", async () => {
    const user = userEvent.setup();
    setStore({ sessions: [session()], agents: [agent()] });
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: [] });
      if (channel === "policy.boundaries.availability") return Promise.resolve(AVAILABILITY);
      if (channel === "agents.list") return Promise.resolve([agent()]);
      if (channel === "policy.rules.preview") return refusal("unknown-session");
      return Promise.resolve({});
    });
    renderPolicies();
    await openTab(user, "preview");
    await user.selectOptions(await screen.findByTestId("preview-session"), "ses_1");
    await user.type(screen.getByTestId("preview-tool"), "Bash");
    await user.click(screen.getByTestId("preview-run"));

    expect(await screen.findByTestId("preview-refusal")).toHaveTextContent(/no longer exists/i);
    expect(screen.queryByTestId("preview-result")).toBeNull();
  });

  it("says there is nothing to preview against with no sessions", async () => {
    const user = userEvent.setup();
    renderPolicies();
    await openTab(user, "preview");
    expect(await screen.findByTestId("preview-empty")).toHaveTextContent(/No sessions yet/i);
  });
});

describe("PoliciesSection ▸ grants and activity", () => {
  it("lists a grant without what it matches on, and revokes by its opaque id", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: [] });
      if (channel === "policy.grants.list") {
        return Promise.resolve({
          grants: [
            {
              grantId: "grt_1", sessionId: "ses_1", agentId: "agt_1", backend: "api",
              boundary: "api-tool", toolName: "mcp__docs__search", grantedAt: 10,
            },
          ],
        });
      }
      if (channel === "policy.grants.revoke") return Promise.resolve({ revoked: true });
      return Promise.resolve({});
    });
    renderPolicies();
    await openTab(user, "grants");

    const row = await screen.findByTestId("grant-row-grt_1");
    expect(row).toHaveTextContent("mcp__docs__search");
    const panel = screen.getByTestId("policies-grants");
    // Nothing a grant matches on is on screen, and the page says why.
    expect(panel.textContent ?? "").not.toMatch(/C:\\|cwd|lifecycle|token|signature/i);
    expect(panel).toHaveTextContent(/deliberately not shown or stored here/i);

    await user.click(within(row).getByTestId("grant-revoke-grt_1"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.grants.revoke", { grantId: "grt_1" }),
    );
  });

  it("says a grant never outlives a restart, and points at a restriction for a permanent allow", async () => {
    const user = userEvent.setup();
    renderPolicies();
    await openTab(user, "grants");
    const panel = await screen.findByTestId("policies-grants");
    expect(panel).toHaveTextContent(/none of them outlives a restart/i);
    expect(panel).toHaveTextContent(/add an allow restriction instead/i);
  });

  it("pages the bounded activity window forward and back", async () => {
    const user = userEvent.setup();
    const record = (id: string) => ({
      id, ts: 1, requestId: null, sessionId: "ses_1", agentId: null, backend: "api",
      boundary: "api-tool", boundaryAvailable: true, toolName: `tool_${id}`, decision: "deny",
      source: "rule", ruleId: RULE.id, scopeKind: "global", scopeId: null,
      memberId: "mbr_builtin_owner", memberLabel: "Owner", memberRole: "owner",
    });
    invoke.mockImplementation((channel: string, args: { cursor?: string }) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: [] });
      if (channel === "policy.audit.list") {
        return args?.cursor === "lpa_1"
          ? Promise.resolve({ records: [record("lpa_2")], nextCursor: null, truncated: true })
          : Promise.resolve({ records: [record("lpa_1")], nextCursor: "lpa_1", truncated: true });
      }
      return Promise.resolve({});
    });
    renderPolicies();
    await openTab(user, "activity");

    expect(await screen.findByTestId("audit-row-lpa_1")).toHaveTextContent("tool_lpa_1");
    expect(screen.getByTestId("audit-prev")).toBeDisabled();

    await user.click(screen.getByTestId("audit-next"));
    expect(await screen.findByTestId("audit-row-lpa_2")).toBeInTheDocument();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.audit.list", { limit: 25, cursor: "lpa_1" }),
    );
    expect(screen.getByTestId("audit-next")).toBeDisabled();
    expect(screen.getByTestId("audit-truncated")).toBeInTheDocument();

    await user.click(screen.getByTestId("audit-prev"));
    expect(await screen.findByTestId("audit-row-lpa_1")).toBeInTheDocument();
  });

  it("keeps tool arguments out of the activity table", async () => {
    const user = userEvent.setup();
    renderPolicies();
    await openTab(user, "activity");
    const panel = await screen.findByTestId("policies-activity");
    expect(panel).toHaveTextContent(/never recorded/i);
    expect(screen.getByTestId("audit-empty")).toBeInTheDocument();
  });
});

describe("PoliciesSection ▸ scope identity and editing", () => {
  const RULES: LocalPolicyRule[] = [
    RULE,
    { ...RULE, id: "lpr_p", scope: { kind: "project", projectId: "prj_1" }, pattern: "Bash" },
    { ...RULE, id: "lpr_s", scope: { kind: "session", sessionId: "ses_1" }, pattern: "Write" },
    { ...RULE, id: "lpr_gone", scope: { kind: "project", projectId: "prj_unknown" }, pattern: "Read" },
  ];

  beforeEach(() => {
    setStore({
      sessions: [session()],
      projectId: "prj_1",
    });
    useAppStore.setState({
      projects: [
        { id: "prj_1", name: "capygen", path: "C:/dev/capygen", layout: null, devServers: null, createdAt: 0, updatedAt: 0 },
      ],
    });
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: RULES });
      if (channel === "policy.rules.update") return Promise.resolve({ rule: RULE });
      return Promise.resolve({});
    });
  });

  it("names the project or session a rule is scoped to, falling back to its id", async () => {
    renderPolicies();
    expect(await screen.findByTestId("rule-scope-detail-lpr_p")).toHaveTextContent("capygen");
    expect(screen.getByTestId("rule-scope-detail-lpr_s")).toHaveTextContent("Alpha run");
    expect(screen.getByTestId("rule-scope-detail-lpr_1")).toHaveTextContent("every session");
    // A scope this window cannot name is still identified, by its id.
    expect(screen.getByTestId("rule-scope-detail-lpr_gone")).toHaveTextContent("prj_unknown");
  });

  it("edits a rule's pattern, boundary and scope, not only its decision", async () => {
    const user = userEvent.setup();
    renderPolicies();
    await user.click(await screen.findByTestId("rule-edit-lpr_1"));

    const editor = await screen.findByTestId("rule-editor-lpr_1");
    // Seeded from the rule it is editing.
    expect(within(editor).getByTestId("rule-edit-pattern")).toHaveValue("mcp__docs__*");
    expect(within(editor).getByTestId("rule-edit-boundary")).toHaveValue("api-tool");
    expect(within(editor).getByTestId("rule-edit-scope")).toHaveValue("global");

    await user.clear(within(editor).getByTestId("rule-edit-pattern"));
    await user.type(within(editor).getByTestId("rule-edit-pattern"), "mcp__docs__search");
    await user.selectOptions(within(editor).getByTestId("rule-edit-boundary"), "claude-pre-tool");
    await user.selectOptions(within(editor).getByTestId("rule-edit-scope"), "project");
    await user.click(within(editor).getByTestId("rule-edit-submit"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("policy.rules.update", {
        ruleId: "lpr_1",
        scope: { kind: "project", projectId: "prj_1" },
        boundary: "claude-pre-tool",
        pattern: "mcp__docs__search",
        decision: "deny",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("rule-editor-lpr_1")).toBeNull());
  });

  it("keeps a rule's own project selectable even when the window is elsewhere", async () => {
    const user = userEvent.setup();
    renderPolicies();
    await user.click(await screen.findByTestId("rule-edit-lpr_gone"));
    const editor = await screen.findByTestId("rule-editor-lpr_gone");
    // Opening the editor must not silently re-home the rule on this window's
    // project; its own project is what the scope option carries.
    await user.click(within(editor).getByTestId("rule-edit-submit"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "policy.rules.update",
        expect.objectContaining({ scope: { kind: "project", projectId: "prj_unknown" } }),
      ),
    );
  });

  it("cancels an edit without writing anything", async () => {
    const user = userEvent.setup();
    renderPolicies();
    await user.click(await screen.findByTestId("rule-edit-lpr_1"));
    await user.click(within(await screen.findByTestId("rule-editor-lpr_1")).getByTestId("rule-edit-cancel"));
    expect(screen.queryByTestId("rule-editor-lpr_1")).toBeNull();
    expect(invoke.mock.calls.some((c) => c[0] === "policy.rules.update")).toBe(false);
  });

  it("opens the owning rule's editor from a preview result", async () => {
    const user = userEvent.setup();
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: RULES });
      if (channel === "agents.list") return Promise.resolve([agent()]);
      if (channel === "policy.boundaries.availability") return Promise.resolve(AVAILABILITY);
      if (channel === "policy.rules.preview") {
        return Promise.resolve({
          decision: "deny", source: "rule", ruleId: "lpr_s", scopeKind: "session",
          scopeId: "ses_1", matchedRuleIds: ["lpr_s"], boundaryAvailable: true,
        });
      }
      return Promise.resolve({});
    });
    renderPolicies();
    await openTab(user, "preview");
    await user.selectOptions(await screen.findByTestId("preview-session"), "ses_1");
    await user.type(screen.getByTestId("preview-tool"), "Write");
    await user.click(screen.getByTestId("preview-run"));

    await user.click(await screen.findByTestId("preview-edit-rule"));
    // Back on Restrictions, with that rule's editor already open (ADR-0007:
    // an exception is made by editing the owning restriction).
    expect(await screen.findByTestId("rule-editor-lpr_s")).toBeInTheDocument();
    expect(screen.getByTestId("policies-tab-rules")).toHaveAttribute("aria-selected", "true");
  });
});

describe("PoliciesSection ▸ a result belongs to the question it answered", () => {
  const deferredPreview = () => {
    const gate: { release: ((value: unknown) => void) | null } = { release: null };
    invoke.mockImplementation((channel: string, args: { sessionId?: string }) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: [RULE] });
      if (channel === "agents.list") {
        return Promise.resolve(
          args?.sessionId === "ses_2"
            ? [agent({ id: "agt_2", sessionId: "ses_2", displayName: "Second" })]
            : [agent()],
        );
      }
      if (channel === "policy.boundaries.availability") {
        return Promise.resolve(
          args?.sessionId === "ses_2"
            ? { ...AVAILABILITY, sessionId: "ses_2", agentId: "agt_2", backend: "codex",
                boundaries: [{ boundary: "codex-dynamic-tool", available: true, reason: null }] }
            : AVAILABILITY,
        );
      }
      if (channel === "policy.rules.preview") {
        return new Promise((resolve) => {
          gate.release = () =>
            resolve({
              decision: "deny", source: "rule", ruleId: RULE.id, scopeKind: "global",
              scopeId: null, matchedRuleIds: [RULE.id], boundaryAvailable: true,
            });
        });
      }
      return Promise.resolve({});
    });
    return gate;
  };

  beforeEach(() => {
    setStore({ sessions: [session(), session({ id: "ses_2", title: "Other run" })] });
  });

  it("drops a result that lands after the session changed", async () => {
    const user = userEvent.setup();
    const gate = deferredPreview();
    renderPolicies();
    await openTab(user, "preview");
    await user.selectOptions(await screen.findByTestId("preview-session"), "ses_1");
    await user.type(screen.getByTestId("preview-tool"), "mcp__docs__search");
    await user.click(screen.getByTestId("preview-run"));

    // Switch while the answer is still in flight, then let it land.
    await user.selectOptions(screen.getByTestId("preview-session"), "ses_2");
    gate.release?.(null);
    await waitFor(() => expect(screen.getByTestId("preview-agent")).toHaveValue("agt_2"));
    expect(screen.queryByTestId("preview-result")).toBeNull();
  });

  it("admits only one check at a time, so answers cannot overtake each other", async () => {
    const user = userEvent.setup();
    const gate = deferredPreview();
    renderPolicies();
    await openTab(user, "preview");
    await user.selectOptions(await screen.findByTestId("preview-session"), "ses_1");
    await user.type(screen.getByTestId("preview-tool"), "mcp__docs__search");

    await user.click(screen.getByTestId("preview-run"));
    // Disabled while in flight: this is what keeps two answers to the *same*
    // question from racing, and why the request ticket only has to defend
    // against answers to a question that has since changed.
    expect(screen.getByTestId("preview-run")).toBeDisabled();
    gate.release?.(null);
    await waitFor(() => expect(screen.getByTestId("preview-run")).not.toBeDisabled());
  });

  it("stops showing a result once the tool name is edited", async () => {
    const user = userEvent.setup();
    const gate = deferredPreview();
    renderPolicies();
    await openTab(user, "preview");
    await user.selectOptions(await screen.findByTestId("preview-session"), "ses_1");
    await user.type(screen.getByTestId("preview-tool"), "mcp__docs__search");
    await user.click(screen.getByTestId("preview-run"));
    gate.release?.(null);
    expect(await screen.findByTestId("preview-result")).toBeInTheDocument();

    // One more character and the answer is about a different call.
    await user.type(screen.getByTestId("preview-tool"), "x");
    expect(screen.queryByTestId("preview-result")).toBeNull();
  });

  it("stops showing a result once the boundary is changed", async () => {
    const user = userEvent.setup();
    const gate = deferredPreview();
    renderPolicies();
    await openTab(user, "preview");
    await user.selectOptions(await screen.findByTestId("preview-session"), "ses_1");
    await user.type(screen.getByTestId("preview-tool"), "mcp__docs__search");
    await user.click(screen.getByTestId("preview-run"));
    gate.release?.(null);
    expect(await screen.findByTestId("preview-result")).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId("preview-boundary"), "codex-dynamic-tool");
    expect(screen.queryByTestId("preview-result")).toBeNull();
  });

  it("never shows one session's enforcement points under another's label", async () => {
    const user = userEvent.setup();
    const gate: { release: (() => void) | null } = { release: null };
    invoke.mockImplementation((channel: string, args: { sessionId?: string }) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: [] });
      if (channel === "agents.list") {
        return Promise.resolve(
          args?.sessionId === "ses_2"
            ? [agent({ id: "agt_2", sessionId: "ses_2", displayName: "Second" })]
            : [agent()],
        );
      }
      if (channel === "policy.boundaries.availability") {
        if (args?.sessionId === "ses_2") {
          // The second session's answer is slow; the first must not stand in.
          return new Promise((resolve) => {
            gate.release = () =>
              resolve({
                sessionId: "ses_2", agentId: "agt_2", backend: "codex",
                boundaries: [{ boundary: "codex-dynamic-tool", available: true, reason: null }],
              });
          });
        }
        return Promise.resolve(AVAILABILITY);
      }
      return Promise.resolve({});
    });
    renderPolicies();
    await openTab(user, "preview");
    await user.selectOptions(await screen.findByTestId("preview-session"), "ses_1");
    expect(await screen.findByTestId("availability-api-tool")).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId("preview-session"), "ses_2");
    await waitFor(() => expect(screen.queryByTestId("availability-api-tool")).toBeNull());
    expect(screen.queryByTestId("preview-availability")).toBeNull();

    gate.release?.();
    expect(await screen.findByTestId("availability-codex-dynamic-tool")).toBeInTheDocument();
  });
});

describe("PoliciesSection ▸ arriving from a refusal", () => {
  it("opens the editor for the rule the link named", async () => {
    renderPolicies(`/settings/policies?rule=${RULE.id}`);
    // The id is resolved against the rules this page read; it is never used as
    // a selector or a query of any kind.
    expect(await screen.findByTestId(`rule-editor-${RULE.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId("rule-missing")).toBeNull();
  });

  it("says the restriction is gone rather than opening nothing", async () => {
    renderPolicies("/settings/policies?rule=lpr_deleted");
    // The rule that raised the card may have been deleted since; silently
    // ignoring the link would leave the operator hunting for it.
    expect(await screen.findByTestId("rule-missing")).toHaveTextContent(/no longer exists/i);
    expect(screen.queryByTestId("rule-editor-lpr_deleted")).toBeNull();
    // The rest of the page still works.
    expect(screen.getByTestId(`rule-row-${RULE.id}`)).toBeInTheDocument();
  });

  it("waits for the first read before calling a rule missing", async () => {
    const gate: { release: ((value: unknown) => void) | null } = { release: null };
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.rules.list") {
        return new Promise((resolve) => { gate.release = resolve; });
      }
      return Promise.resolve({});
    });
    renderPolicies(`/settings/policies?rule=${RULE.id}`);
    // "Not in an empty list" is not "deleted".
    expect(screen.queryByTestId("rule-missing")).toBeNull();
    gate.release?.({ rules: [RULE] });
    expect(await screen.findByTestId(`rule-editor-${RULE.id}`)).toBeInTheDocument();
  });

  it("ignores a rule parameter that is not a plausible id", async () => {
    renderPolicies("/settings/policies?rule=" + encodeURIComponent("../../etc/passwd"));
    await screen.findByTestId(`rule-row-${RULE.id}`);
    // Bounded before use: nothing opens, and nothing is reported missing for a
    // value that could never have been a rule id.
    expect(screen.queryByTestId("rule-missing")).toBeNull();
    expect(screen.queryByTestId(`rule-editor-${RULE.id}`)).toBeNull();
  });

  it("does not reopen the editor after the operator closes it", async () => {
    const user = userEvent.setup();
    renderPolicies(`/settings/policies?rule=${RULE.id}`);
    const editor = await screen.findByTestId(`rule-editor-${RULE.id}`);
    await user.click(within(editor).getByTestId("rule-edit-cancel"));
    // The parameter is consumed, so a re-render does not spring it open again.
    await waitFor(() => expect(screen.queryByTestId(`rule-editor-${RULE.id}`)).toBeNull());
  });
});

describe("boundedRuleId", () => {
  it("accepts a plausible id and refuses anything else", () => {
    expect(boundedRuleId("lpr_1")).toBe("lpr_1");
    expect(boundedRuleId("  lpr_1  ")).toBe("lpr_1");
    for (const bad of [null, "", "   ", "a".repeat(257), "../etc", "a b", "a/b", "<script>", "a'b"]) {
      expect(boundedRuleId(bad)).toBeNull();
    }
  });
});

describe("PoliciesSection ▸ Activity names where a call ran", () => {
  const record = (over: Record<string, unknown> = {}) => ({
    id: "lpa_1", ts: 1, requestId: null, sessionId: "ses_1", agentId: null,
    backend: "api", boundary: "api-tool", boundaryAvailable: true,
    toolName: "mcp__docs__search", decision: "deny", source: "rule",
    ruleId: RULE.id, scopeKind: "global", scopeId: null,
    memberId: "mbr_builtin_owner", memberLabel: "Owner", memberRole: "owner",
    executionSite: "backend", ...over,
  });

  const withRecords = (records: Record<string, unknown>[]) => {
    invoke.mockImplementation((channel: string) => {
      if (channel === "policy.rules.list") return Promise.resolve({ rules: [] });
      if (channel === "policy.audit.list") {
        return Promise.resolve({ records, nextCursor: null, truncated: false });
      }
      return Promise.resolve({});
    });
  };

  it.each([
    ["backend", "backend"],
    ["widget-host", "widget host"],
    ["unknown", "not recorded"],
  ] as const)("labels %s distinctly", async (site, label) => {
    const user = userEvent.setup();
    withRecords([record({ executionSite: site })]);
    renderPolicies();
    await openTab(user, "activity");
    expect(await screen.findByTestId("audit-row-lpa_1")).toHaveTextContent(label);
  });

  it("keeps the origin backend and boundary alongside where it ran", async () => {
    const user = userEvent.setup();
    withRecords([record({ executionSite: "widget-host", backend: "claude", boundary: "claude-pre-tool" })]);
    renderPolicies();
    await openTab(user, "activity");
    const row = await screen.findByTestId("audit-row-lpa_1");
    // The widget host ran it, but the request still originated on Claude's
    // pre-tool boundary — attribution must not be replaced by execution site.
    expect(row).toHaveTextContent("widget host");
    expect(within(row).getByTitle("claude · claude-pre-tool")).toBeInTheDocument();
  });

  it("does not report an unrecorded site as the backend", async () => {
    const user = userEvent.setup();
    withRecords([record({ executionSite: "unknown" })]);
    renderPolicies();
    await openTab(user, "activity");
    const row = await screen.findByTestId("audit-row-lpa_1");
    expect(row).toHaveTextContent("not recorded");
    // Older rows cannot say where they ran; claiming "backend" would invent it.
    expect(row.textContent).not.toMatch(/\bbackend\b/);
  });
});
